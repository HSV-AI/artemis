import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  ChannelTimezoneStore,
  ConversationIdentity,
  IncomingMessageRecord,
  LogEntry,
  PersistedPiSession,
  PiGenerationResult,
  PiSessionEntryRecord,
  PromptSchedule,
  ScheduledPromptInput,
  ScheduledPromptPruneFilter,
  ScheduledPromptPruneResult,
  ScheduledPromptRecord,
  ScheduledPromptStatus,
  ScheduledPromptStore,
  ScheduledPromptUpdate,
  SchedulerExecutionStore,
  SessionRecord,
  SourceMessage,
  StoredMessage
} from "./domain.js";

interface ConversationRow {
  id: string;
  conversation_key: string;
  kind: "dm" | "guild";
  guild_id: string | null;
  channel_id: string;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: string;
  conversation_id: string;
  conversation_key: string;
  model: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: number;
  session_id: string;
  discord_message_id: string | null;
  thread_id: string | null;
  role: "user" | "assistant";
  author_id: string | null;
  author_name: string | null;
  content: string;
  reasoning: string | null;
  diagnostics_json: string | null;
  model: string | null;
  created_at: string;
}

interface IncomingMessageRow {
  id: number;
  discord_message_id: string;
  guild_id: string | null;
  channel_id: string;
  thread_id: string | null;
  parent_channel_id: string | null;
  author_id: string;
  author_name: string | null;
  is_bot: number;
  mentions_bot: number;
  replies_to_bot: number;
  content: string;
  created_at: string;
  logged_at: string;
}

interface PiSessionRow {
  next_ordinal: number;
}

interface PiSessionEntryRow {
  ordinal: number;
  raw_json: string;
}

interface ScheduledPromptRow {
  id: string;
  conversation_key: string;
  prompt: string;
  schedule_type: "once" | "daily" | "weekly" | "monthly" | "cron";
  at_utc: string | null;
  time_of_day: string | null;
  day_of_week: number | null;
  day_of_month: number | null;
  cron_expression: string | null;
  timezone: string | null;
  response_type: "message" | "silent";
  status: ScheduledPromptStatus;
  created_at: string;
  cancelled_at: string | null;
  scheduled_by_user_id: string | null;
  last_run_at: string | null;
}

function now(): string {
  return new Date().toISOString();
}

function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

export class ArtemisRepository implements ChannelTimezoneStore, ScheduledPromptStore, SchedulerExecutionStore {
  private readonly database: Database.Database;

  public constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.database = new Database(path);
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("journal_mode = WAL");
    this.migrate();
  }

  public close(): void {
    this.database.close();
  }

  public hasDiscordMessage(discordMessageId: string): boolean {
    const row = this.database
      .prepare("SELECT 1 FROM messages WHERE discord_message_id = ? LIMIT 1")
      .get(discordMessageId);
    return row !== undefined;
  }

  public hasIncomingMessage(discordMessageId: string): boolean {
    const row = this.database
      .prepare("SELECT 1 FROM incoming_messages WHERE discord_message_id = ? LIMIT 1")
      .get(discordMessageId);
    return row !== undefined;
  }

  public getIncomingMessage(discordMessageId: string): IncomingMessageRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM incoming_messages WHERE discord_message_id = ? LIMIT 1")
      .get(discordMessageId) as IncomingMessageRow | undefined;
    return row ? this.mapIncomingMessage(row) : undefined;
  }

  public logIncomingMessage(record: IncomingMessageRecord): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO incoming_messages
         (discord_message_id, guild_id, channel_id, thread_id, parent_channel_id,
          author_id, author_name, is_bot, mentions_bot, replies_to_bot, content,
          created_at, logged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.discordMessageId,
        record.guildId ?? null,
        record.channelId,
        record.threadId ?? null,
        record.parentChannelId ?? null,
        record.authorId,
        record.authorName ?? null,
        record.isBot ? 1 : 0,
        record.mentionsBot ? 1 : 0,
        record.repliesToBot ? 1 : 0,
        record.content,
        record.createdAt,
        now()
      );
  }

  public getOrCreateSession(identity: ConversationIdentity, model: string): SessionRecord {
    const transaction = this.database.transaction(() => {
      const existing = this.database
        .prepare("SELECT * FROM conversations WHERE conversation_key = ?")
        .get(identity.key) as ConversationRow | undefined;

      let conversation = existing;
      if (!conversation) {
        const timestamp = now();
        const id = randomUUID();
        this.database
          .prepare(
            `INSERT INTO conversations
             (id, conversation_key, kind, guild_id, channel_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            id,
            identity.key,
            identity.kind,
            identity.guildId ?? null,
            identity.channelId,
            timestamp,
            timestamp
          );
        conversation = this.database.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
          | ConversationRow
          | undefined;
      }
      if (!conversation) {
        throw new Error("Failed to create conversation");
      }

      let session = this.database
        .prepare(
          `SELECT s.*, c.conversation_key
           FROM sessions s
           JOIN conversations c ON c.id = s.conversation_id
           WHERE s.conversation_id = ? AND s.status = 'active'
           LIMIT 1`
        )
        .get(conversation.id) as SessionRow | undefined;

      if (!session) {
        const timestamp = now();
        const id = randomUUID();
        this.database
          .prepare(
            `INSERT INTO sessions
             (id, conversation_id, model, status, created_at, updated_at)
             VALUES (?, ?, ?, 'active', ?, ?)`
          )
          .run(id, conversation.id, model, timestamp, timestamp);
        session = this.database
          .prepare(
            `SELECT s.*, c.conversation_key
             FROM sessions s JOIN conversations c ON c.id = s.conversation_id
             WHERE s.id = ?`
          )
          .get(id) as SessionRow | undefined;
      }
      if (!session) {
        throw new Error("Failed to create session");
      }
      return this.mapSession(session);
    });
    return transaction();
  }

  public clearActiveSession(conversationKey: string): { cleared: boolean; sessionId?: string } {
    const transaction = this.database.transaction(() => {
      const session = this.database
        .prepare(
          `SELECT s.id
           FROM sessions s
           JOIN conversations c ON c.id = s.conversation_id
           WHERE c.conversation_key = ? AND s.status = 'active'
           LIMIT 1`
        )
        .get(conversationKey) as { id: string } | undefined;
      if (!session) {
        return { cleared: false };
      }
      this.database
        .prepare("UPDATE sessions SET status = 'closed', updated_at = ? WHERE id = ?")
        .run(now(), session.id);
      return { cleared: true, sessionId: session.id };
    });
    return transaction();
  }

  public getHistory(sessionId: string): StoredMessage[] {
    const rows = this.database
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC")
      .all(sessionId) as MessageRow[];
    return rows.map((row) => this.mapMessage(row));
  }

  public loadPiSession(sessionId: string): PersistedPiSession | undefined {
    const session = this.database
      .prepare(
        `SELECT next_ordinal
         FROM pi_sessions
         WHERE session_id = ?`
      )
      .get(sessionId) as PiSessionRow | undefined;
    if (!session) {
      return undefined;
    }
    const entries = this.database
      .prepare(
        `SELECT ordinal, raw_json
         FROM pi_session_entries
         WHERE session_id = ?
         ORDER BY ordinal ASC`
      )
      .all(sessionId) as PiSessionEntryRow[];
    if (
      entries.length !== session.next_ordinal ||
      entries.some((entry, expectedOrdinal) => entry.ordinal !== expectedOrdinal)
    ) {
      throw new Error(`PI session entry sequence is incomplete: ${sessionId}`);
    }
    return { rawEntries: entries.map((entry) => entry.raw_json) };
  }

  public createPiSession(sessionId: string, entries: PiSessionEntryRecord[]): void {
    const transaction = this.database.transaction(() => {
      this.insertPiSession(sessionId, entries);
    });
    transaction();
  }

  public appendPiSessionEntry(sessionId: string, entry: PiSessionEntryRecord): void {
    const transaction = this.database.transaction(() => {
      const session = this.database
        .prepare("SELECT next_ordinal FROM pi_sessions WHERE session_id = ?")
        .get(sessionId) as Pick<PiSessionRow, "next_ordinal"> | undefined;
      if (!session) {
        throw new Error(`PI session does not exist: ${sessionId}`);
      }
      this.insertPiSessionEntry(sessionId, session.next_ordinal, entry);
      this.database
        .prepare(
          `UPDATE pi_sessions
           SET next_ordinal = ?, updated_at = ?
           WHERE session_id = ?`
        )
        .run(session.next_ordinal + 1, now(), sessionId);
    });
    transaction();
  }

  public replacePiSessionEntries(sessionId: string, entries: PiSessionEntryRecord[]): void {
    const transaction = this.database.transaction(() => {
      const result = this.database
        .prepare(
          `UPDATE pi_sessions
           SET next_ordinal = ?, updated_at = ?
           WHERE session_id = ?`
        )
        .run(entries.length, now(), sessionId);
      if (result.changes !== 1) {
        throw new Error(`PI session does not exist: ${sessionId}`);
      }
      this.database.prepare("DELETE FROM pi_session_entries WHERE session_id = ?").run(sessionId);
      this.insertPiSessionEntries(sessionId, entries);
    });
    transaction();
  }

  public insertSourceMessages(sessionId: string, messages: SourceMessage[]): number {
    const insert = this.database.prepare(
      `INSERT OR IGNORE INTO messages
       (session_id, discord_message_id, thread_id, role, author_id, author_name, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const transaction = this.database.transaction(() => {
      let inserted = 0;
      for (const message of messages) {
        const result = insert.run(
          sessionId,
          message.discordMessageId,
          message.threadId ?? null,
          message.role,
          message.authorId,
          message.authorName,
          message.content,
          message.createdAt
        );
        inserted += result.changes;
      }
      this.touchSession(sessionId);
      return inserted;
    });
    return transaction();
  }

  public insertAssistant(sessionId: string, result: PiGenerationResult): void {
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO messages
           (session_id, role, content, reasoning, diagnostics_json, model, created_at)
           VALUES (?, 'assistant', ?, ?, ?, ?, ?)`
        )
        .run(
          sessionId,
          result.text,
          result.reasoning ?? null,
          result.diagnostics === undefined ? null : JSON.stringify(result.diagnostics),
          result.model,
          now()
        );
      this.touchSession(sessionId);
    });
    transaction();
  }

  public recordEvent(
    type: string,
    fields: { sessionId?: string; conversationKey?: string; discordMessageId?: string; details?: unknown }
  ): void {
    this.database
      .prepare(
        `INSERT INTO events
         (session_id, conversation_key, discord_message_id, event_type, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        fields.sessionId ?? null,
        fields.conversationKey ?? null,
        fields.discordMessageId ?? null,
        type,
        fields.details === undefined ? null : JSON.stringify(fields.details),
        now()
      );
  }

  public getChannelTimezone(conversationKey: string): string | undefined {
    const row = this.database
      .prepare("SELECT timezone FROM channel_timezones WHERE conversation_key = ?")
      .get(conversationKey) as { timezone: string } | undefined;
    return row?.timezone;
  }

  public setChannelTimezone(conversationKey: string, timezone: string): void {
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO channel_timezones (conversation_key, timezone, created_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(conversation_key)
           DO UPDATE SET timezone = excluded.timezone, updated_at = excluded.updated_at`
        )
        .run(conversationKey, timezone, now(), now());
    });
    transaction();
  }

  public createScheduledPrompt(conversationKey: string, input: ScheduledPromptInput): ScheduledPromptRecord {
    const schedule = input.schedule;
    const id = randomUUID();
    const createdAt = now();
    this.database
      .prepare(
        `INSERT INTO scheduled_prompts
         (id, conversation_key, prompt, schedule_type, at_utc, time_of_day,
          day_of_week, day_of_month, cron_expression, timezone, response_type,
          scheduled_by_user_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
      )
      .run(
        id,
        conversationKey,
        input.prompt,
        schedule.type,
        schedule.type === "once" ? schedule.atUtc : null,
        schedule.type === "daily" || schedule.type === "weekly" || schedule.type === "monthly"
          ? schedule.time
          : null,
        schedule.type === "weekly" ? schedule.dayOfWeek : null,
        schedule.type === "monthly" ? schedule.dayOfMonth : null,
        schedule.type === "cron" ? schedule.cron : null,
        schedule.type === "once" ? null : schedule.timezone,
        input.responseType,
        input.scheduledByUserId,
        createdAt
      );
    return {
      id,
      conversationKey,
      prompt: input.prompt,
      schedule,
      responseType: input.responseType,
      scheduledByUserId: input.scheduledByUserId,
      status: "active",
      createdAt
    };
  }

  public listScheduledPrompts(conversationKey: string): ScheduledPromptRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM scheduled_prompts
         WHERE conversation_key = ? AND status = 'active'
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(conversationKey) as ScheduledPromptRow[];
    return rows.map((row) => this.mapScheduledPrompt(row));
  }

  public listScheduledPromptHistory(conversationKey: string): ScheduledPromptRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM scheduled_prompts
         WHERE conversation_key = ?
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(conversationKey) as ScheduledPromptRow[];
    return rows.map((row) => this.mapScheduledPrompt(row));
  }

  public cancelScheduledPrompt(conversationKey: string, id: string): boolean {
    const result = this.database
      .prepare(
        `UPDATE scheduled_prompts
         SET status = 'cancelled', cancelled_at = ?
         WHERE id = ? AND conversation_key = ? AND status = 'active'`
      )
      .run(now(), id, conversationKey);
    return result.changes === 1;
  }

  public pruneScheduledPrompts(
    conversationKey: string,
    filter: ScheduledPromptPruneFilter
  ): ScheduledPromptPruneResult {
    const transaction = this.database.transaction(() => {
      let ids: string[];
      if (filter.kind === "id") {
        ids = (this.database
          .prepare(
            "SELECT id FROM scheduled_prompts WHERE id = ? AND conversation_key = ?"
          )
          .all(filter.id, conversationKey) as { id: string }[]).map((row) => row.id);
      } else {
        const clauses = [
          "conversation_key = ?",
          `status IN (${filter.statuses.map(() => "?").join(", ")})`
        ];
        const params: unknown[] = [conversationKey, ...filter.statuses];
        if (filter.before !== undefined) {
          clauses.push("created_at < ?");
          params.push(filter.before);
        }
        ids = (this.database
          .prepare(
            `SELECT id FROM scheduled_prompts WHERE ${clauses.join(" AND ")}
             ORDER BY created_at ASC, rowid ASC`
          )
          .all(...params) as { id: string }[]).map((row) => row.id);
      }
      for (const id of ids) {
        this.database
          .prepare("DELETE FROM scheduled_prompts WHERE id = ? AND conversation_key = ?")
          .run(id, conversationKey);
      }
      const remaining = this.database
        .prepare("SELECT COUNT(*) AS count FROM scheduled_prompts WHERE conversation_key = ?")
        .get(conversationKey) as { count: number };
      return { removedIds: ids, remainingCount: remaining.count };
    });
    return transaction();
  }

  public resumeScheduledPrompt(
    conversationKey: string,
    id: string,
    schedule: PromptSchedule
  ): ScheduledPromptRecord | undefined {
    // Resume is a single-row repair of a canceled record: the schedule
    // columns are rewritten as a set so the row-shape CHECK constraint stays
    // satisfied, the cancel bookkeeping and fire marker are cleared (so the
    // next occurrence derives from the resume instant), and created_at moves
    // to the resume instant — the moment the event was re-scheduled.
    const resumedAt = now();
    const result = this.database
      .prepare(
        `UPDATE scheduled_prompts
         SET schedule_type = ?, at_utc = ?, time_of_day = ?, day_of_week = ?,
             day_of_month = ?, cron_expression = ?, timezone = ?,
             status = 'active', cancelled_at = NULL, last_run_at = NULL, created_at = ?
         WHERE id = ? AND conversation_key = ? AND status = 'cancelled'`
      )
      .run(
        schedule.type,
        schedule.type === "once" ? schedule.atUtc : null,
        schedule.type === "daily" || schedule.type === "weekly" || schedule.type === "monthly"
          ? schedule.time
          : null,
        schedule.type === "weekly" ? schedule.dayOfWeek : null,
        schedule.type === "monthly" ? schedule.dayOfMonth : null,
        schedule.type === "cron" ? schedule.cron : null,
        schedule.type === "once" ? null : schedule.timezone,
        resumedAt,
        id,
        conversationKey
      );
    if (result.changes !== 1) {
      return undefined;
    }
    const row = this.database
      .prepare("SELECT * FROM scheduled_prompts WHERE id = ? AND conversation_key = ?")
      .get(id, conversationKey) as ScheduledPromptRow;
    return this.mapScheduledPrompt(row);
  }

  public updateScheduledPrompt(
    conversationKey: string,
    id: string,
    changes: ScheduledPromptUpdate
  ): ScheduledPromptRecord | undefined {
    // An in-place repair of an ongoing record: the schedule columns are
    // read first so fields absent from the changes object keep their stored
    // values, then rewritten as a set (so the row-shape CHECK constraint
    // stays satisfied). id, conversation key, status, creation instant,
    // response type, attribution, and the fire marker are never touched:
    // the record keeps its id and history, and the engine's at-most-once
    // fire semantics survive the edit. Only status='active' rows qualify;
    // cancelled and completed records are refused.
    const existingRow = this.database
      .prepare(
        `SELECT * FROM scheduled_prompts
         WHERE id = ? AND conversation_key = ? AND status = 'active'`
      )
      .get(id, conversationKey) as ScheduledPromptRow | undefined;
    if (!existingRow) {
      return undefined;
    }
    const existing = this.mapScheduledPrompt(existingRow);
    const prompt = changes.prompt ?? existing.prompt;
    const schedule = changes.schedule ?? existing.schedule;
    this.database
      .prepare(
        `UPDATE scheduled_prompts
         SET prompt = ?, schedule_type = ?, at_utc = ?, time_of_day = ?,
             day_of_week = ?, day_of_month = ?, cron_expression = ?, timezone = ?
         WHERE id = ? AND conversation_key = ? AND status = 'active'`
      )
      .run(
        prompt,
        schedule.type,
        schedule.type === "once" ? schedule.atUtc : null,
        schedule.type === "daily" || schedule.type === "weekly" || schedule.type === "monthly"
          ? schedule.time
          : null,
        schedule.type === "weekly" ? schedule.dayOfWeek : null,
        schedule.type === "monthly" ? schedule.dayOfMonth : null,
        schedule.type === "cron" ? schedule.cron : null,
        schedule.type === "once" ? null : schedule.timezone,
        id,
        conversationKey
      );
    const row = this.database
      .prepare("SELECT * FROM scheduled_prompts WHERE id = ? AND conversation_key = ?")
      .get(id, conversationKey) as ScheduledPromptRow;
    return this.mapScheduledPrompt(row);
  }

  public listActiveScheduledPrompts(): ScheduledPromptRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM scheduled_prompts
         WHERE status = 'active'
         ORDER BY created_at ASC, rowid ASC`
      )
      .all() as ScheduledPromptRow[];
    return rows.map((row) => this.mapScheduledPrompt(row));
  }

  public markScheduledPromptFired(id: string, firedAtUtc: string): void {
    this.database
      .prepare(
        `UPDATE scheduled_prompts
         SET last_run_at = ?
         WHERE id = ? AND status = 'active'`
      )
      .run(firedAtUtc, id);
  }

  public completeScheduledPrompt(id: string, completedAtUtc: string): boolean {
    const result = this.database
      .prepare(
        `UPDATE scheduled_prompts
         SET status = 'completed', last_run_at = ?
         WHERE id = ? AND status = 'active'`
      )
      .run(completedAtUtc, id);
    return result.changes === 1;
  }

  private mapScheduledPrompt(row: ScheduledPromptRow): ScheduledPromptRecord {
    let schedule: PromptSchedule;
    if (row.schedule_type === "once") {
      schedule = { type: "once", atUtc: row.at_utc ?? "" };
    } else if (row.schedule_type === "daily") {
      schedule = { type: "daily", time: row.time_of_day ?? "", timezone: row.timezone ?? "UTC" };
    } else if (row.schedule_type === "weekly") {
      schedule = {
        type: "weekly",
        time: row.time_of_day ?? "",
        dayOfWeek: row.day_of_week ?? 0,
        timezone: row.timezone ?? "UTC"
      };
    } else if (row.schedule_type === "cron") {
      schedule = { type: "cron", cron: row.cron_expression ?? "", timezone: row.timezone ?? "UTC" };
    } else {
      schedule = {
        type: "monthly",
        time: row.time_of_day ?? "",
        dayOfMonth: row.day_of_month ?? 1,
        timezone: row.timezone ?? "UTC"
      };
    }
    return {
      id: row.id,
      conversationKey: row.conversation_key,
      prompt: row.prompt,
      schedule,
      responseType: row.response_type,
      scheduledByUserId: row.scheduled_by_user_id ?? "",
      status: row.status,
      createdAt: row.created_at,
      ...(row.last_run_at ? { lastRunAt: row.last_run_at } : {}),
      ...(row.cancelled_at ? { cancelledAt: row.cancelled_at } : {}),
      // For completed one-time jobs the storage-level last_run_at is by
      // construction the instant the job fired and retired.
      ...(row.status === "completed" && row.last_run_at
        ? { completedAt: row.last_run_at }
        : {})
    };
  }

  public recordLog(entry: LogEntry): void {
    const { timestamp, level, event, ...details } = entry;
    this.database
      .prepare(
        `INSERT INTO application_logs
         (level, event, details_json, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(level, event, JSON.stringify(details), timestamp);
  }

  private touchSession(sessionId: string): void {
    this.database.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now(), sessionId);
  }

  private insertPiSessionEntries(sessionId: string, entries: PiSessionEntryRecord[]): void {
    entries.forEach((entry, ordinal) => this.insertPiSessionEntry(sessionId, ordinal, entry));
  }

  private insertPiSession(sessionId: string, entries: PiSessionEntryRecord[]): void {
    const timestamp = now();
    this.database
      .prepare(
        `INSERT INTO pi_sessions
         (session_id, next_ordinal, created_at, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(sessionId, entries.length, timestamp, timestamp);
    this.insertPiSessionEntries(sessionId, entries);
  }

  private insertPiSessionEntry(
    sessionId: string,
    ordinal: number,
    entry: PiSessionEntryRecord
  ): void {
    this.database
      .prepare(
        `INSERT INTO pi_session_entries
         (session_id, ordinal, entry_id, entry_type, parent_id, raw_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        sessionId,
        ordinal,
        entry.entryId ?? null,
        entry.entryType,
        entry.parentId ?? null,
        entry.rawJson
      );
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const appliedVersions = this.database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: number }[];
    const applied = new Set(appliedVersions.map((row) => row.version));

    if (applied.size === 0) {
      this.bootstrapFreshDatabase();
      return;
    }

    if (!applied.has(5)) {
      throw new Error(
        "Artemis requires a database that has completed migration 5 (the native PI session cutover). " +
          "This database is missing migration 5 and incremental cutover is no longer supported. " +
          "Restore it from a backup taken after a verified migration-5 rollout, or start fresh with an empty database. " +
          "Do not replay or discard this database's history; startup was aborted without partial writes."
      );
    }

    if (!applied.has(6)) {
      this.applyMigration6();
    }

    if (!applied.has(7)) {
      this.applyMigration7();
    }

    if (!applied.has(8)) {
      this.applyMigration8();
    }

    if (!applied.has(9)) {
      this.applyMigration9();
    }

    if (!applied.has(10)) {
      this.applyMigration10();
    }

    // A fully migrated database is the steady state. The bootstrap path
    // creates a fully current empty database; earlier migrations are
    // preserved as historical database facts and are never re-run.
  }

  /**
   * Migration 6 introduces per-conversation (DM or Channel Group) timezone
   * settings. It is additive: an existing verified migration-5 database
   * receives the new table in one transaction without touching any history.
   */
  private applyMigration6(): void {
    const timestamp = now();
    const transaction = this.database.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS channel_timezones (
          conversation_key TEXT PRIMARY KEY,
          timezone TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      this.database
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(6, timestamp);
    });
    transaction();
  }

  /**
   * Migration 7 introduces durable scheduled prompts. It is additive: an
   * existing verified migration-6 database receives the new table in one
   * transaction without touching any history. CHECK constraints enforce the
   * recurrence shape per schedule type so malformed rows cannot be stored.
   */
  private applyMigration7(): void {
    const timestamp = now();
    const transaction = this.database.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_prompts (
          id TEXT PRIMARY KEY,
          conversation_key TEXT NOT NULL,
          prompt TEXT NOT NULL,
          schedule_type TEXT NOT NULL
            CHECK (schedule_type IN ('once', 'daily', 'weekly', 'monthly')),
          at_utc TEXT,
          time_of_day TEXT,
          day_of_week INTEGER,
          day_of_month INTEGER,
          timezone TEXT,
          response_type TEXT NOT NULL CHECK (response_type IN ('message', 'silent')),
          scheduled_by_user_id TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
          created_at TEXT NOT NULL,
          cancelled_at TEXT,
          CHECK (
            (schedule_type = 'once'
              AND at_utc IS NOT NULL AND time_of_day IS NULL AND day_of_week IS NULL
              AND day_of_month IS NULL AND timezone IS NULL)
            OR (schedule_type = 'daily'
              AND at_utc IS NULL AND time_of_day IS NOT NULL AND day_of_week IS NULL
              AND day_of_month IS NULL AND timezone IS NOT NULL)
            OR (schedule_type = 'weekly'
              AND at_utc IS NULL AND time_of_day IS NOT NULL AND day_of_week IS NOT NULL
              AND day_of_month IS NULL AND timezone IS NOT NULL)
            OR (schedule_type = 'monthly'
              AND at_utc IS NULL AND time_of_day IS NOT NULL AND day_of_week IS NULL
              AND day_of_month IS NOT NULL AND timezone IS NOT NULL)
          )
        );

        CREATE INDEX IF NOT EXISTS scheduled_prompts_by_conversation
          ON scheduled_prompts(conversation_key, status, created_at);
      `);
      this.database
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(7, timestamp);
    });
    transaction();
  }

  /**
   * Migration 8 attributes every scheduled prompt to its scheduling user. It
   * is additive: an existing verified migration-7 database receives the new
   * column in one transaction. Rows written before authorization existed are
   * backfilled with an empty user id, which the scheduler authorization gate
   * treats as unattributed and refuses to fire.
   */
  private applyMigration8(): void {
    const timestamp = now();
    const transaction = this.database.transaction(() => {
      const columns = this.database.prepare("PRAGMA table_info(scheduled_prompts)").all() as {
        name: string;
      }[];
      const hasColumn = columns.some((column) => column.name === "scheduled_by_user_id");
      if (!hasColumn) {
        this.database.exec(
          "ALTER TABLE scheduled_prompts ADD COLUMN scheduled_by_user_id TEXT NOT NULL DEFAULT '';"
        );
      }
      this.database
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(8, timestamp);
    });
    transaction();
  }

  /**
   * Migration 9 extends scheduled prompts for the execution engine: a
   * `last_run_at` marker re-arms recurring jobs after each fire, and the
   * `completed` status retires fired one-time jobs while keeping them for
   * audit. SQLite cannot alter a CHECK constraint, so the table is rebuilt
   * additively in one transaction with every existing row — including each
   * row's migration-8 scheduling-user attribution — preserved verbatim.
   */
  private applyMigration9(): void {
    const timestamp = now();
    const transaction = this.database.transaction(() => {
      const columns = this.database.prepare("PRAGMA table_info(scheduled_prompts)").all() as {
        name: string;
      }[];
      const hasSchedulingUser = columns.some((column) => column.name === "scheduled_by_user_id");
      this.database.exec(`
        CREATE TABLE scheduled_prompts_v9 (
          id TEXT PRIMARY KEY,
          conversation_key TEXT NOT NULL,
          prompt TEXT NOT NULL,
          schedule_type TEXT NOT NULL
            CHECK (schedule_type IN ('once', 'daily', 'weekly', 'monthly')),
          at_utc TEXT,
          time_of_day TEXT,
          day_of_week INTEGER,
          day_of_month INTEGER,
          timezone TEXT,
          response_type TEXT NOT NULL CHECK (response_type IN ('message', 'silent')),
          scheduled_by_user_id TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN ('active', 'cancelled', 'completed')),
          created_at TEXT NOT NULL,
          cancelled_at TEXT,
          last_run_at TEXT,
          CHECK (
            (schedule_type = 'once'
              AND at_utc IS NOT NULL AND time_of_day IS NULL AND day_of_week IS NULL
              AND day_of_month IS NULL AND timezone IS NULL)
            OR (schedule_type = 'daily'
              AND at_utc IS NULL AND time_of_day IS NOT NULL AND day_of_week IS NULL
              AND day_of_month IS NULL AND timezone IS NOT NULL)
            OR (schedule_type = 'weekly'
              AND at_utc IS NULL AND time_of_day IS NOT NULL AND day_of_week IS NOT NULL
              AND day_of_month IS NULL AND timezone IS NOT NULL)
            OR (schedule_type = 'monthly'
              AND at_utc IS NULL AND time_of_day IS NOT NULL AND day_of_week IS NULL
              AND day_of_month IS NOT NULL AND timezone IS NOT NULL)
          )
        );

        INSERT INTO scheduled_prompts_v9
          (id, conversation_key, prompt, schedule_type, at_utc, time_of_day,
           day_of_week, day_of_month, timezone, response_type, scheduled_by_user_id,
           status, created_at, cancelled_at, last_run_at)
        SELECT id, conversation_key, prompt, schedule_type, at_utc, time_of_day,
               day_of_week, day_of_month, timezone, response_type,
               ${hasSchedulingUser ? "scheduled_by_user_id" : "''"},
               status, created_at, cancelled_at, NULL
        FROM scheduled_prompts;

        DROP TABLE scheduled_prompts;
        ALTER TABLE scheduled_prompts_v9 RENAME TO scheduled_prompts;

        CREATE INDEX IF NOT EXISTS scheduled_prompts_by_conversation
          ON scheduled_prompts(conversation_key, status, created_at);
      `);
      this.database
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(9, timestamp);
    });
    transaction();
  }

  /**
   * Migration 10 extends scheduled prompts with optional strict cron
   * schedules: a `cron_expression` column and a `cron` schedule type, each
   * locked by the row-shape CHECK constraint (a cron row requires the
   * expression plus a timezone and forbids every preset column). SQLite
   * cannot alter a CHECK constraint, so the table is rebuilt additively in
   * one transaction with every existing row — including migration 9's fire
   * bookkeeping — preserved verbatim; cron_expression starts NULL because no
   * pre-migration row can be a cron row.
   */
  private applyMigration10(): void {
    const timestamp = now();
    const transaction = this.database.transaction(() => {
      this.database.exec(`
        CREATE TABLE scheduled_prompts_v10 (
          id TEXT PRIMARY KEY,
          conversation_key TEXT NOT NULL,
          prompt TEXT NOT NULL,
          schedule_type TEXT NOT NULL
            CHECK (schedule_type IN ('once', 'daily', 'weekly', 'monthly', 'cron')),
          at_utc TEXT,
          time_of_day TEXT,
          day_of_week INTEGER,
          day_of_month INTEGER,
          cron_expression TEXT,
          timezone TEXT,
          response_type TEXT NOT NULL CHECK (response_type IN ('message', 'silent')),
          scheduled_by_user_id TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN ('active', 'cancelled', 'completed')),
          created_at TEXT NOT NULL,
          cancelled_at TEXT,
          last_run_at TEXT,
          CHECK (
            (schedule_type = 'once'
              AND at_utc IS NOT NULL AND time_of_day IS NULL AND day_of_week IS NULL
              AND day_of_month IS NULL AND cron_expression IS NULL AND timezone IS NULL)
            OR (schedule_type = 'daily'
              AND at_utc IS NULL AND time_of_day IS NOT NULL AND day_of_week IS NULL
              AND day_of_month IS NULL AND cron_expression IS NULL AND timezone IS NOT NULL)
            OR (schedule_type = 'weekly'
              AND at_utc IS NULL AND time_of_day IS NOT NULL AND day_of_week IS NOT NULL
              AND day_of_month IS NULL AND cron_expression IS NULL AND timezone IS NOT NULL)
            OR (schedule_type = 'monthly'
              AND at_utc IS NULL AND time_of_day IS NOT NULL AND day_of_week IS NULL
              AND day_of_month IS NOT NULL AND cron_expression IS NULL AND timezone IS NOT NULL)
            OR (schedule_type = 'cron'
              AND at_utc IS NULL AND time_of_day IS NULL AND day_of_week IS NULL
              AND day_of_month IS NULL AND cron_expression IS NOT NULL
              AND timezone IS NOT NULL)
          )
        );

        INSERT INTO scheduled_prompts_v10
          (id, conversation_key, prompt, schedule_type, at_utc, time_of_day,
           day_of_week, day_of_month, cron_expression, timezone, response_type,
           scheduled_by_user_id, status, created_at, cancelled_at, last_run_at)
        SELECT id, conversation_key, prompt, schedule_type, at_utc, time_of_day,
               day_of_week, day_of_month, NULL, timezone, response_type,
               scheduled_by_user_id, status, created_at, cancelled_at, last_run_at
        FROM scheduled_prompts;

        DROP TABLE scheduled_prompts;
        ALTER TABLE scheduled_prompts_v10 RENAME TO scheduled_prompts;

        CREATE INDEX IF NOT EXISTS scheduled_prompts_by_conversation
          ON scheduled_prompts(conversation_key, status, created_at);
      `);
      this.database
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(10, timestamp);
    });
    transaction();
  }

  private bootstrapFreshDatabase(): void {
    const timestamp = now();
    const transaction = this.database.transaction(() => {
      this.database.exec(`
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY,
          conversation_key TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL CHECK (kind IN ('dm', 'guild')),
          guild_id TEXT,
          channel_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          model TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX one_active_session_per_conversation
          ON sessions(conversation_id) WHERE status = 'active';

        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          discord_message_id TEXT UNIQUE,
          thread_id TEXT,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          author_id TEXT,
          author_name TEXT,
          content TEXT NOT NULL,
          reasoning TEXT,
          diagnostics_json TEXT,
          model TEXT,
          created_at TEXT NOT NULL
        );

        CREATE INDEX messages_by_session ON messages(session_id, id);

        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
          conversation_key TEXT,
          discord_message_id TEXT,
          event_type TEXT NOT NULL,
          details_json TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE application_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
          event TEXT NOT NULL,
          details_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX application_logs_by_created_at
          ON application_logs(created_at, id);

        CREATE TABLE incoming_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          discord_message_id TEXT NOT NULL UNIQUE,
          guild_id TEXT,
          channel_id TEXT NOT NULL,
          thread_id TEXT,
          parent_channel_id TEXT,
          author_id TEXT NOT NULL,
          author_name TEXT,
          is_bot INTEGER NOT NULL DEFAULT 0,
          mentions_bot INTEGER NOT NULL DEFAULT 0,
          replies_to_bot INTEGER NOT NULL DEFAULT 0,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL,
          logged_at TEXT NOT NULL
        );

        CREATE INDEX incoming_messages_by_channel
          ON incoming_messages(channel_id, id);

        CREATE INDEX incoming_messages_by_created_at
          ON incoming_messages(created_at, id);

        CREATE TABLE pi_sessions (
          session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          next_ordinal INTEGER NOT NULL CHECK (next_ordinal >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE pi_session_entries (
          session_id TEXT NOT NULL REFERENCES pi_sessions(session_id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          entry_id TEXT,
          entry_type TEXT NOT NULL,
          parent_id TEXT,
          raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
          PRIMARY KEY (session_id, ordinal),
          UNIQUE (session_id, entry_id)
        );

        CREATE INDEX pi_session_entries_by_parent
          ON pi_session_entries(session_id, parent_id);

        CREATE TABLE channel_timezones (
          conversation_key TEXT PRIMARY KEY,
          timezone TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE scheduled_prompts (
          id TEXT PRIMARY KEY,
          conversation_key TEXT NOT NULL,
          prompt TEXT NOT NULL,
          schedule_type TEXT NOT NULL
            CHECK (schedule_type IN ('once', 'daily', 'weekly', 'monthly', 'cron')),
          at_utc TEXT,
          time_of_day TEXT,
          day_of_week INTEGER,
          day_of_month INTEGER,
          cron_expression TEXT,
          timezone TEXT,
          response_type TEXT NOT NULL CHECK (response_type IN ('message', 'silent')),
          scheduled_by_user_id TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN ('active', 'cancelled', 'completed')),
          created_at TEXT NOT NULL,
          cancelled_at TEXT,
          last_run_at TEXT,
          CHECK (
            (schedule_type = 'once'
              AND at_utc IS NOT NULL AND time_of_day IS NULL AND day_of_week IS NULL
              AND day_of_month IS NULL AND cron_expression IS NULL AND timezone IS NULL)
            OR (schedule_type = 'daily'
              AND at_utc IS NULL AND time_of_day IS NOT NULL AND day_of_week IS NULL
              AND day_of_month IS NULL AND cron_expression IS NULL AND timezone IS NOT NULL)
            OR (schedule_type = 'weekly'
              AND at_utc IS NULL AND time_of_day IS NOT NULL AND day_of_week IS NOT NULL
              AND day_of_month IS NULL AND cron_expression IS NULL AND timezone IS NOT NULL)
            OR (schedule_type = 'monthly'
              AND at_utc IS NULL AND time_of_day IS NOT NULL AND day_of_week IS NULL
              AND day_of_month IS NOT NULL AND cron_expression IS NULL AND timezone IS NOT NULL)
            OR (schedule_type = 'cron'
              AND at_utc IS NULL AND time_of_day IS NULL AND day_of_week IS NULL
              AND day_of_month IS NULL AND cron_expression IS NOT NULL
              AND timezone IS NOT NULL)
          )
        );

        CREATE INDEX scheduled_prompts_by_conversation
          ON scheduled_prompts(conversation_key, status, created_at);
      `);
      const insert = this.database.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)"
      );
      for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
        insert.run(version, timestamp);
      }
    });
    transaction();
  }

  private mapSession(row: SessionRow): SessionRecord {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      conversationKey: row.conversation_key,
      model: row.model,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mapMessage(row: MessageRow): StoredMessage {
    const diagnostics = row.diagnostics_json ? (JSON.parse(row.diagnostics_json) as unknown) : undefined;
    const threadId = optional(row.thread_id);
    const reasoning = optional(row.reasoning);
    const model = optional(row.model);
    return {
      id: row.id,
      sessionId: row.session_id,
      discordMessageId: row.discord_message_id ?? `stored:${row.id}`,
      role: row.role,
      authorId: row.author_id ?? "artemis",
      authorName: row.author_name ?? "Artemis",
      content: row.content,
      ...(threadId ? { threadId } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(diagnostics !== undefined ? { diagnostics } : {}),
      ...(model ? { model } : {}),
      createdAt: row.created_at
    };
  }

  private mapIncomingMessage(row: IncomingMessageRow): IncomingMessageRecord {
    const guildId = optional(row.guild_id);
    const threadId = optional(row.thread_id);
    const parentChannelId = optional(row.parent_channel_id);
    const authorName = optional(row.author_name);
    return {
      discordMessageId: row.discord_message_id,
      channelId: row.channel_id,
      authorId: row.author_id,
      isBot: row.is_bot === 1,
      mentionsBot: row.mentions_bot === 1,
      repliesToBot: row.replies_to_bot === 1,
      content: row.content,
      createdAt: row.created_at,
      ...(guildId ? { guildId } : {}),
      ...(threadId ? { threadId } : {}),
      ...(parentChannelId ? { parentChannelId } : {}),
      ...(authorName ? { authorName } : {})
    };
  }
}
