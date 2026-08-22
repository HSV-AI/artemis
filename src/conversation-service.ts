import type {
  ChannelRef,
  ConversationIdentity,
  InboundMessage,
  IncomingMessageRecord,
  Logger,
  PiGateway
} from "./domain.js";
import { KeyedSerialQueue } from "./keyed-queue.js";
import { safeError } from "./logger.js";
import { formatDiscordMessage, formatThreadSnapshot } from "./model-context.js";
import type { ArtemisRepository } from "./repository.js";

export interface ConversationServiceOptions {
  channelIds: readonly string[];
  userIds: readonly string[];
  model: string;
}

export function deriveChannelIdentity(ref: ChannelRef): ConversationIdentity {
  if (!ref.guildId) {
    return {
      key: `dm:${ref.channelId}`,
      kind: "dm",
      channelId: ref.channelId
    };
  }
  const channelId = ref.parentChannelId ?? ref.channelId;
  return {
    key: `guild:${ref.guildId}:channel:${channelId}`,
    kind: "guild",
    guildId: ref.guildId,
    channelId
  };
}

export function deriveConversationIdentity(message: InboundMessage): ConversationIdentity {
  return deriveChannelIdentity(message);
}

export class ConversationService {
  private readonly authorizedUserIds: ReadonlySet<string>;
  private readonly allowedChannelIds: ReadonlySet<string>;

  public constructor(
    private readonly options: ConversationServiceOptions,
    private readonly repository: ArtemisRepository,
    private readonly pi: PiGateway,
    private readonly logger: Logger,
    private readonly queue = new KeyedSerialQueue()
  ) {
    this.authorizedUserIds = new Set(options.userIds);
    this.allowedChannelIds = new Set(options.channelIds);
  }

  public logMessage(message: InboundMessage): void {
    const record: IncomingMessageRecord = {
      discordMessageId: message.discordMessageId,
      channelId: message.channelId,
      authorId: message.authorId,
      authorName: message.authorName,
      isBot: message.isBot,
      mentionsBot: message.mentionsBot,
      repliesToBot: message.repliesToBot,
      content: message.content,
      createdAt: message.createdAt,
      ...(message.guildId !== undefined ? { guildId: message.guildId } : {}),
      ...(message.parentChannelId !== undefined ? { parentChannelId: message.parentChannelId } : {}),
      ...(message.threadId !== undefined ? { threadId: message.threadId } : {})
    };
    try {
      this.repository.logIncomingMessage(record);
    } catch (error) {
      this.logger.error("incoming_message_log_failed", {
        discordMessageId: message.discordMessageId,
        channelId: message.channelId,
        ...safeError(error)
      });
    }
  }

  public async handleMessage(message: InboundMessage): Promise<string | null> {
    if (
      message.isBot ||
      !message.content.trim() ||
      (message.guildId !== undefined &&
        !this.allowedChannelIds.has(message.parentChannelId ?? message.channelId))
    ) {
      return null;
    }
    if (message.guildId !== undefined && !message.mentionsBot && !message.repliesToBot) {
      this.logger.debug("discord_message_ignored", {
        discordMessageId: message.discordMessageId,
        authorId: message.authorId,
        reason: "bot_not_mentioned"
      });
      return null;
    }
    if (message.guildId === undefined && !this.authorizedUserIds.has(message.authorId)) {
      this.logger.debug("discord_message_ignored", {
        discordMessageId: message.discordMessageId,
        authorId: message.authorId
      });
      return null;
    }

    const identity = deriveConversationIdentity(message);
    return this.queue.run(identity.key, async () => {
      if (this.repository.hasDiscordMessage(message.discordMessageId)) {
        this.logger.debug("duplicate_message_ignored", {
          conversationKey: identity.key,
          discordMessageId: message.discordMessageId
        });
        return null;
      }

      const session = this.repository.getOrCreateSession(identity, this.options.model);
      await message.responseIndicator?.start();
      try {
        const priorHistory = this.repository.getHistory(session.id);
        const sourceMessages = message.loadThread ? await message.loadThread() : [message];
        const normalized = sourceMessages.some(
          (candidate) => candidate.discordMessageId === message.discordMessageId
        )
          ? sourceMessages
          : [...sourceMessages, message];
        this.repository.insertSourceMessages(session.id, normalized);

        const prompt = message.loadThread
          ? formatThreadSnapshot(normalized)
          : formatDiscordMessage(message);
        const result = await this.pi.generate({
          logicalSessionId: session.id,
          conversationKind: identity.kind,
          history: priorHistory,
          prompt
        });
        if (!result.text.trim()) {
          throw new Error("PI returned an empty response");
        }
        this.repository.insertAssistant(session.id, result);
        this.repository.recordEvent("generation_succeeded", {
          sessionId: session.id,
          conversationKey: identity.key,
          discordMessageId: message.discordMessageId,
          details: { model: result.model }
        });
        return result.text;
      } catch (error) {
        const details = safeError(error);
        this.repository.recordEvent("generation_failed", {
          sessionId: session.id,
          conversationKey: identity.key,
          discordMessageId: message.discordMessageId,
          details
        });
        this.logger.error("generation_failed", {
          conversationKey: identity.key,
          sessionId: session.id,
          discordMessageId: message.discordMessageId,
          ...details
        });
        return null;
      } finally {
        message.responseIndicator?.stop();
      }
    });
  }

  public clearSession(ref: ChannelRef): { cleared: boolean } {
    const identity = deriveChannelIdentity(ref);
    const result = this.repository.clearActiveSession(identity.key);
    this.repository.recordEvent("session_cleared", {
      conversationKey: identity.key,
      details: { cleared: result.cleared, sessionId: result.sessionId }
    });
    this.logger.info("session_cleared", {
      conversationKey: identity.key,
      cleared: result.cleared
    });
    return { cleared: result.cleared };
  }
}
