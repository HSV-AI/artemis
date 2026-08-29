import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessageRecord, PiGenerationResult, SourceMessage } from "../src/domain.js";
import { ArtemisRepository } from "../src/repository.js";

describe("ArtemisRepository", () => {
  let repository: ArtemisRepository | undefined;
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    repository?.close();
    repository = undefined;
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates and reuses one active session per conversation", () => {
    repository = new ArtemisRepository(":memory:");
    const identity = { key: "dm:one", kind: "dm" as const, channelId: "one" };
    const first = repository.getOrCreateSession(identity, "model-a");
    const second = repository.getOrCreateSession(identity, "model-b");
    const other = repository.getOrCreateSession(
      { key: "guild:g:channel:c", kind: "guild", guildId: "g", channelId: "c" },
      "model-a"
    );

    expect(second.id).toBe(first.id);
    expect(second.model).toBe("model-a");
    expect(other.id).not.toBe(first.id);
  });

  it("deduplicates Discord messages and restores ordered history", () => {
    repository = new ArtemisRepository(":memory:");
    const session = repository.getOrCreateSession(
      { key: "dm:one", kind: "dm", channelId: "one" },
      "model"
    );
    const source: SourceMessage = {
      discordMessageId: "discord-1",
      threadId: "thread-1",
      authorId: "user",
      authorName: "User",
      role: "user",
      content: "hello",
      createdAt: "2026-08-19T00:00:00.000Z"
    };
    expect(repository.insertSourceMessages(session.id, [source, source])).toBe(1);
    expect(repository.hasDiscordMessage("discord-1")).toBe(true);
    expect(repository.hasDiscordMessage("missing")).toBe(false);

    const assistant: PiGenerationResult = {
      text: "hi",
      reasoning: "reason",
      diagnostics: [{ type: "trace" }],
      model: "model"
    };
    repository.insertAssistant(session.id, assistant);
    expect(repository.getHistory(session.id)).toEqual([
      expect.objectContaining({
        discordMessageId: "discord-1",
        threadId: "thread-1",
        role: "user",
        content: "hello"
      }),
      expect.objectContaining({
        role: "assistant",
        content: "hi",
        reasoning: "reason",
        diagnostics: [{ type: "trace" }],
        model: "model"
      })
    ]);
  });

  it("records operational events with optional correlation fields", () => {
    repository = new ArtemisRepository(":memory:");
    expect(() => repository?.recordEvent("startup", {})).not.toThrow();
    expect(() =>
      repository?.recordEvent("failure", {
        conversationKey: "dm:one",
        discordMessageId: "message",
        details: { errorMessage: "safe" }
      })
    ).not.toThrow();
  });

  it("stores structured application logs in SQLite", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-logs-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artemis.sqlite");
    repository = new ArtemisRepository(path);
    repository.recordLog({
      timestamp: "2026-08-19T12:00:00.000Z",
      level: "error",
      event: "generation_failed",
      conversationKey: "dm:one",
      errorMessage: "provider unavailable"
    });
    repository.close();
    repository = undefined;

    const database = new Database(path, { readonly: true });
    const row = database.prepare("SELECT * FROM application_logs").get() as {
      level: string;
      event: string;
      details_json: string;
      created_at: string;
    };
    database.close();

    expect(row).toMatchObject({
      level: "error",
      event: "generation_failed",
      created_at: "2026-08-19T12:00:00.000Z"
    });
    expect(JSON.parse(row.details_json)).toEqual({
      conversationKey: "dm:one",
      errorMessage: "provider unavailable"
    });
  });

  it("clears the active session while preserving archived history", () => {
    repository = new ArtemisRepository(":memory:");
    const identity = { key: "dm:one", kind: "dm" as const, channelId: "one" };
    const session = repository.getOrCreateSession(identity, "model");
    repository.insertSourceMessages(session.id, [
      {
        discordMessageId: "u1",
        authorId: "user",
        authorName: "User",
        role: "user",
        content: "hello",
        createdAt: "2026-08-19T00:00:00.000Z"
      }
    ]);
    repository.insertAssistant(session.id, { text: "hi", model: "model" });

    const result = repository.clearActiveSession(identity.key);
    expect(result).toEqual({ cleared: true, sessionId: session.id });

    const next = repository.getOrCreateSession(identity, "model");
    expect(next.id).not.toBe(session.id);
    expect(repository.getHistory(next.id)).toEqual([]);
    expect(repository.getHistory(session.id)).toEqual([
      expect.objectContaining({ role: "user", content: "hello" }),
      expect.objectContaining({ role: "assistant", content: "hi" })
    ]);
  });

  it("reports nothing to clear when no active session exists", () => {
    repository = new ArtemisRepository(":memory:");
    expect(repository.clearActiveSession("dm:missing")).toEqual({ cleared: false });
  });

  it("clears only the active session for the requested conversation", () => {
    repository = new ArtemisRepository(":memory:");
    const dm = { key: "dm:one", kind: "dm" as const, channelId: "one" };
    const guild = {
      key: "guild:g:channel:c",
      kind: "guild" as const,
      guildId: "g",
      channelId: "c"
    };
    const dmSession = repository.getOrCreateSession(dm, "model");
    const guildSession = repository.getOrCreateSession(guild, "model");
    repository.insertSourceMessages(dmSession.id, [
      {
        discordMessageId: "dm-u1",
        authorId: "user",
        authorName: "User",
        role: "user",
        content: "dm hello",
        createdAt: "2026-08-19T00:00:00.000Z"
      }
    ]);
    repository.insertSourceMessages(guildSession.id, [
      {
        discordMessageId: "guild-u1",
        authorId: "user",
        authorName: "User",
        role: "user",
        content: "guild hello",
        createdAt: "2026-08-19T00:00:00.000Z"
      }
    ]);

    repository.clearActiveSession(dm.key);

    // dm archived history is preserved, but a new active session starts fresh
    expect(repository.getHistory(dmSession.id)).toEqual([
      expect.objectContaining({ content: "dm hello" })
    ]);
    const nextDm = repository.getOrCreateSession(dm, "model");
    expect(nextDm.id).not.toBe(dmSession.id);
    expect(repository.getHistory(nextDm.id)).toEqual([]);
    // guild session is untouched and remains the same active session
    const sameGuild = repository.getOrCreateSession(guild, "model");
    expect(sameGuild.id).toBe(guildSession.id);
    expect(repository.getHistory(guildSession.id)).toEqual([
      expect.objectContaining({ content: "guild hello" })
    ]);
  });

  it("logs every incoming message with full audit fields and deduplicates redeliveries", () => {
    repository = new ArtemisRepository(":memory:");
    const record: IncomingMessageRecord = {
      discordMessageId: "discord-1",
      guildId: "guild-1",
      channelId: "thread-1",
      threadId: "thread-1",
      parentChannelId: "parent-1",
      authorId: "user-1",
      authorName: "User One",
      isBot: false,
      mentionsBot: true,
      repliesToBot: false,
      content: "hello guild",
      createdAt: "2026-08-19T00:00:00.000Z"
    };
    repository.logIncomingMessage(record);
    // redelivery must not duplicate the audit row
    repository.logIncomingMessage(record);

    expect(repository.hasIncomingMessage("discord-1")).toBe(true);
    expect(repository.hasIncomingMessage("missing")).toBe(false);
    expect(repository.getIncomingMessage("discord-1")).toEqual(record);
  });

  it("logs DM and bot messages without optional guild/thread fields", () => {
    repository = new ArtemisRepository(":memory:");
    const record: IncomingMessageRecord = {
      discordMessageId: "dm-1",
      channelId: "dm-channel",
      authorId: "bot-1",
      authorName: "OtherBot",
      isBot: true,
      mentionsBot: false,
      repliesToBot: false,
      content: "",
      createdAt: "2026-08-19T00:00:00.000Z"
    };
    repository.logIncomingMessage(record);
    const stored = repository.getIncomingMessage("dm-1");
    expect(stored).toEqual(record);
    expect(stored?.guildId).toBeUndefined();
    expect(stored?.threadId).toBeUndefined();
    expect(stored?.parentChannelId).toBeUndefined();
  });

  it("bootstraps a fresh empty database with the current schema and migrations 1 through 8", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-bootstrap-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artemis.sqlite");
    repository = new ArtemisRepository(path);
    repository.close();
    repository = undefined;

    const database = new Database(path, { readonly: true });
    const versions = database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: number }[];
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const piSessionColumns = database.prepare("PRAGMA table_info(pi_sessions)").all() as { name: string }[];
    database.close();

    expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(tables.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "conversations",
        "sessions",
        "messages",
        "events",
        "application_logs",
        "incoming_messages",
        "pi_sessions",
        "pi_session_entries",
        "channel_timezones",
        "scheduled_prompts",
        "schema_migrations"
      ])
    );
    expect(piSessionColumns.map((column) => column.name)).toEqual([
      "session_id",
      "next_ordinal",
      "created_at",
      "updated_at"
    ]);
  });

  it("applies incremental migrations 6 and 7 to a verified migration-5 database without touching its history", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-migration5-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artemis.sqlite");
    repository = new ArtemisRepository(path);
    const identity = { key: "dm:steady", kind: "dm" as const, channelId: "steady" };
    const session = repository.getOrCreateSession(identity, "model");
    repository.insertSourceMessages(session.id, [
      {
        discordMessageId: "steady-1",
        authorId: "user",
        authorName: "User",
        role: "user",
        content: "steady state",
        createdAt: "2026-08-20T00:00:00.000Z"
      }
    ]);
    repository.insertAssistant(session.id, { text: "ack", model: "model" });
    // Simulate a pre-timezone, pre-scheduler database: drop migrations 6 and 7 and their tables.
    const downgrade = new Database(path);
    downgrade.exec("DROP TABLE channel_timezones;");
    downgrade.exec("DROP TABLE scheduled_prompts;");
    downgrade.prepare("DELETE FROM schema_migrations WHERE version IN (6, 7, 8)").run();
    downgrade.close();
    repository.close();
    repository = undefined;

    const before = new Database(path, { readonly: true });
    const beforeVersions = before
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: number }[];
    const beforeTables = before
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' " +
        "AND name IN ('channel_timezones', 'scheduled_prompts') ORDER BY name"
      )
      .all() as { name: string }[];
    before.close();

    repository = new ArtemisRepository(path);
    expect(repository.getHistory(session.id).map((message) => message.content)).toEqual([
      "steady state",
      "ack"
    ]);
    repository.close();
    repository = undefined;

    const after = new Database(path, { readonly: true });
    const afterVersions = after
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: number }[];
    const afterTables = after
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' " +
        "AND name IN ('channel_timezones', 'scheduled_prompts') ORDER BY name"
      )
      .all() as { name: string }[];
    after.close();

    expect(beforeVersions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5]);
    expect(beforeTables).toEqual([]);
    expect(afterVersions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(afterTables.map((row) => row.name)).toEqual(["channel_timezones", "scheduled_prompts"]);
  });

  it("rejects an existing pre-migration database missing migration 5 with actionable guidance and no partial writes", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-pre-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artemis.sqlite");
    const database = new Database(path);
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, '2026-08-19T00:00:00.000Z');
      INSERT INTO schema_migrations(version, applied_at) VALUES (2, '2026-08-19T00:00:00.000Z');
      INSERT INTO schema_migrations(version, applied_at) VALUES (3, '2026-08-19T00:00:00.000Z');
      INSERT INTO schema_migrations(version, applied_at) VALUES (4, '2026-08-19T00:00:00.000Z');
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        conversation_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        guild_id TEXT,
        channel_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        discord_message_id TEXT UNIQUE,
        thread_id TEXT,
        role TEXT NOT NULL,
        author_id TEXT,
        author_name TEXT,
        content TEXT NOT NULL,
        reasoning TEXT,
        diagnostics_json TEXT,
        model TEXT,
        created_at TEXT NOT NULL
      );
    `);
    database.close();

    expect(() => {
      repository = new ArtemisRepository(path);
    }).toThrow(/migration 5/);

    const reopened = new Database(path, { readonly: true });
    const versions = reopened
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: number }[];
    const piTables = reopened
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pi_%' ORDER BY name"
      )
      .all() as { name: string }[];
    reopened.close();

    expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4]);
    expect(piTables).toEqual([]);
  });

  it("stores, reads, and overwrites one timezone per conversation key", () => {
    repository = new ArtemisRepository(":memory:");
    expect(repository.getChannelTimezone("dm:one")).toBeUndefined();

    repository.setChannelTimezone("dm:one", "America/Chicago");
    expect(repository.getChannelTimezone("dm:one")).toBe("America/Chicago");
    expect(repository.getChannelTimezone("dm:other")).toBeUndefined();

    repository.setChannelTimezone("dm:one", "Europe/Berlin");
    expect(repository.getChannelTimezone("dm:one")).toBe("Europe/Berlin");
  });

  it("persists channel timezones across a repository reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-timezone-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artemis.sqlite");
    repository = new ArtemisRepository(path);
    repository.setChannelTimezone("dm:one", "America/Chicago");
    repository.setChannelTimezone("guild:g:channel:c", "Pacific/Auckland");
    repository.close();
    repository = undefined;

    repository = new ArtemisRepository(path);
    expect(repository.getChannelTimezone("dm:one")).toBe("America/Chicago");
    expect(repository.getChannelTimezone("guild:g:channel:c")).toBe("Pacific/Auckland");
    expect(repository.getChannelTimezone("guild:other:channel:other")).toBeUndefined();
  });

  it("stores a scheduled prompt with its generated id and active status", () => {
    repository = new ArtemisRepository(":memory:");
    const created = repository.createScheduledPrompt("dm:one", {
      prompt: "Remind me to stretch",
      schedule: { type: "daily", time: "09:15", timezone: "America/Chicago" },
      scheduledByUserId: "user-1",
      responseType: "silent"
    });

    expect(created.id).toMatch(/[0-9a-f-]{36}/);
    expect(created.status).toBe("active");
    expect(created.responseType).toBe("silent");
    const listed = repository.listScheduledPrompts("dm:one");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(created);
  });

  it("round-trips every recurrence shape through storage", () => {
    repository = new ArtemisRepository(":memory:");
    const once = repository.createScheduledPrompt("dm:one", {
      prompt: "once",
      schedule: { type: "once", atUtc: "2026-09-01T14:15:00.000Z" },
      scheduledByUserId: "user-1",
      responseType: "message"
    });
    const daily = repository.createScheduledPrompt("dm:one", {
      prompt: "daily",
      schedule: { type: "daily", time: "09:15", timezone: "America/Chicago" },
      scheduledByUserId: "user-1",
      responseType: "message"
    });
    const weekly = repository.createScheduledPrompt("dm:one", {
      prompt: "weekly",
      schedule: { type: "weekly", time: "08:00", dayOfWeek: 6, timezone: "UTC" },
      scheduledByUserId: "user-1",
      responseType: "silent"
    });
    const monthly = repository.createScheduledPrompt("dm:one", {
      prompt: "monthly",
      schedule: { type: "monthly", time: "07:30", dayOfMonth: 31, timezone: "Europe/Berlin" },
      scheduledByUserId: "user-1",
      responseType: "message"
    });

    const listed = repository.listScheduledPrompts("dm:one");
    expect(listed).toHaveLength(4);
    expect(once.schedule).toEqual({ type: "once", atUtc: "2026-09-01T14:15:00.000Z" });
    expect(daily.schedule).toEqual({ type: "daily", time: "09:15", timezone: "America/Chicago" });
    expect(weekly.schedule).toEqual({ type: "weekly", time: "08:00", dayOfWeek: 6, timezone: "UTC" });
    expect(monthly.schedule).toEqual({ type: "monthly", time: "07:30", dayOfMonth: 31, timezone: "Europe/Berlin" });
  });

  it("keeps scheduled prompts isolated per conversation key", () => {
    repository = new ArtemisRepository(":memory:");
    repository.createScheduledPrompt("dm:one", {
      prompt: "mine",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      scheduledByUserId: "user-1",
      responseType: "message"
    });

    expect(repository.listScheduledPrompts("dm:two")).toEqual([]);
  });

  it("cancels a scheduled prompt durably and excludes it from later lists", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-scheduler-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artemis.sqlite");
    repository = new ArtemisRepository(path);
    const created = repository.createScheduledPrompt("dm:one", {
      prompt: "cancel me",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      scheduledByUserId: "user-1",
      responseType: "message"
    });

    expect(repository.cancelScheduledPrompt("dm:two", created.id)).toBe(false);
    expect(repository.cancelScheduledPrompt("dm:one", "missing-id")).toBe(false);
    expect(repository.cancelScheduledPrompt("dm:one", created.id)).toBe(true);

    repository.close();
    repository = undefined;
    repository = new ArtemisRepository(path);
    expect(repository.listScheduledPrompts("dm:one")).toEqual([]);
  });

  it("records the scheduling user with each job and returns it in listings", () => {
    repository = new ArtemisRepository(":memory:");
    const created = repository.createScheduledPrompt("dm:one", {
      prompt: "attribute me",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "scheduler-42"
    });

    expect(created.scheduledByUserId).toBe("scheduler-42");
    const listed = repository.listScheduledPrompts("dm:one");
    expect(listed).toHaveLength(1);
    expect(listed.map((job) => job.scheduledByUserId)).toEqual(["scheduler-42"]);
  });

  it("applies migration 8 additively, backfilling legacy jobs with an unattributed scheduler", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-migration8-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artemis.sqlite");
    repository = new ArtemisRepository(path);
    const created = repository.createScheduledPrompt("dm:one", {
      prompt: "pre-migration job",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    repository.close();
    repository = undefined;

    // Simulate a migration-7 database: drop the attribution column and its marker.
    const downgrade = new Database(path);
    downgrade.exec("ALTER TABLE scheduled_prompts DROP COLUMN scheduled_by_user_id;");
    downgrade.prepare("DELETE FROM schema_migrations WHERE version = 8").run();
    downgrade.close();

    repository = new ArtemisRepository(path);
    const listed = repository.listScheduledPrompts("dm:one");
    expect(listed).toHaveLength(1);
    expect(listed.map((job) => job.id)).toEqual([created.id]);
    expect(listed.map((job) => job.scheduledByUserId)).toEqual([""]);

    const attributed = repository.createScheduledPrompt("dm:one", {
      prompt: "after migration",
      schedule: { type: "daily", time: "10:00", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "user-2"
    });
    expect(attributed.scheduledByUserId).toBe("user-2");
    repository.close();
    repository = undefined;

    const database = new Database(path, { readonly: true });
    const versions = database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: number }[];
    const columns = database.prepare("PRAGMA table_info(scheduled_prompts)").all() as {
      name: string;
    }[];
    database.close();
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(columns.map((column) => column.name)).toContain("scheduled_by_user_id");
  });

  it("enforces the recurrence shape at the storage layer", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-scheduler-constraint-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artemis.sqlite");
    repository = new ArtemisRepository(path);
    repository.close();
    repository = undefined;

    const database = new Database(path);
    // A weekly schedule without day_of_week violates the shape constraint.
    expect(() =>
      database
        .prepare(
          `INSERT INTO scheduled_prompts
           (id, conversation_key, prompt, schedule_type, at_utc, time_of_day,
            day_of_week, day_of_month, timezone, response_type, status, created_at)
           VALUES ('x', 'k', 'p', 'weekly', NULL, '09:15', NULL, NULL, 'UTC',
                   'message', 'active', '2026-08-29T00:00:00.000Z')`
        )
        .run()
    ).toThrow();
    database.close();
  });
});
