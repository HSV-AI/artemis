import {
  Client,
  GatewayIntentBits,
  Partials
} from "discord.js";
import type { ArtemisConfig } from "./config.js";
import { ConversationService } from "./conversation-service.js";
import { DiscordGateway } from "./discord-gateway.js";
import type { ChannelMembershipChecker, Logger, PiGateway } from "./domain.js";
import { JsonLogger, safeError } from "./logger.js";
import { PiSdkGateway } from "./pi-gateway.js";
import { ArtemisRepository } from "./repository.js";
import {
  resolveChannelMembership,
  type ChannelMembershipEndpoint
} from "./scheduler-authorization.js";
import { SchedulerRunner } from "./scheduler-runner.js";

/**
 * Build the Discord gateway client Artemis shares between the Discord gateway
 * and the scheduler membership checker: the checker needs live Discord state
 * (guild membership, channel permissions, DM recipients) to authorize
 * scheduled prompts for the conversations users are actually in.
 */
function createSharedDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
  });
}

export interface ApplicationDependencies {
  logger?: Logger;
  repository?: ArtemisRepository;
  pi?: PiGateway;
  discord?: DiscordGateway;
  discordClient?: Client;
  scheduler?: Pick<SchedulerRunner, "start" | "stop" | "runScheduledTaskNow">;
}

export class ArtemisApplication {
  private readonly logger: Logger;
  private readonly repository: ArtemisRepository;
  private readonly pi: PiGateway;
  private readonly discord: DiscordGateway;
  private readonly scheduler: Pick<SchedulerRunner, "start" | "stop" | "runScheduledTaskNow">;

  public constructor(
    private readonly config: ArtemisConfig,
    dependencies: ApplicationDependencies = {}
  ) {
    this.repository = dependencies.repository ?? new ArtemisRepository(config.sqlitePath);
    this.logger =
      dependencies.logger ??
      new JsonLogger(config.logLevel, console.log, (entry) => this.repository.recordLog(entry));
    const discordClient = dependencies.discordClient ?? createSharedDiscordClient();
    this.pi = dependencies.pi ??
      new PiSdkGateway(
        config,
        this.repository,
        fetch,
        this.logger,
        this.repository,
        this.repository,
        // Scheduler authorization runs against the same live Discord state the
        // gateway itself uses, so the harness answer is always authoritative.
        this.discordMembership(discordClient),
        // The scheduler execution engine is built below, after this gateway;
        // the lazy handle resolves once it exists, giving run_scheduled_task
        // the same immediate-run executor that fires due occurrences.
        () => this.scheduler
      );
    const conversations = new ConversationService(
      {
        channelIds: config.discordAllowedChannelIds,
        userIds: config.discordUserIds,
        model: config.model.modelId
      },
      this.repository,
      this.pi,
      this.logger,
      undefined,
      this.discordMembership(discordClient)
    );
    this.discord =
      dependencies.discord ??
      new DiscordGateway(
        {
          token: config.discordToken,
          channelIds: config.discordAllowedChannelIds,
          userIds: config.discordUserIds,
          suppressEmbeds: config.discordSuppressEmbeds,
          embedsAllowedChannelIds: config.discordEmbedsAllowedChannelIds,
          onBotIdentity: (name) => this.pi.setBotDisplayName(name)
        },
        conversations,
        this.logger,
        dependencies.discordClient ?? discordClient
      );
    this.scheduler = dependencies.scheduler ??
      new SchedulerRunner({
        repository: this.repository,
        conversations,
        dispatcher: this.discord,
        logger: this.logger,
        // Scheduled prompts only fire once the Discord gate is ready: firing
        // into a client that cannot yet resolve channels would consume the
        // job's one delivery attempt without posting anything.
        ready: () => this.discord.isDiscordReady()
      });
  }

  private discordMembership(client: Client): ChannelMembershipChecker {
    return {
      isChannelMember: (conversationKey, userId) => {
        const endpoint: ChannelMembershipEndpoint = {
          fetchChannel: async (channelId) => client.channels.fetch(channelId),
          fetchGuild: async (guildId) => client.guilds.fetch(guildId)
        };
        return resolveChannelMembership(endpoint, conversationKey, userId);
      }
    };
  }

  public async start(): Promise<void> {
    this.logger.info("artemis_starting", {
      channelIds: this.config.discordAllowedChannelIds,
      model: this.config.model.modelId,
      provider: this.config.model.providerId,
      personaProfile: this.config.persona.id
    });
    try {
      await this.pi.checkHealth();
      await this.discord.start();
      this.scheduler.start();
    } catch (error: unknown) {
      this.logger.error("artemis_start_failed", safeError(error));
      throw error;
    }
  }

  public stop(): void {
    this.scheduler.stop();
    this.discord.stop();
    this.logger.info("artemis_stopped");
    this.repository.close();
  }
}
