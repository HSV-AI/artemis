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
  ScheduledPromptRecord,
  ScheduledPromptTrigger
} from "./domain.js";
import { KeyedSerialQueue } from "./keyed-queue.js";
import { safeError } from "./logger.js";
import { formatDiscordMessage, formatThreadSnapshot } from "./model-context.js";
import { buildSchedulerCorrectionPrompt, buildSchedulerPrompt, INVALID_RESPONSE_PREVIEW_LENGTH, parseScheduledResponse, SCHEDULER_RESPONSE_MAX_ATTEMPTS } from "./scheduler-runner.js";
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
   * JSON response contract and validated here: an invalid reply triggers up to
   * two correction prompts inside the same durable session (three generation
   * attempts total, `silent` always valid) before the final result — valid or
   * not — is returned untouched. Posting still belongs to the engine, which
   * re-validates before delivering anything, so broken JSON never reaches a
   * channel.
   *
   * Returns null and records `scheduled_prompt_rejected` when the job is
   * denied; records `scheduled_prompt_failed` on generation errors; records
   * `scheduled_prompt_succeeded` otherwise (including when every generation
   * attempt produced an invalid response — the engine then records
   * `scheduled_prompt_invalid_response` and posts nothing). Events name the
   * run's `trigger`: `scheduled` for engine fires (the default) or
   * `on-demand` for tool runs.
   */
  public async runScheduledPrompt(
    record: ScheduledPromptRecord,
    trigger: ScheduledPromptTrigger = "scheduled"
  ): Promise<PiGenerationResult | null> {
    const decision = await this.authorizeScheduledRun(record);
    if (!decision.allowed) {
      this.schedulerLog("scheduled_prompt_rejected", record, trigger, {
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
      this.executeScheduledPrompt(record, decision.identity, trigger)
    );
  }

  /**
   * Run one scheduled prompt immediately for a caller that already holds the
   * conversation's queue slot — the `run_scheduled_task` tool executes inside
   * a live turn on this conversation, and re-entering the keyed queue would
   * deadlock that turn. Every other behavior matches
   * {@link ConversationService.runScheduledPrompt}: the same scope and
   * membership gates, the same durable session, the same persistence, and the
   * same JSON response contract; the generation is flagged
   * `scheduledRun` so the gateway omits the run tool and scheduled execution
   * never recurses, and events carry the `on-demand` trigger.
   */
  public async runScheduledPromptInline(
    record: ScheduledPromptRecord
  ): Promise<PiGenerationResult | null> {
    const decision = await this.authorizeScheduledRun(record);
    if (!decision.allowed) {
      this.schedulerLog("scheduled_prompt_rejected", record, "on-demand", {
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
    return this.executeScheduledPrompt(record, decision.identity, "on-demand");
  }

  /**
   * Preview one scheduled prompt for a caller that already holds the
   * conversation's queue slot — the default (non-firing) path of the
   * `run_scheduled_task` tool. The same fire-time authorization gate applies
   * (scope allow-lists and the live membership re-check), and the stored
   * prompt is run as a plain preview turn in the conversation's durable
   * session: a normal generation with no scheduled-framing, no strict JSON
   * response contract, no correction retries, and no posting. The turn is
   * persisted and attributed exactly like the fire path, and the generation is
   * flagged `scheduledRun` so the gateway omits the run tool — a preview can
   * never recurse. The occurrence is left pending: consumption of any kind is
   * the caller's separate, explicit decision (the fire executor).
   */
  public async runScheduledPromptPreviewInline(
    record: ScheduledPromptRecord
  ): Promise<PiGenerationResult | null> {
    const decision = await this.authorizeScheduledRun(record);
    if (!decision.allowed) {
      this.schedulerLog("scheduled_prompt_rejected", record, "on-demand", {
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
    return this.executeScheduledPromptPreview(record, decision.identity, "on-demand");
  }

  /**
   * Shared fire-time authorization: the pure scope gate first (no Discord
   * traffic, so an allow-list denial never reaches the membership endpoint),
   * then the live membership re-check where feasible.
   */
  private async authorizeScheduledRun(record: ScheduledPromptRecord) {
    // Layer 1: pure scope gate on the harness-derived key — conversation shape,
    // deployment allow-lists, scheduling-user attribution.
    const scope = checkScheduledPromptScope(
      record,
      [...this.allowedChannelIds],
      [...this.authorizedUserIds]
    );
    if (!scope.ok) {
      return {
        allowed: false as const,
        code: scope.code,
        detail: scope.detail
      };
    }
    // Layer 2: re-check live membership where feasible.
    const membership = await this.resolveMembership(record.conversationKey, record.scheduledByUserId);
    const decision = authorizeScheduledPrompt(
      record,
      membership,
      [...this.allowedChannelIds],
      [...this.authorizedUserIds]
    );
    return decision;
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
    identity: ConversationIdentity,
    trigger: ScheduledPromptTrigger
  ): Promise<PiGenerationResult | null> {
    const session = this.repository.getOrCreateSession(identity, this.options.model);
    const firstMessageId = `scheduled:${record.id}:${randomUUID()}`;
    try {
      let result = await this.generateScheduledTurn(
        session.id,
        record,
        identity,
        firstMessageId,
        record.prompt,
        buildSchedulerPrompt(record.prompt)
      );
      let attempts = 1;
      // Strict JSON response contract: validate every attempt and, while the
      // reply is invalid and tries remain, turn the failed attempt into a
      // correction prompt inside the same durable session — the agent can see
      // its own invalid reply and fix it. Each attempt's assistant reply is
      // persisted for full history fidelity. After the final invalid try the
      // last result is returned untouched; the engine refuses to post it and
      // logs scheduled_prompt_invalid_response, so broken JSON never reaches
      // the channel.
      while (
        parseScheduledResponse(result.text) === undefined &&
        attempts < SCHEDULER_RESPONSE_MAX_ATTEMPTS
      ) {
        this.repository.insertAssistant(session.id, result);
        this.logger.warn("scheduled_prompt_correction_issued", {
          jobId: record.id,
          conversationKey: identity.key,
          attempt: attempts,
          responsePreview: result.text.slice(0, INVALID_RESPONSE_PREVIEW_LENGTH)
        });
        const correctionPrompt = buildSchedulerCorrectionPrompt();
        result = await this.generateScheduledTurn(
          session.id,
          record,
          identity,
          `${firstMessageId}:correction-${attempts}`,
          correctionPrompt,
          correctionPrompt
        );
        attempts += 1;
      }
      this.repository.insertAssistant(session.id, result);
      this.repository.recordEvent("scheduled_prompt_succeeded", {
        sessionId: session.id,
        conversationKey: identity.key,
        details: {
          jobId: record.id,
          scheduledByUserId: record.scheduledByUserId,
          scheduleType: record.schedule.type,
          trigger,
          model: result.model,
          responseAttempts: attempts
        }
      });
      this.logger.info("scheduled_prompt_succeeded", {
        conversationKey: identity.key,
        jobId: record.id,
        sessionId: session.id,
        trigger,
        responseAttempts: attempts
      });
      return result;
    } catch (error) {
      const details = safeError(error);
      this.repository.recordEvent("scheduled_prompt_failed", {
        sessionId: session.id,
        conversationKey: identity.key,
        details: { jobId: record.id, trigger, ...details }
      });
      this.logger.error("scheduled_prompt_failed", {
        jobId: record.id,
        conversationKey: identity.key,
        sessionId: session.id,
        trigger,
        ...details
      });
      return null;
    }
  }

  /**
   * The fire-time gate's execution half for a plain preview turn: one
   * generation of the stored prompt verbatim — no scheduler framing, no JSON
   * response contract, no correction retries — persisted like any exchange and
   * attributed to the scheduling user. The `scheduledRun` flag keeps the run
   * tool out of the generation, so a preview cannot recurse. Nothing is ever
   * posted by this path: the response returns to the caller for review.
   */
  private async executeScheduledPromptPreview(
    record: ScheduledPromptRecord,
    identity: ConversationIdentity,
    trigger: ScheduledPromptTrigger
  ): Promise<PiGenerationResult | null> {
    const session = this.repository.getOrCreateSession(identity, this.options.model);
    const sourceMessageId = `scheduled:preview:${record.id}:${randomUUID()}`;
    try {
      const result = await this.generateScheduledTurn(
        session.id,
        record,
        identity,
        sourceMessageId,
        record.prompt,
        record.prompt
      );
      this.repository.insertAssistant(session.id, result);
      this.repository.recordEvent("scheduled_prompt_succeeded", {
        sessionId: session.id,
        conversationKey: identity.key,
        details: {
          jobId: record.id,
          scheduledByUserId: record.scheduledByUserId,
          scheduleType: record.schedule.type,
          trigger,
          mode: "preview",
          model: result.model
        }
      });
      this.logger.info("scheduled_prompt_succeeded", {
        conversationKey: identity.key,
        jobId: record.id,
        sessionId: session.id,
        trigger,
        mode: "preview"
      });
      return result;
    } catch (error) {
      const details = safeError(error);
      this.repository.recordEvent("scheduled_prompt_failed", {
        sessionId: session.id,
        conversationKey: identity.key,
        details: { jobId: record.id, trigger, mode: "preview", ...details }
      });
      this.logger.error("scheduled_prompt_failed", {
        jobId: record.id,
        conversationKey: identity.key,
        sessionId: session.id,
        trigger,
        mode: "preview",
        ...details
      });
      return null;
    }
  }

  /**
   * One generation attempt inside the fired job's durable session: persist the
   * user turn (raw `content` row attributed to the scheduling user), generate
   * with the model-visible `prompt`, and reject empty output as a generation
   * failure. The correction retries reuse the same helper so every attempt is
   * persisted and attributed identically.
   */
  private async generateScheduledTurn(
    sessionId: string,
    record: ScheduledPromptRecord,
    identity: ConversationIdentity,
    sourceMessageId: string,
    content: string,
    prompt: string
  ): Promise<PiGenerationResult> {
    this.repository.insertSourceMessages(sessionId, [
      {
        discordMessageId: sourceMessageId,
        authorId: record.scheduledByUserId,
        authorName: record.scheduledByUserId,
        role: "user",
        content,
        createdAt: new Date().toISOString()
      }
    ]);
    const result = await this.pi.generate({
      logicalSessionId: sessionId,
      conversationKey: identity.key,
      conversationKind: identity.kind,
      sourceMessageId,
      authorId: record.scheduledByUserId,
      // Every scheduler-fired generation — first attempt and correction
      // retries alike — is marked as such so the gateway omits
      // run_scheduled_task: scheduled execution never recurses.
      scheduledRun: true,
      prompt
    });
    if (!result.text.trim()) {
      throw new Error("PI returned an empty response");
    }
    return result;
  }

  private schedulerLog(
    event: "scheduled_prompt_rejected",
    record: ScheduledPromptRecord,
    trigger: ScheduledPromptTrigger,
    fields: { code?: string; [key: string]: unknown }
  ): void {
    const payload = {
      jobId: record.id,
      conversationKey: record.conversationKey,
      scheduledByUserId: record.scheduledByUserId,
      trigger,
      ...fields
    };
    this.logger.warn(event, payload);
    this.repository.recordEvent(event, {
      conversationKey: record.conversationKey,
      details: payload
    });
  }
}
