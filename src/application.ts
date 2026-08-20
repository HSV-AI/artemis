import type { ArtemisConfig } from "./config.js";
import { ConversationService } from "./conversation-service.js";
import { DiscordGateway } from "./discord-gateway.js";
import type { Logger, PiGateway } from "./domain.js";
import { JsonLogger, safeError } from "./logger.js";
import { PiSdkGateway } from "./pi-gateway.js";
import { ArtemisRepository } from "./repository.js";

export interface ApplicationDependencies {
  logger?: Logger;
  repository?: ArtemisRepository;
  pi?: PiGateway;
  discord?: DiscordGateway;
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
    this.pi = dependencies.pi ?? new PiSdkGateway(config);
    const conversations = new ConversationService(
      {
        guildId: config.discordGuildId,
        authorizedUserId: config.authorizedUserId,
        model: config.ollamaModel
      },
      this.repository,
      this.pi,
      this.logger
    );
    this.discord =
      dependencies.discord ??
      new DiscordGateway(
        { token: config.discordToken, guildId: config.discordGuildId },
        conversations,
        this.logger
      );
  }

  public async start(): Promise<void> {
    this.logger.info("artemis_starting", {
      guildId: this.config.discordGuildId,
      model: this.config.ollamaModel
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
