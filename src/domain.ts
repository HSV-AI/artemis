export type ConversationKind = "dm" | "guild";
export type ChatRole = "user" | "assistant";

export interface ChannelRef {
  channelId: string;
  guildId?: string;
  parentChannelId?: string;
}

export interface ConversationIdentity {
  key: string;
  kind: ConversationKind;
  guildId?: string;
  channelId: string;
}

export interface SourceMessage {
  discordMessageId: string;
  authorId: string;
  authorName: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  threadId?: string;
}

export interface InboundMessage extends SourceMessage {
  role: "user";
  guildId?: string;
  channelId: string;
  parentChannelId?: string;
  isBot: boolean;
  mentionsBot: boolean;
  repliesToBot: boolean;
  loadThread?: () => Promise<SourceMessage[]>;
  responseIndicator?: ResponseIndicator;
}

export interface ResponseIndicator {
  start(): Promise<void>;
  stop(): void;
}

export interface SessionRecord {
  id: string;
  conversationId: string;
  conversationKey: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessage extends SourceMessage {
  id: number;
  sessionId: string;
  reasoning?: string;
  diagnostics?: unknown;
  model?: string;
}

export interface IncomingMessageRecord {
  discordMessageId: string;
  channelId: string;
  authorId: string;
  authorName?: string;
  isBot: boolean;
  mentionsBot: boolean;
  repliesToBot: boolean;
  content: string;
  createdAt: string;
  guildId?: string;
  parentChannelId?: string;
  threadId?: string;
}

export interface PiGenerationInput {
  logicalSessionId: string;
  conversationKey: string;
  conversationKind: ConversationKind;
  sourceMessageId: string;
  authorId: string;
  prompt: string;
  /**
   * True when this generation is itself a scheduler-fired task (an engine
   * poll fire or an on-demand run). The gateway omits the run_scheduled_task
   * tool from such generations so a fired run can never trigger further
   * on-demand runs — scheduled execution does not recurse.
   */
  scheduledRun?: boolean;
}

export interface PiSessionEntryRecord {
  entryId?: string;
  entryType: string;
  parentId?: string;
  rawJson: string;
}

export interface PersistedPiSession {
  rawEntries: string[];
}

export interface PiSessionStore {
  loadPiSession(sessionId: string): PersistedPiSession | undefined;
  createPiSession(sessionId: string, entries: PiSessionEntryRecord[]): void;
  appendPiSessionEntry(sessionId: string, entry: PiSessionEntryRecord): void;
  replacePiSessionEntries(sessionId: string, entries: PiSessionEntryRecord[]): void;
}

export interface PiGenerationResult {
  text: string;
  reasoning?: string;
  diagnostics?: unknown;
  model: string;
}

/**
 * Per-conversation (DM or Channel Group) settings storage keyed by the stable
 * conversation key. Backed by SQLite; the harness injects the key, so the
 * model can never read or write another conversation's settings.
 */
export interface ChannelTimezoneStore {
  getChannelTimezone(conversationKey: string): string | undefined;
  setChannelTimezone(conversationKey: string, timezone: string): void;
}

export type PromptResponseType = "message" | "silent";

/**
 * Result of a harness-side channel membership check for a DM or Channel Group:
 * - `member`: the user is verifiably a member of the target conversation.
 * - `not-member`: Discord confirms the user is not a member.
 * - `unknown`: the check could not be completed (Discord unreachable or check
 *   not wired); callers decide their own fail-open or fail-closed policy.
 */
export type MembershipStatus = "member" | "not-member" | "unknown";

/**
 * Harness-side membership authority for scheduler authorization. Backed by
 * live Discord state (guild member + channel permission, or DM recipient), so
 * scheduled prompts can only target conversations the scheduling user can
 * actually see. The AI has no influence over either argument.
 */
export interface ChannelMembershipChecker {
  isChannelMember(conversationKey: string, userId: string): Promise<MembershipStatus>;
}

/** Storage-level lifecycle of a scheduled prompt record. */
export type ScheduledPromptStatus = "active" | "cancelled" | "completed";

/**
 * A validated prompt schedule. One-time schedules carry an absolute UTC
 * instant; recurring schedules carry a zone-local wall-clock time plus the
 * IANA timezone it is interpreted in; cron schedules carry a strict 5-field
 * cron expression. Recurring UTC instants are derived at evaluation time so
 * daylight saving time stays correct.
 */
export type PromptSchedule =
  | { type: "once"; atUtc: string }
  | { type: "daily"; time: string; timezone: string }
  | { type: "weekly"; time: string; dayOfWeek: number; timezone: string }
  | { type: "monthly"; time: string; dayOfMonth: number; timezone: string }
  | { type: "cron"; cron: string; timezone: string };

export interface ScheduledPromptRecord {
  id: string;
  conversationKey: string;
  prompt: string;
  schedule: PromptSchedule;
  responseType: PromptResponseType;
  /** Harness-injected Discord user id that requested the schedule. */
  scheduledByUserId: string;
  /**
   * `active` until the execution engine consumes it: one-time jobs end as
   * `completed` after firing, user cancellations become `cancelled`. Cancel
   * and resume keep the record for audit; only pruning removes it.
   */
  status: ScheduledPromptStatus;
  createdAt: string;
  /**
   * Instant the execution engine last armed this job, set just after each
   * fire. Absent until the job has fired at least once; resume clears it so
   * the next occurrence is derived from the resume instant.
   */
  lastRunAt?: string;
  cancelledAt?: string;
  /**
   * Instant a completed one-time job fired and retired. Derived from the
   * storage-level `last_run_at`, which for completed jobs is always the
   * completion instant.
   */
  completedAt?: string;
}

export interface ScheduledPromptInput {
  prompt: string;
  schedule: PromptSchedule;
  responseType: PromptResponseType;
  /** Harness-injected Discord user who requested the schedule. */
  scheduledByUserId: string;
}

/**
 * Selection of scheduled prompt records to hard-delete. Exactly one form:
 * a single record by id, or a bulk selection by status with an optional
 * cutoff. The model-facing prune tool enforces the mutual exclusion between
 * the id form and bulk filters before building a filter.
 */
export type ScheduledPromptPruneFilter =
  | { kind: "id"; id: string }
  | {
      kind: "bulk";
      /** Only records in these statuses are removed. Never empty. */
      statuses: readonly ScheduledPromptStatus[];
      /**
       * Canonical UTC ISO-8601 cutoff: only records scheduled strictly
       * before this instant are removed. Absent means no cutoff.
       */
      before?: string;
    };

/**
 * In-place edit of an existing scheduled prompt. Exactly the fields the
 * caller supplies change; everything else stays untouched — the record id,
 * creation instant, response type, and scheduling attribution included.
 */
export interface ScheduledPromptUpdate {
  /** Replacement prompt text. Absent preserves the stored prompt. */
  prompt?: string;
  /** Replacement schedule. Absent preserves the stored schedule. */
  schedule?: PromptSchedule;
}

/**
 * Outcome of a hard prune: the ids actually removed (destructive, not
 * recoverable) and how many of the conversation's records remain.
 */
export interface ScheduledPromptPruneResult {
  removedIds: string[];
  remainingCount: number;
}

/**
 * Durable storage for scheduled prompts, scoped by the stable conversation
 * key. Backed by SQLite so jobs survive restarts. The harness injects both
 * the key and the scheduling user; the model can only manage schedules for
 * the conversation it is in, on behalf of the user actually speaking.
 */
export interface ScheduledPromptStore {
  createScheduledPrompt(conversationKey: string, input: ScheduledPromptInput): ScheduledPromptRecord;
  listScheduledPrompts(conversationKey: string): ScheduledPromptRecord[];
  /**
   * Every record of the conversation across the full lifecycle (active,
   * canceled, and completed), the audit view behind the list tool's
   * `include_history` option.
   */
  listScheduledPromptHistory(conversationKey: string): ScheduledPromptRecord[];
  cancelScheduledPrompt(conversationKey: string, id: string): boolean;
  /**
   * Hard-deletes the selected records from the database. Not recoverable:
   * a pruned record can never be listed or resumed again. Scoped to the
   * conversation key, so no other conversation's records are ever touched.
   */
  pruneScheduledPrompts(
    conversationKey: string,
    filter: ScheduledPromptPruneFilter
  ): ScheduledPromptPruneResult;
  /**
   * Restores a canceled record to `active` with a new schedule, preserving
   * its original prompt. Returns the updated record, or undefined when the
   * id does not exist in this conversation or is not canceled.
   */
  resumeScheduledPrompt(
    conversationKey: string,
    id: string,
    schedule: PromptSchedule
  ): ScheduledPromptRecord | undefined;
  /**
   * Rewrites an ongoing record's prompt text and/or schedule in place,
   * preserving its id, creation instant, and history. Fields absent from
   * the changes object keep their stored values. Returns the updated
   * record, or undefined when the id does not exist in this conversation
   * or is not ongoing (only ongoing records can be edited in place;
   * canceled records are re-armed via resumeScheduledPrompt, and completed
   * records are retired history).
   */
  updateScheduledPrompt(
    conversationKey: string,
    id: string,
    changes: ScheduledPromptUpdate
  ): ScheduledPromptRecord | undefined;
}

/**
 * Application-facing storage for the scheduler execution engine. Unlike the
 * model-facing {@link ScheduledPromptStore}, these operations run inside the
 * process boundary across every conversation and are never exposed to the
 * model as tool parameters or tool outputs.
 *
 * The engine's lifecycle is claim-and-reconcile: a due occurrence is claimed
 * atomically before the fire-time gate runs, and the claim is reconciled
 * afterwards — settled on success, released on denial or failure. A claim left
 * behind by a crashed run expires at its deadline, so a due job is never
 * permanently lost and two pollers can never both run the same occurrence.
 */
export interface SchedulerExecutionStore {
  /** Every active job across conversations, ordered by creation. */
  listActiveScheduledPrompts(): ScheduledPromptRecord[];
  /**
   * Atomically claims one job for execution: only an `active` job whose claim
   * is absent (never claimed) or expired (`claimed_until` before `nowUtc`)
   * claims successfully, storing `claimedUntilUtc` as the new claim deadline.
   * Returns false when another runner already holds a live claim, the record
   * is not active, or the id does not exist.
   */
  claimScheduledPrompt(id: string, claimedUntilUtc: string, nowUtc: string): boolean;
  /** Clears a job's claim so a denied or failed run can retry on a later tick. */
  releaseScheduledPromptClaim(id: string): void;
  /** Records the moment a recurring job was last armed, blocking re-fires. */
  markScheduledPromptFired(id: string, firedAtUtc: string): void;
  /** Marks a one-time job completed after it fired. */
  completeScheduledPrompt(id: string, completedAtUtc: string): void;
}

/**
 * What started a scheduled-prompt execution: the engine's due-occurrence poll
 * (`scheduled`) or an explicit on-demand request through the
 * `run_scheduled_task` tool (`on-demand`). Recorded on the scheduler events so
 * operators can tell fires apart.
 */
export type ScheduledPromptTrigger = "scheduled" | "on-demand";

/**
 * Outcome of one on-demand scheduled-task run (the `run_scheduled_task` tool's
 * executor path). Mirrors a normal scheduled fire: the response contract is
 * validated identically, `message` content is posted, `silent` posts nothing,
 * and invalid or undeliverable responses post nothing.
 */
export type ScheduledTaskRunResult =
  | { status: "posted"; content: string }
  | { status: "silent" }
  | { status: "invalid-response"; responsePreview: string }
  | { status: "unroutable" }
  | { status: "undelivered" }
  | { status: "not-run" };

/**
 * Immediate-run executor for stored scheduled prompts, implemented by the
 * scheduler execution engine and wired into the scheduler tools by the
 * composition. Runs the same framework as a due-occurrence fire: consumption,
 * fire-time authorization gate, strict JSON response validation, and posting.
 */
export interface ScheduledTaskRunner {
  runScheduledTaskNow(record: ScheduledPromptRecord): Promise<ScheduledTaskRunResult>;
}

export interface PiGateway {
  checkHealth(): Promise<void>;
  generate(input: PiGenerationInput): Promise<PiGenerationResult>;
  setBotDisplayName(name: string): void;
}

export interface LogFields {
  [key: string]: unknown;
}

/**
 * Conversation coordinator surface for the scheduler execution engine. The
 * engine shares the conversation service's per-conversation queue so a
 * scheduler-fired turn can never race a live Discord turn on the same durable
 * PI session, and every fired job passes through the same authorization gate
 * as the interactive pipeline before any generation work.
 */
export interface ConversationWorkQueue {
  runExclusive<T>(conversationKey: string, task: () => Promise<T>): Promise<T>;
  /**
   * Authorize and run one scheduled job in its stored conversation's scope
   * (scope gate, membership re-check, queued generation, turn persistence).
   * Returns null for denied or failed runs; posting belongs to the engine.
   */
  runScheduledPrompt(record: ScheduledPromptRecord): Promise<PiGenerationResult | null>;
  /**
   * The same gate and execution without the queue wait, for a caller that
   * already holds the conversation's queue slot — the `run_scheduled_task`
   * tool executes inside a live turn on the same conversation, so re-entering
   * the queue would deadlock. Returns null for denied or failed runs.
   */
  runScheduledPromptInline(record: ScheduledPromptRecord): Promise<PiGenerationResult | null>;
}

/**
 * Delivers application-generated content to a conversation's Discord channel.
 * Implemented by the Discord gateway; returns false when content could not be
 * delivered, without throwing for missing or non-sendable channels.
 */
export interface ScheduledPromptDispatcher {
  sendToConversation(identity: ConversationIdentity, content: string): Promise<boolean>;
}

export interface LogEntry extends LogFields {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  event: string;
}

export interface Logger {
  audit(event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}
