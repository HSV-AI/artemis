import type {
  ConversationWorkQueue,
  Logger,
  PiGenerationResult,
  ScheduledPromptDispatcher,
  ScheduledPromptRecord,
  ScheduledPromptTrigger,
  ScheduledTaskRunResult
} from "./domain.js";
import { safeError } from "./logger.js";
import { parseConversationKey } from "./scheduler-authorization.js";
import type { ArtemisRepository } from "./repository.js";
import { nextOccurrenceUtc } from "./scheduler-tools.js";

/** How often the execution engine polls stored jobs for due occurrences. */
export const SCHEDULER_POLL_INTERVAL_MS = 30_000;

/** Longest stored agent response kept in invalid-response event details. */
export const INVALID_RESPONSE_PREVIEW_LENGTH = 500;

/**
 * Total generation attempts a fired scheduled prompt gets at producing a valid
 * JSON response: the original framed turn plus at most two correction retries.
 * Exported because the fire-time gate (ConversationService) owns the retry
 * loop and the engine's docs reference the same bound.
 */
export const SCHEDULER_RESPONSE_MAX_ATTEMPTS = 3;

/**
 * One enclosing markdown code fence is tolerated around the JSON object
 * because models emit them habitually even when told not to. The whole
 * response must still be exactly one fenced block and nothing else.
 */
const FENCED_RESPONSE = /^```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/;

export type ScheduledAgentResponse =
  | { outcome: "message"; content: string }
  | { outcome: "silent" };

/**
 * Validate the agent's response for a fired scheduled prompt. The response
 * must be exactly one JSON object: `{"type":"message","content":"…"}` posts
 * the content, `{"type":"silent"}` posts nothing. A single enclosing code
 * fence is tolerated; anything else — prose, arrays, unknown or missing
 * types, empty message content — is invalid.
 */
export function parseScheduledResponse(text: string): ScheduledAgentResponse | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const fenced = FENCED_RESPONSE.exec(trimmed);
  const candidate = fenced ? (fenced[1] ?? "") : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (record.type === "silent") {
    return { outcome: "silent" };
  }
  if (
    record.type === "message" &&
    typeof record.content === "string" &&
    record.content.trim() !== ""
  ) {
    return { outcome: "message", content: record.content.trim() };
  }
  return undefined;
}

/**
 * System-side framing sent to the agent when a schedule fires. The stored
 * prompt is the task; the framing adds the strict JSON response contract the
 * engine validates before anything is posted. The agent keeps its regular
 * system prompt and full tool access; only this user turn differs.
 *
 * The fire-time authorization gate (ConversationService.runScheduledPrompt)
 * presents the stored prompt wrapped in this framing, so every scheduled run
 * carries the contract without ever widening what the model can influence.
 */
export function buildSchedulerPrompt(storedPrompt: string): string {
  return [
    "A scheduled prompt is firing in this conversation. No Discord user sent a message; this is the scheduled task itself.",
    "",
    "Scheduled prompt:",
    storedPrompt,
    "",
    "Carry out the scheduled prompt now. You may use your registered tools. When the work is done, end your turn by replying with exactly one JSON object and nothing else:",
    "",
    '{"type":"message","content":"<concise text to post in this channel>"}',
    "",
    'Use {"type":"silent"} instead when nothing should be posted this time.',
    "The reply must be only the JSON object: no code fences, no commentary before or after."
  ].join("\n");
}

/**
 * Correction framing sent to the agent when its reply failed the strict JSON
 * response validation. The conversation service calls this between generation
 * attempts so the agent can fix its own previous reply, which it can still see
 * in the durable session. The correction restates every valid option —
 * `message` with its required `content` field, and `silent` — and demands a
 * JSON-only reply with no fences or commentary.
 */
export function buildSchedulerCorrectionPrompt(): string {
  return [
    "Your previous reply was not a valid response for this scheduled prompt, so nothing was posted.",
    "Reply again with exactly one JSON object matching one of these shapes and nothing else:",
    "",
    '{"type":"message","content":"<text to post in this channel>"}',
    "  - \"type\" must be the string \"message\" and \"content\" must be a non-empty string.",
    "",
    '{"type":"silent"}',
    '  - Use this instead when nothing should be posted. No "content" field.',
    "",
    "The reply must be only the JSON object: no code fences, no commentary before or after."
  ].join("\n");
}

/**
 * The occurrence a job is due to fire for, resolved from its last run (or
 * creation) at evaluation time. Occurrences missed while the process was
 * down collapse into the single most recent due instant.
 */
export function dueOccurrence(job: ScheduledPromptRecord, now: Date): Date | undefined {
  const base = new Date(job.lastRunAt ?? job.createdAt);
  if (Number.isNaN(base.getTime())) {
    return undefined;
  }
  const due = nextOccurrenceUtc(job.schedule, base);
  if (!due || due.getTime() > now.getTime()) {
    return undefined;
  }
  return due;
}

export interface SchedulerRunnerOptions {
  repository: ArtemisRepository;
  conversations: ConversationWorkQueue;
  dispatcher: ScheduledPromptDispatcher;
  logger: Logger;
  now?: () => Date;
  intervalMs?: number;
  /**
   * Fire-time readiness gate (wired by the composition to the Discord
   * gateway's ready handshake). When provided and false, the whole tick is
   * deferred — no listing, no consumption, no generation, no posting — so a
   * job cannot fire while the client cannot yet resolve its channels. The
   * job stays due and the next tick picks it up.
   */
  ready?: () => boolean;
}

/**
 * Fires stored scheduled prompts. Every poll lists active jobs across
 * conversations, computes each job's due occurrence from the stored
 * wall-clock definition (so DST stays correct), consumes the occurrence so
 * delivery is at-most-once, and runs due jobs through the conversation
 * service's fire-time authorization gate
 * ({@link ConversationWorkQueue.runScheduledPrompt}) — the same gate that
 * serializes interactive Discord turns. The gate generates in the target
 * conversation's durable session with full tool access and returns the
 * result unposted; the engine then validates the strict JSON response and
 * only posts JSON-conforming `message` content. One-time jobs complete after
 * firing, recurring jobs re-arm until cancelled.
 *
 * Ticks are deferred until the optional {@link SchedulerRunnerOptions.ready}
 * gate passes (wired to the Discord gateway's ready handshake): firing a
 * scheduled prompt while the Discord client is still connecting resolves to
 * an unpostable channel and would silently consume the run.
 */
export class SchedulerRunner {
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  public constructor(private readonly options: SchedulerRunnerOptions) {}

  public start(): void {
    if (this.timer) {
      return;
    }
    void this.runOnce();
    this.timer = setInterval(
      () => void this.runOnce(),
      this.options.intervalMs ?? SCHEDULER_POLL_INTERVAL_MS
    );
  }

  public stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One poll cycle: fire every due job once. A job that is already executing
   * (or whose poll is in flight) is never started twice; long executions
   * simply finish and leave the next occurrence for a later tick. Ticks that
   * arrive before the ready gate (the Discord gateway's ready handshake) are
   * deferred without listing or consuming — firing into a client that cannot
   * yet resolve its target channel would burn the occurrence's single
   * delivery attempt on an undeliverable response.
   */
  public async runOnce(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      if (this.options.ready && !this.options.ready()) {
        this.options.logger.debug("scheduler_deferred_not_ready", {});
        return;
      }
      const jobs = this.options.repository.listActiveScheduledPrompts();
      const now = (this.options.now ?? (() => new Date()))();
      for (const job of jobs) {
        if (dueOccurrence(job, now) === undefined) {
          continue;
        }
        await this.fire(job, now);
      }
    } catch (error) {
      this.options.logger.error("scheduler_poll_failed", safeError(error));
    } finally {
      this.polling = false;
    }
  }

  private async fire(job: ScheduledPromptRecord, now: Date): Promise<void> {
    // Consume the occurrence before executing so a crash mid-turn cannot
    // double-post; scheduler delivery is at-most-once.
    if (!this.consume(job, now)) {
      return;
    }
    try {
      // Every fired job passes the fire-time authorization gate: scope
      // re-check, live membership re-check, and serialized generation in the
      // target conversation's durable session. Denied or failed runs come
      // back as null, already logged by the gate; nothing is posted.
      const result = await this.options.conversations.runScheduledPrompt(job);
      if (result) {
        await this.deliver(job, result);
      }
    } catch (error) {
      this.options.logger.error("scheduled_prompt_failed", {
        jobId: job.id,
        conversationKey: job.conversationKey,
        ...safeError(error)
      });
      this.options.repository.recordEvent("scheduled_prompt_failed", {
        conversationKey: job.conversationKey,
        details: { jobId: job.id, ...safeError(error) }
      });
    }
  }

  /**
   * Run a stored scheduled prompt immediately, on demand — the
   * `run_scheduled_task` tool's executor. Uses the exact framework of a normal
   * due-occurrence fire: the occurrence is consumed first (one-time jobs
   * complete and never fire again; recurring jobs re-arm so the pending
   * occurrence cannot double-fire), the fire-time authorization gate runs the
   * task in its conversation's session via the inline variant (the tool
   * already holds the conversation's queue slot, so re-entering it would
   * deadlock the live turn), and the strict JSON response contract is
   * validated and delivered identically: `message` content posts, `silent`
   * posts nothing, invalid responses post nothing and log an error.
   *
   * Only `active` records are accepted; canceled and completed records are
   * refused by the tool before this runs, and the check is repeated here so a
   * stale record can never mutate lifecycle state it should not touch.
   */
  public async runScheduledTaskNow(record: ScheduledPromptRecord): Promise<ScheduledTaskRunResult> {
    try {
      if (record.status !== "active") {
        this.options.logger.warn("scheduled_task_run_refused_inactive", {
          jobId: record.id,
          conversationKey: record.conversationKey,
          status: record.status
        });
        return { status: "not-run" };
      }
      if (!this.consume(record, (this.options.now ?? (() => new Date()))())) {
        return { status: "not-run" };
      }
      const result = await this.options.conversations.runScheduledPromptInline(record);
      if (!result) {
        // Denied or failed runs are already logged by the gate; nothing posts.
        return { status: "not-run" };
      }
      return await this.deliver(record, result, "on-demand");
    } catch (error) {
      this.options.logger.error("scheduled_prompt_failed", {
        jobId: record.id,
        conversationKey: record.conversationKey,
        ...safeError(error)
      });
      this.options.repository.recordEvent("scheduled_prompt_failed", {
        conversationKey: record.conversationKey,
        details: { jobId: record.id, ...safeError(error) }
      });
      return { status: "not-run" };
    }
  }

  /**
   * Mark the fired occurrence consumed: one-time jobs complete and never run
   * again, recurring jobs re-arm so the same occurrence cannot become due
   * twice. Returns false when storage failed, leaving the job due for retry.
   */
  private consume(job: ScheduledPromptRecord, now: Date): boolean {
    try {
      if (job.schedule.type === "once") {
        this.options.repository.completeScheduledPrompt(job.id, now.toISOString());
      } else {
        this.options.repository.markScheduledPromptFired(
          job.id,
          new Date(now.getTime() + 1).toISOString()
        );
      }
      return true;
    } catch (error) {
      this.options.logger.error("scheduled_prompt_state_failed", {
        jobId: job.id,
        conversationKey: job.conversationKey,
        ...safeError(error)
      });
      return false;
    }
  }

  /**
   * Validate the gate's returned agent response and post nothing but valid
   * `message` content. `silent` responses end the run quietly; invalid JSON
   * is logged for operators with a bounded preview and never posted. Returns
   * what happened so the on-demand executor can report it; engine fires
   * ignore the result.
   */
  private async deliver(
    job: ScheduledPromptRecord,
    result: PiGenerationResult,
    trigger: ScheduledPromptTrigger = "scheduled"
  ): Promise<ScheduledTaskRunResult> {
    const { repository, logger } = this.options;
    const identity = parseConversationKey(job.conversationKey);
    if (!identity) {
      logger.error("scheduled_prompt_unroutable", {
        jobId: job.id,
        conversationKey: job.conversationKey
      });
      return { status: "undelivered" };
    }
    const parsed = parseScheduledResponse(result.text);
    if (!parsed) {
      logger.error("scheduled_prompt_invalid_response", {
        jobId: job.id,
        conversationKey: job.conversationKey
      });
      repository.recordEvent("scheduled_prompt_invalid_response", {
        conversationKey: job.conversationKey,
        details: {
          jobId: job.id,
          trigger,
          responsePreview: result.text.slice(0, INVALID_RESPONSE_PREVIEW_LENGTH)
        }
      });
      return {
        status: "invalid-response",
        responsePreview: result.text.slice(0, INVALID_RESPONSE_PREVIEW_LENGTH)
      };
    }
    if (parsed.outcome === "silent") {
      repository.recordEvent("scheduled_prompt_fired", {
        conversationKey: job.conversationKey,
        details: { jobId: job.id, outcome: "silent", trigger }
      });
      logger.info("scheduled_prompt_fired", {
        jobId: job.id,
        conversationKey: job.conversationKey,
        outcome: "silent",
        trigger
      });
      return { status: "silent" };
    }
    const posted = await this.options.dispatcher.sendToConversation(identity, parsed.content);
    if (!posted) {
      const error = new Error("Scheduler response could not be delivered to the channel");
      logger.error("scheduled_prompt_failed", {
        jobId: job.id,
        conversationKey: job.conversationKey,
        trigger,
        ...safeError(error)
      });
      repository.recordEvent("scheduled_prompt_failed", {
        conversationKey: job.conversationKey,
        details: { jobId: job.id, trigger, ...safeError(error) }
      });
      return { status: "undelivered" };
    }
    repository.recordEvent("scheduled_prompt_fired", {
      conversationKey: job.conversationKey,
      details: { jobId: job.id, outcome: "posted", trigger }
    });
    logger.info("scheduled_prompt_fired", {
      jobId: job.id,
      conversationKey: job.conversationKey,
      outcome: "posted",
      trigger
    });
    return { status: "posted", content: parsed.content };
  }
}