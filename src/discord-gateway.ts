import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  type Interaction,
  type Message,
  type ThreadChannel
} from "discord.js";
import type { ConversationService } from "./conversation-service.js";
import type { InboundMessage, Logger, ResponseIndicator, SourceMessage } from "./domain.js";
import { safeError } from "./logger.js";

const DISCORD_MESSAGE_LIMIT = 2_000;
const TYPING_REFRESH_INTERVAL_MS = 5_000;

export function splitDiscordMessage(content: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
  if (content.length <= limit) {
    return [content];
  }
  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > limit) {
    const candidate = remaining.slice(0, limit);
    const lineBreak = candidate.lastIndexOf("\n");
    const space = candidate.lastIndexOf(" ");
    const splitAt = Math.max(lineBreak, space);
    const boundary = splitAt > Math.floor(limit / 2) ? splitAt : limit;
    chunks.push(remaining.slice(0, boundary).trimEnd());
    remaining = remaining.slice(boundary).trimStart();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function displayName(message: Message): string {
  return message.member?.displayName ?? message.author.globalName ?? message.author.username;
}

function toSourceMessage(message: Message, selfUserId: string | undefined): SourceMessage {
  return {
    discordMessageId: message.id,
    authorId: message.author.id,
    authorName: displayName(message),
    role: message.author.id === selfUserId ? "assistant" : "user",
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    ...(message.channel.isThread() ? { threadId: message.channel.id } : {})
  };
}

export async function fetchEntireThread(
  thread: ThreadChannel,
  selfUserId: string | undefined
): Promise<SourceMessage[]> {
  const messages = new Map<string, Message>();
  const starter = await thread.fetchStarterMessage().catch(() => null);
  if (starter) {
    messages.set(starter.id, starter);
  }

  let before: string | undefined;
  for (;;) {
    const page = await thread.messages.fetch({
      limit: 100,
      cache: false,
      ...(before ? { before } : {})
    });
    for (const message of page.values()) {
      messages.set(message.id, message);
    }
    if (page.size < 100) {
      break;
    }
    before = page.last()?.id;
    if (!before) {
      break;
    }
  }

  return [...messages.values()]
    .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
    .map((message) => toSourceMessage(message, selfUserId));
}

export function toInboundMessage(message: Message, selfUserId: string | undefined): InboundMessage {
  const source = toSourceMessage(message, selfUserId);
  const thread = message.channel.isThread() ? message.channel : undefined;
  const mentionsBot =
    selfUserId !== undefined &&
    (message.mentions.parsedUsers.has(selfUserId) ||
      message.mentions.roles.some((role) => role.tags?.botId === selfUserId));
  const repliesToBot =
    selfUserId !== undefined && message.mentions.repliedUser?.id === selfUserId;
  return {
    ...source,
    role: "user",
    channelId: message.channelId,
    isBot: message.author.bot,
    mentionsBot,
    repliesToBot,
    ...(message.guildId ? { guildId: message.guildId } : {}),
    ...(thread?.parentId ? { parentChannelId: thread.parentId } : {}),
    ...(thread ? { loadThread: () => fetchEntireThread(thread, selfUserId) } : {})
  };
}

export function createTypingIndicator(
  message: Message,
  logger: Logger,
  refreshIntervalMs = TYPING_REFRESH_INTERVAL_MS
): ResponseIndicator {
  let timer: ReturnType<typeof setInterval> | undefined;
  let sending = false;

  const sendTyping = async (): Promise<boolean> => {
    if (sending) {
      return true;
    }
    if (!("sendTyping" in message.channel)) {
      logger.warn("discord_typing_unavailable", {
        discordMessageId: message.id,
        channelId: message.channelId
      });
      return false;
    }
    sending = true;
    try {
      await message.channel.sendTyping();
      return true;
    } catch (error) {
      logger.warn("discord_typing_failed", {
        discordMessageId: message.id,
        channelId: message.channelId,
        ...safeError(error)
      });
      return false;
    } finally {
      sending = false;
    }
  };

  const stop = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  return {
    async start() {
      if (!(await sendTyping())) {
        return;
      }
      timer = setInterval(() => {
        void sendTyping().then((sent) => {
          if (!sent) {
            stop();
          }
        });
      }, refreshIntervalMs);
    },
    stop
  };
}

export interface DiscordGatewayOptions {
  token: string;
  channelIds: readonly string[];
  userIds: readonly string[];
}

export class DiscordGateway {
  private bound = false;
  private readonly allowedChannelIds: ReadonlySet<string>;
  private readonly allowedUserIds: ReadonlySet<string>;

  public constructor(
    private readonly options: DiscordGatewayOptions,
    private readonly conversations: ConversationService,
    private readonly logger: Logger,
    private readonly client: Client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent
      ],
      partials: [Partials.Channel]
    })
  ) {
    this.allowedChannelIds = new Set(options.channelIds);
    this.allowedUserIds = new Set(options.userIds);
  }

  public async start(): Promise<void> {
    this.bindEvents();
    await this.client.login(this.options.token);
  }

  public stop(): void {
    this.client.destroy();
  }

  public async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "ping") {
      return;
    }
    if (!interaction.guildId && !this.allowedUserIds.has(interaction.user.id)) {
      return;
    }
    if (interaction.guildId) {
      const channelId = interaction.channel?.isThread()
        ? interaction.channel.parentId
        : interaction.channelId;
      if (
        channelId === null ||
        !this.allowedChannelIds.has(channelId)
      ) {
        return;
      }
    }
    await interaction.reply("pong");
  }

  public async handleMessage(message: Message): Promise<void> {
    this.logger.audit("discord_message_received", {
      discordMessageId: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      ...(message.channel.isThread() ? { threadId: message.channel.id } : {}),
      authorId: message.author.id,
      authorName: displayName(message),
      isBot: message.author.bot,
      content: message.content,
      createdAt: message.createdAt.toISOString()
    });
    const inbound: InboundMessage = {
      ...toInboundMessage(message, this.client.user?.id),
      responseIndicator: createTypingIndicator(message, this.logger)
    };
    const response = await this.conversations.handleMessage(inbound);
    if (!response) {
      return;
    }
    if (!message.channel.isSendable()) {
      this.logger.warn("discord_channel_not_sendable", {
        discordMessageId: message.id,
        channelId: message.channelId
      });
      return;
    }
    for (const chunk of splitDiscordMessage(response)) {
      if (message.guildId) {
        await message.reply(chunk);
      } else {
        await message.channel.send(chunk);
      }
    }
  }

  private bindEvents(): void {
    if (this.bound) {
      return;
    }
    this.bound = true;
    this.client.once(Events.ClientReady, (readyClient) => {
      void readyClient.application.commands
        .set([
          new SlashCommandBuilder()
            .setName("ping")
            .setDescription("Check whether Artemis is available")
            .toJSON()
        ])
        .then(() => {
          this.logger.info("discord_ready", {
            botUserId: readyClient.user.id,
            channelIds: this.options.channelIds
          });
        })
        .catch((error: unknown) => {
          this.logger.error("discord_command_registration_failed", safeError(error));
        });
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      void this.handleInteraction(interaction).catch((error: unknown) => {
        this.logger.error("discord_interaction_failed", safeError(error));
      });
    });
    this.client.on(Events.MessageCreate, (message) => {
      void this.handleMessage(message).catch((error: unknown) => {
        this.logger.error("discord_message_failed", {
          discordMessageId: message.id,
          ...safeError(error)
        });
      });
    });
    this.client.on(Events.ShardDisconnect, (event, shardId) => {
      this.logger.warn("discord_disconnected", { shardId, closeCode: event.code });
    });
    this.client.on(Events.ShardReconnecting, (shardId) => {
      this.logger.info("discord_reconnecting", { shardId });
    });
    this.client.on(Events.ShardResume, (shardId, replayedEvents) => {
      this.logger.info("discord_resumed", { shardId, replayedEvents });
    });
    this.client.on(Events.Error, (error) => {
      this.logger.error("discord_error", safeError(error));
    });
    this.client.on(Events.Warn, (warning) => {
      this.logger.warn("discord_warning", { warning });
    });
  }
}

export const discordInternals = { toSourceMessage };
