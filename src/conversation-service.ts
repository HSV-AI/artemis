import { randomUUID } from "node:crypto";
import type {
  ChannelMembershipChecker,
  ChannelRef,
  ConversationIdentity,
  InboundMessage,
  IncomingMessageRecord,
  Logger,
  MembershipStatus,
  PiGateway,
  PiGenerationResult,
  ScheduledPromptRecord
} from "./domain.js";
import { KeyedSerialQueue } from "./keyed-queue.js";
import { safeError } from "./logger.js";
import { formatDiscordMessage, formatThreadSnapshot } from "./model-context.js";
import { buildSchedulerPrompt } from "./scheduler-runner.js";
import { authorizeScheduledPrompt, checkScheduledPromptScope } from "./scheduler-authorization.js";
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

/**
 * Restore a conversation identity from a stable conversation key produced by
 * {@link deriveChannelIdentity}. Re-exported from the scheduler authorization
 * module, which owns the strict harness-derived key grammar the fire-time
 * scope gate enforces; keys the harness could not have derived return
 * undefined so callers can reject them instead of guessing a scope.
 */
export { parseConversationKey } from "./scheduler-authorization.js";

export class ConversationService {
  private readonly authorizedUserIds: ReadonlySet<string>;
  private readonly allowedChannelIds: ReadonlySet<string>;

  public constructor(
    private readonly options: ConversationServiceOptions,
    private readonly repository: ArtemisRepository,
    private readonly pi: PiGateway,
    private readonly logger: Logger,
    private readonly queue = new KeyedSerialQueue(),
    private readonly membership?: ChannelMembershipChecker
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
          conversationKey: identity.key,
          conversationKind: identity.kind,
          sourceMessageId: message.discordMessageId,
          authorId: message.authorId,
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

  /**
   * Run a task exclusively behind the conversation's serialized queue. The
   * scheduler execution engine uses this to fire scheduled prompts inside the
   * same queue that serializes Discord messages, so a scheduler-fired turn
   * can never race a live user turn on the conversation's durable PI session.
   */
  public runExclusive<T>(conversationKey: string, task: () => Promise<T>): Promise<T> {
    return this.queue.run(conversationKey, task);
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

  /**
   * Run one due scheduled prompt inside the stored conversation's scope.
   *
   * The job's identity is the harness-derived conversation key recorded at
   * creation — it is never accepted from the model. Before generating, the
   * gate re-applies exactly the interactive pipeline's authorization: the
   * guild channel must still be deployment-allowlisted, the DM user must
   * still be authorized, and — where the Discord membership check is
   * reachable — the scheduling user must still be a member of the channel.
   * Allowed jobs serialize behind interactive traffic for the same
   * conversation, generate in that conversation's active session with the
   * channel-derived conversation context, and persist the turn like any other
   * exchange. The generated turn is framed with the execution engine's strict
   * JSON response contract, but validating that JSON and posting belong to
   * the engine; this method returns the generated result untouched.
   *
   * Returns null and records `scheduled_prompt_rejected` when the job is
   * denied; records `scheduled_prompt_failed` on generation errors; records
   * `scheduled_prompt_succeeded` otherwise.
   */
  public async runScheduledPrompt(record: ScheduledPromptRecord): Promise<PiGenerationResult | null> {
    // Layer 1: pure scope gate on the harness-derived key — conversation shape,
    // deployment allow-lists, scheduling-user attribution. No Discord traffic,
    // so an allow-list denial never reaches the membership endpoint.
    const scope = checkScheduledPromptScope(
      record,
      [...this.allowedChannelIds],
      [...this.authorizedUserIds]
    );
    if (!scope.ok) {
      this.schedulerLog("scheduled_prompt_rejected", record, {
        code: scope.code,
        reason: scope.detail
      });
      return null;
    }
    // Layer 2: re-check live membership where feasible.
    const membership = await this.resolveMembership(record.conversationKey, record.scheduledByUserId);
    const decision = authorizeScheduledPrompt(
      record,
      membership,
      [...this.allowedChannelIds],
      [...this.authorizedUserIds]
    );
    if (!decision.allowed) {
      this.schedulerLog("scheduled_prompt_rejected", record, {
        code: decision.code,
        reason: decision.detail
      });
      return null;
    }
    if (!decision.membershipVerified) {
      this.logger.warn("scheduled_prompt_membership_unverified", {
        conversationKey: record.conversationKey,
        jobId: record.id,
        scheduledByUserId: record.scheduledByUserId
      });
    }

    return this.queue.run(record.conversationKey, () =>
      this.executeScheduledPrompt(record, decision.identity)
    );
  }

  private async resolveMembership(
    conversationKey: string,
    userId: string
  ): Promise<MembershipStatus> {
    if (!this.membership) {
      return "unknown";
    }
    try {
      return await this.membership.isChannelMember(conversationKey, userId);
    } catch (error) {
      this.logger.warn("scheduled_prompt_membership_check_failed", {
        conversationKey,
        ...safeError(error)
      });
      return "unknown";
    }
  }

  private async executeScheduledPrompt(
    record: ScheduledPromptRecord,
    identity: ConversationIdentity
  ): Promise<PiGenerationResult | null> {
    const session = this.repository.getOrCreateSession(identity, this.options.model);
    const sourceMessageId = `scheduled:${record.id}:${randomUUID()}`;
    try {
      this.repository.insertSourceMessages(session.id, [
        {
          discordMessageId: sourceMessageId,
          authorId: record.scheduledByUserId,
          authorName: record.scheduledByUserId,
          role: "user",
          content: record.prompt,
          createdAt: new Date().toISOString()
        }
      ]);
      const result = await this.pi.generate({
        logicalSessionId: session.id,
        conversationKey: identity.key,
        conversationKind: identity.kind,
        sourceMessageId,
        authorId: record.scheduledByUserId,
        // The stored prompt is the task; the framing carries the execution
        // engine's strict JSON response contract. The persisted user row
        // above stays the raw stored prompt.
        prompt: buildSchedulerPrompt(record.prompt)
      });
      if (!result.text.trim()) {
        throw new Error("PI returned an empty response");
      }
      this.repository.insertAssistant(session.id, result);
      this.repository.recordEvent("scheduled_prompt_succeeded", {
        sessionId: session.id,
        conversationKey: identity.key,
        details: {
          jobId: record.id,
          scheduledByUserId: record.scheduledByUserId,
          scheduleType: record.schedule.type,
          model: result.model
        }
      });
      this.logger.info("scheduled_prompt_succeeded", {
        conversationKey: identity.key,
        jobId: record.id,
        sessionId: session.id
      });
      return result;
    } catch (error) {
      const details = safeError(error);
      this.repository.recordEvent("scheduled_prompt_failed", {
        sessionId: session.id,
        conversationKey: identity.key,
        details: { jobId: record.id, ...details }
      });
      this.logger.error("scheduled_prompt_failed", {
        jobId: record.id,
        conversationKey: identity.key,
        sessionId: session.id,
        ...details
      });
      return null;
    }
  }

  private schedulerLog(
    event: "scheduled_prompt_rejected",
    record: ScheduledPromptRecord,
    fields: { code?: string; [key: string]: unknown }
  ): void {
    const payload = {
      jobId: record.id,
      conversationKey: record.conversationKey,
      scheduledByUserId: record.scheduledByUserId,
      ...fields
    };
    this.logger.warn(event, payload);
    this.repository.recordEvent(event, {
      conversationKey: record.conversationKey,
      details: payload
    });
  }
}
