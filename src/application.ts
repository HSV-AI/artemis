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
}

export class ArtemisApplication {
  private readonly logger: Logger;
  private readonly repository: ArtemisRepository;
  private readonly pi: PiGateway;
  private readonly discord: DiscordGateway;

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
        this.discordMembership(discordClient)
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
    } catch (error: unknown) {
      this.logger.error("artemis_start_failed", safeError(error));
      throw error;
    }
  }

  public stop(): void {
    this.discord.stop();
    this.logger.info("artemis_stopped");
    this.repository.close();
  }
}
