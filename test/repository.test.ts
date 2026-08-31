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

  it("bootstraps a fresh empty database with the current schema and migrations 1 through 11", () => {
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
    const scheduledPromptColumns = (
      database.prepare("PRAGMA table_info(scheduled_prompts)").all() as { name: string }[]
    ).map((column) => column.name);
    database.close();

    expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
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
    expect(scheduledPromptColumns).toContain("cron_expression");
    expect(scheduledPromptColumns).toContain("claimed_until");
  });

  it("applies incremental migrations 6 through 11 to a verified migration-5 database without touching its history", () => {
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
    // Simulate a pre-timezone, pre-scheduler database: drop migrations 6
    // through 11 and their tables.
    const downgrade = new Database(path);
    downgrade.exec("DROP TABLE channel_timezones;");
    downgrade.exec("DROP TABLE scheduled_prompts;");
    downgrade.prepare("DELETE FROM schema_migrations WHERE version IN (6, 7, 8, 9, 10, 11)").run();
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
    expect(afterVersions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
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

  it("round-trips a cron schedule through storage and a repository reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-scheduler-cron-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artemis.sqlite");
    repository = new ArtemisRepository(path);
    const weekdays = repository.createScheduledPrompt("dm:one", {
      prompt: "weekday standup",
      schedule: { type: "cron", cron: "15 9 * * 1-5", timezone: "America/Chicago" },
      scheduledByUserId: "user-1",
      responseType: "silent"
    });
    const firstAndFifteenth = repository.createScheduledPrompt("dm:one", {
      prompt: "digest",
      schedule: { type: "cron", cron: "0 0 1,15 * *", timezone: "UTC" },
      scheduledByUserId: "user-1",
      responseType: "message"
    });

    const listed = repository.listScheduledPrompts("dm:one");
    expect(listed).toHaveLength(2);
    expect(weekdays.schedule)
      .toEqual({ type: "cron", cron: "15 9 * * 1-5", timezone: "America/Chicago" });
    expect(firstAndFifteenth.schedule)
      .toEqual({ type: "cron", cron: "0 0 1,15 * *", timezone: "UTC" });
    expect(listed.every((job) => job.status === "active")).toBe(true);

    // A cron job survives the restart like every preset shape.
    repository.close();
    repository = undefined;
    repository = new ArtemisRepository(path);
    expect(repository.listScheduledPrompts("dm:one").map((job) => job.schedule)).toEqual([
      { type: "cron", cron: "15 9 * * 1-5", timezone: "America/Chicago" },
      { type: "cron", cron: "0 0 1,15 * *", timezone: "UTC" }
    ]);

    // Cancel keeps it as audit history and the engine's active list drops it.
    expect(repository.cancelScheduledPrompt("dm:one", weekdays.id)).toBe(true);
    expect(repository.listActiveScheduledPrompts().map((job) => job.id))
      .toEqual([firstAndFifteenth.id]);
    const history = repository.listScheduledPromptHistory("dm:one");
    expect(history.find((entry) => entry.id === weekdays.id)?.status).toBe("cancelled");

    // Resume restores a canceled cron record with the new cron schedule.
    const resumed = repository.resumeScheduledPrompt(
      "dm:one",
      weekdays.id,
      { type: "cron", cron: "30 8 * * 1-5", timezone: "America/Chicago" }
    );
    expect(resumed?.schedule).toEqual({ type: "cron", cron: "30 8 * * 1-5", timezone: "America/Chicago" });
    expect(resumed?.status).toBe("active");
    expect(resumed?.cancelledAt).toBeUndefined();
    expect(resumed?.lastRunAt).toBeUndefined();

    // Update rewrites a cron row to a preset shape and back in place.
    const updatedAway = repository.updateScheduledPrompt(
      "dm:one",
      weekdays.id,
      { schedule: { type: "daily", time: "07:00", timezone: "UTC" } }
    );
    expect(updatedAway?.schedule).toEqual({ type: "daily", time: "07:00", timezone: "UTC" });
    const updatedBack = repository.updateScheduledPrompt(
      "dm:one",
      weekdays.id,
      { schedule: { type: "cron", cron: "0 12 * * 5", timezone: "UTC" } }
    );
    expect(updatedBack?.schedule).toEqual({ type: "cron", cron: "0 12 * * 5", timezone: "UTC" });
    expect(updatedBack?.id).toBe(weekdays.id);

    // Prune removes cron rows like any other shape.
    const pruned = repository.pruneScheduledPrompts("dm:one", { kind: "id", id: firstAndFifteenth.id });
    expect(pruned.removedIds).toEqual([firstAndFifteenth.id]);
    expect(repository.listScheduledPromptHistory("dm:one").map((entry) => entry.id))
      .toEqual([weekdays.id]);
  });

  it("enforces the cron row shape at the storage layer", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-scheduler-cron-constraint-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artemis.sqlite");
    repository = new ArtemisRepository(path);
    repository.close();
    repository = undefined;

    const database = new Database(path);
    const insert = database.prepare(
      `INSERT INTO scheduled_prompts
       (id, conversation_key, prompt, schedule_type, at_utc, time_of_day,
        day_of_week, day_of_month, cron_expression, timezone, response_type,
        status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'message', 'active', '2026-08-29T00:00:00.000Z')`
    );
    // A valid cron row carries the expression and a timezone and no preset column.
    expect(() => insert.run("x1", "k", "p", "cron", null, null, null, null, "15 9 * * 1-5", "UTC")).not.toThrow();
    // A cron row without a timezone violates the shape constraint.
    expect(() => insert.run("x2", "k", "p", "cron", null, null, null, null, "15 9 * * 1-5", null)).toThrow();
    // A cron row without an expression violates the shape constraint.
    expect(() => insert.run("x3", "k", "p", "cron", null, null, null, null, null, "UTC")).toThrow();
    // A cron row carrying a preset column violates the shape constraint.
    expect(() => insert.run("x4", "k", "p", "cron", null, "09:15", null, null, "15 9 * * 1-5", "UTC")).toThrow();
    expect(() => insert.run("x5", "k", "p", "cron", null, null, 1, null, "15 9 * * 1-5", "UTC")).toThrow();
    expect(() => insert.run("x6", "k", "p", "cron", null, null, null, 15, "15 9 * * 1-5", "UTC")).toThrow();
    expect(() => insert.run("x7", "k", "p", "cron", "2026-09-01T00:00:00.000Z", null, null, null, "15 9 * * 1-5", "UTC")).toThrow();
    // An unrecognized schedule type stays rejected.
    expect(() => insert.run("x8", "k", "p", "annually", null, null, null, null, null, "UTC")).toThrow();
    database.close();
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
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(columns.map((column) => column.name)).toContain("scheduled_by_user_id");
    expect(columns.map((column) => column.name)).toContain("last_run_at");
    expect(columns.map((column) => column.name)).toContain("cron_expression");
  });

  it("applies migration 11 to a migration-10 database, adding the claim column while preserving every job", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-migration11-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artemis.sqlite");
    repository = new ArtemisRepository(path);
    const legacy = repository.createScheduledPrompt("dm:legacy", {
      prompt: "legacy prompt",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "legacy-user"
    });
    const cancelled = repository.createScheduledPrompt("dm:legacy", {
      prompt: "cancelled prompt",
      schedule: { type: "once", atUtc: "2026-09-01T09:00:00.000Z" },
      responseType: "silent",
      scheduledByUserId: "legacy-user"
    });
    repository.markScheduledPromptFired(legacy.id, "2026-08-30T14:20:00.001Z");
    repository.cancelScheduledPrompt("dm:legacy", cancelled.id);
    repository.close();
    repository = undefined;

    // Downgrade the scheduled_prompts table to its migration-10 shape: no
    // claimed_until column. Only migration 11 is rolled back.
    const downgrade = new Database(path);
    const rows = downgrade.prepare("SELECT * FROM scheduled_prompts").all() as
      Array<Record<string, unknown>>;
    downgrade.exec("DROP TABLE scheduled_prompts;");
    downgrade.exec(`
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
    `);
    const insert = downgrade.prepare(
      `INSERT INTO scheduled_prompts
       (id, conversation_key, prompt, schedule_type, at_utc, time_of_day,
        day_of_week, day_of_month, cron_expression, timezone, response_type,
        scheduled_by_user_id, status, created_at, cancelled_at, last_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      insert.run(
        row.id,
        row.conversation_key,
        row.prompt,
        row.schedule_type,
        row.at_utc,
        row.time_of_day,
        row.day_of_week,
        row.day_of_month,
        row.cron_expression,
        row.timezone,
        row.response_type,
        row.scheduled_by_user_id,
        row.status,
        row.created_at,
        row.cancelled_at,
        row.last_run_at
      );
    }
    downgrade.prepare("DELETE FROM schema_migrations WHERE version = 11").run();
    downgrade.close();

    repository = new ArtemisRepository(path);
    // Every pre-migration row survives, with its fire bookkeeping intact.
    expect(repository.listScheduledPromptHistory("dm:legacy").map((job) => job.id))
      .toEqual([legacy.id, cancelled.id]);
    expect(repository.listScheduledPrompts("dm:legacy")[0]?.lastRunAt).toBe("2026-08-30T14:20:00.001Z");
    expect(repository.listActiveScheduledPrompts().map((job) => job.id)).toEqual([legacy.id]);

    // The claim lifecycle works against the upgraded table.
    expect(repository.claimScheduledPrompt(legacy.id, "2026-08-30T14:30:00.000Z", "2026-08-30T14:20:00.000Z"))
      .toBe(true);
    expect(repository.claimScheduledPrompt(legacy.id, "2026-08-30T14:40:00.000Z", "2026-08-30T14:25:00.000Z"))
      .toBe(false);
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
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(columns.map((column) => column.name)).toContain("claimed_until");
  });

  it("applies migration 10 to a migration-9 database, preserving jobs and adding the cron columns", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-migration10-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artemis.sqlite");
    repository = new ArtemisRepository(path);
    const legacy = repository.createScheduledPrompt("dm:legacy", {
      prompt: "legacy prompt",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "legacy-user"
    });
    repository.close();
    repository = undefined;

    // Downgrade the scheduled_prompts table to its migration-9 shape: no
    // cron_expression column and no 'cron' schedule type. Only migration 10
    // is rolled back.
    const downgrade = new Database(path);
    const rows = downgrade.prepare("SELECT * FROM scheduled_prompts").all() as
      Array<Record<string, unknown>>;
    downgrade.exec("DROP TABLE scheduled_prompts;");
    downgrade.exec(`
      CREATE TABLE scheduled_prompts (
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
    `);
    const insert = downgrade.prepare(
      `INSERT INTO scheduled_prompts
       (id, conversation_key, prompt, schedule_type, at_utc, time_of_day,
        day_of_week, day_of_month, timezone, response_type, scheduled_by_user_id,
        status, created_at, cancelled_at, last_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      insert.run(
        row.id,
        row.conversation_key,
        row.prompt,
        row.schedule_type,
        row.at_utc,
        row.time_of_day,
        row.day_of_week,
        row.day_of_month,
        row.timezone,
        row.response_type,
        row.scheduled_by_user_id,
        row.status,
        row.created_at,
        row.cancelled_at,
        row.last_run_at
      );
    }
    downgrade.prepare("DELETE FROM schema_migrations WHERE version = 10").run();
    downgrade.close();

    repository = new ArtemisRepository(path);
    const listed = repository.listScheduledPrompts("dm:legacy");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(legacy.id);
    expect(listed[0]?.schedule).toEqual({ type: "daily", time: "09:15", timezone: "UTC" });
    expect(listed[0]?.scheduledByUserId).toBe("legacy-user");
    expect(repository.listActiveScheduledPrompts().map((job) => job.id)).toEqual([legacy.id]);

    // A cron job stores and round-trips in the upgraded table.
    const cron = repository.createScheduledPrompt("dm:legacy", {
      prompt: "cron prompt",
      schedule: { type: "cron", cron: "15 9 * * 1-5", timezone: "America/Chicago" },
      responseType: "message",
      scheduledByUserId: "cron-user"
    });
    expect(cron.schedule).toEqual({ type: "cron", cron: "15 9 * * 1-5", timezone: "America/Chicago" });
    expect(repository.listScheduledPrompts("dm:legacy")).toHaveLength(2);
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
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(columns.map((column) => column.name)).toContain("cron_expression");
  });

  it("claims an active job atomically so a second concurrent claim of the same job fails", () => {
    repository = new ArtemisRepository(":memory:");
    const created = repository.createScheduledPrompt("dm:one", {
      prompt: "claimable",
      schedule: { type: "once", atUtc: "2026-09-01T09:00:00.000Z" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });

    // First poller wins the atomic claim;
    expect(
      repository.claimScheduledPrompt(created.id, "2026-08-30T14:30:00.000Z", "2026-08-30T14:20:00.000Z")
    ).toBe(true);
    // second concurrent poller is refused while the claim is live.
    expect(
      repository.claimScheduledPrompt(created.id, "2026-08-30T14:35:00.000Z", "2026-08-30T14:20:00.000Z")
    ).toBe(false);
  });

  it("reclaims a job only once its claim deadline has passed", () => {
    repository = new ArtemisRepository(":memory:");
    const created = repository.createScheduledPrompt("dm:one", {
      prompt: "expired claim",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });

    expect(
      repository.claimScheduledPrompt(created.id, "2026-08-30T14:30:00.000Z", "2026-08-30T14:20:00.000Z")
    ).toBe(true);
    // Before the deadline the claim holds.
    expect(
      repository.claimScheduledPrompt(created.id, "2026-08-30T14:31:00.000Z", "2026-08-30T14:29:59.999Z")
    ).toBe(false);
    // Once the deadline passes the crashed run's claim is recomputable.
    expect(
      repository.claimScheduledPrompt(created.id, "2026-08-30T14:40:00.000Z", "2026-08-30T14:30:00.001Z")
    ).toBe(true);
  });

  it("only claims active records, refusing cancelled and completed jobs", () => {
    repository = new ArtemisRepository(":memory:");
    const live = repository.createScheduledPrompt("dm:one", {
      prompt: "live",
      schedule: { type: "weekly", time: "09:15", dayOfWeek: 1, timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    const cancelled = repository.createScheduledPrompt("dm:one", {
      prompt: "cancelled",
      schedule: { type: "daily", time: "10:15", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    const done = repository.createScheduledPrompt("dm:one", {
      prompt: "one-time",
      schedule: { type: "once", atUtc: "2026-09-01T09:00:00.000Z" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    repository.cancelScheduledPrompt("dm:one", cancelled.id);
    repository.completeScheduledPrompt(done.id, "2026-08-30T14:30:00.000Z");

    expect(
      repository.claimScheduledPrompt(cancelled.id, "2026-08-30T14:30:00.000Z", "2026-08-30T14:20:00.000Z")
    ).toBe(false);
    expect(
      repository.claimScheduledPrompt(done.id, "2026-08-30T14:30:00.000Z", "2026-08-30T14:20:00.000Z")
    ).toBe(false);
    expect(
      repository.claimScheduledPrompt(live.id, "2026-08-30T14:30:00.000Z", "2026-08-30T14:20:00.000Z")
    ).toBe(true);
  });

  it("releases a claim so the job can be claimed and run again", () => {
    repository = new ArtemisRepository(":memory:");
    const created = repository.createScheduledPrompt("dm:one", {
      prompt: "released",
      schedule: { type: "once", atUtc: "2026-09-01T09:00:00.000Z" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });

    expect(
      repository.claimScheduledPrompt(created.id, "2026-08-30T14:30:00.000Z", "2026-08-30T14:20:00.000Z")
    ).toBe(true);
    repository.releaseScheduledPromptClaim(created.id);
    // An active job denied at run time is immediately claimable again.
    expect(
      repository.claimScheduledPrompt(created.id, "2026-08-30T14:30:01.000Z", "2026-08-30T14:20:01.000Z")
    ).toBe(true);
    // Releasing an unclaimed job is a safe no-op.
    expect(() => repository?.releaseScheduledPromptClaim("missing-id")).not.toThrow();
  });

  it("persists the claim across a repository reopen so restarts cannot double-run", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-scheduler-claim-persist-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artemis.sqlite");
    repository = new ArtemisRepository(path);
    const created = repository.createScheduledPrompt("dm:one", {
      prompt: "durable claim",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    expect(
      repository.claimScheduledPrompt(created.id, "2026-08-30T14:30:00.000Z", "2026-08-30T14:20:00.000Z")
    ).toBe(true);
    repository.close();
    repository = undefined;

    repository = new ArtemisRepository(path);
    // The claimed occurrence survives the restart and is not re-claimable
    // before its deadline.
    expect(
      repository.claimScheduledPrompt(created.id, "2026-08-30T14:31:00.000Z", "2026-08-30T14:25:00.000Z")
    ).toBe(false);
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

  it("lists active scheduled prompts across conversations for the execution engine", () => {
    repository = new ArtemisRepository(":memory:");
    const message = repository.createScheduledPrompt("dm:one", {
      prompt: "dm prompt",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    const silent = repository.createScheduledPrompt("guild:g:channel:c", {
      prompt: "guild digest",
      schedule: { type: "once", atUtc: "2026-09-01T09:00:00.000Z" },
      responseType: "silent",
      scheduledByUserId: "user-2"
    });
    repository.cancelScheduledPrompt("guild:g:channel:c", silent.id);

    const jobs = repository.listActiveScheduledPrompts();
    expect(jobs.map((job) => job.id)).toEqual([message.id]);
    expect(jobs[0]?.conversationKey).toBe("dm:one");
  });

  it("records a recurring job's last run without changing its status", () => {
    repository = new ArtemisRepository(":memory:");
    repository.createScheduledPrompt("dm:one", {
      prompt: "standup",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });

    repository.markScheduledPromptFired("missing-id", "2026-08-30T14:20:00.001Z");
    expect(repository.listScheduledPrompts("dm:one")[0]?.lastRunAt).toBeUndefined();
  });

  it("persists lastRunAt across a repository reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-scheduler-rearm-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artemis.sqlite");
    repository = new ArtemisRepository(path);
    const created = repository.createScheduledPrompt("dm:one", {
      prompt: "rearm",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "silent",
      scheduledByUserId: "user-1"
    });
    repository.markScheduledPromptFired(created.id, "2026-08-30T14:20:00.001Z");
    repository.close();
    repository = undefined;

    repository = new ArtemisRepository(path);
    const listed = repository.listScheduledPrompts("dm:one");
    expect(listed[0]?.lastRunAt).toBe("2026-08-30T14:20:00.001Z");
    expect(listed[0]?.status).toBe("active");
    expect(repository.listActiveScheduledPrompts()).toHaveLength(1);
  });

  it("completes a one-time job and removes it from active listings", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-scheduler-complete-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artemis.sqlite");
    repository = new ArtemisRepository(path);
    const created = repository.createScheduledPrompt("dm:one", {
      prompt: "one-time",
      schedule: { type: "once", atUtc: "2026-09-01T09:00:00.000Z" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });

    expect(repository.completeScheduledPrompt(created.id, "2026-08-30T14:30:00.000Z")).toBe(true);
    expect(repository.listScheduledPrompts("dm:one")).toEqual([]);
    expect(repository.listActiveScheduledPrompts()).toEqual([]);
    // Completing again is a safe no-op; the record is retained for audit.
    expect(repository.completeScheduledPrompt(created.id, "2026-08-30T14:35:00.000Z")).toBe(false);

    repository.close();
    repository = undefined;
    repository = new ArtemisRepository(path);
    expect(repository.listActiveScheduledPrompts()).toEqual([]);
  });

  it("lists completed and canceled prompts in history while active listings stay active-only", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-scheduler-history-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artemis.sqlite");
    repository = new ArtemisRepository(path);
    const done = repository.createScheduledPrompt("dm:one", {
      prompt: "once",
      schedule: { type: "once", atUtc: "2026-09-01T09:00:00.000Z" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    const cancelled = repository.createScheduledPrompt("dm:one", {
      prompt: "cancelled",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    const live = repository.createScheduledPrompt("dm:one", {
      prompt: "live",
      schedule: { type: "weekly", time: "08:00", dayOfWeek: 1, timezone: "UTC" },
      responseType: "silent",
      scheduledByUserId: "user-1"
    });
    // Pin distinct creation instants so the history order is deterministic.
    repository.close();
    const raw = new Database(path);
    raw.prepare("UPDATE scheduled_prompts SET created_at = ? WHERE id = ?")
      .run("2026-08-01T00:00:00.000Z", done.id);
    raw.prepare("UPDATE scheduled_prompts SET created_at = ? WHERE id = ?")
      .run("2026-08-02T00:00:00.000Z", cancelled.id);
    raw.prepare("UPDATE scheduled_prompts SET created_at = ? WHERE id = ?")
      .run("2026-08-03T00:00:00.000Z", live.id);
    raw.close();
    repository = new ArtemisRepository(path);
    repository.completeScheduledPrompt(done.id, "2026-08-30T14:30:00.000Z");
    expect(repository.cancelScheduledPrompt("dm:one", cancelled.id)).toBe(true);

    const history = repository.listScheduledPromptHistory("dm:one");
    expect(history.map((job) => job.id)).toEqual([done.id, cancelled.id, live.id]);
    expect(history.map((job) => job.status)).toEqual(["completed", "cancelled", "active"]);
    expect(history[0]?.completedAt).toBe("2026-08-30T14:30:00.000Z");
    expect(history[1]?.cancelledAt).toBeDefined();
    // The default listing stays active-only, and other conversations see nothing.
    expect(repository.listScheduledPrompts("dm:one").map((job) => job.id)).toEqual([live.id]);
    expect(repository.listScheduledPromptHistory("dm:two")).toEqual([]);
  });

  it("hard-prunes one scheduled prompt by id and reports what remains", () => {
    repository = new ArtemisRepository(":memory:");
    const done = repository.createScheduledPrompt("dm:one", {
      prompt: "done",
      schedule: { type: "once", atUtc: "2026-09-01T09:00:00.000Z" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    const cancelled = repository.createScheduledPrompt("dm:one", {
      prompt: "cancelled",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    const live = repository.createScheduledPrompt("dm:one", {
      prompt: "live",
      schedule: { type: "daily", time: "10:00", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    repository.completeScheduledPrompt(done.id, "2026-08-30T14:30:00.000Z");
    repository.cancelScheduledPrompt("dm:one", cancelled.id);

    const result = repository.pruneScheduledPrompts("dm:one", { kind: "id", id: cancelled.id });

    expect(result.removedIds).toEqual([cancelled.id]);
    expect(result.remainingCount).toBe(2);
    expect(repository.listScheduledPromptHistory("dm:one").map((job) => job.id).sort())
      .toEqual([done.id, live.id].sort());
  });

  it("never prunes another conversation's record or an unknown id", () => {
    repository = new ArtemisRepository(":memory:");
    const created = repository.createScheduledPrompt("dm:one", {
      prompt: "mine",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });

    expect(repository.pruneScheduledPrompts("dm:two", { kind: "id", id: created.id }).removedIds)
      .toEqual([]);
    expect(repository.pruneScheduledPrompts("dm:one", { kind: "id", id: "missing" }).removedIds)
      .toEqual([]);
    expect(repository.listScheduledPromptHistory("dm:one")).toHaveLength(1);
  });

  it("bulk-prunes records by status", () => {
    repository = new ArtemisRepository(":memory:");
    const done = repository.createScheduledPrompt("dm:one", {
      prompt: "done",
      schedule: { type: "once", atUtc: "2026-09-01T09:00:00.000Z" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    const cancelled = repository.createScheduledPrompt("dm:one", {
      prompt: "cancelled",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    const live = repository.createScheduledPrompt("dm:one", {
      prompt: "live",
      schedule: { type: "daily", time: "10:00", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    repository.completeScheduledPrompt(done.id, "2026-08-30T14:30:00.000Z");
    repository.cancelScheduledPrompt("dm:one", cancelled.id);

    const result = repository.pruneScheduledPrompts("dm:one", {
      kind: "bulk",
      statuses: ["cancelled", "completed"]
    });

    expect([...result.removedIds].sort()).toEqual([done.id, cancelled.id].sort());
    expect(result.remainingCount).toBe(1);
    expect(repository.listScheduledPromptHistory("dm:one").map((job) => job.id))
      .toEqual([live.id]);
    // The active record keeps running for the execution engine.
    expect(repository.listActiveScheduledPrompts().map((job) => job.id)).toEqual([live.id]);
  });

  it("bulk-prunes only records scheduled before the cutoff instant", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-scheduler-prune-before-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artemis.sqlite");
    repository = new ArtemisRepository(path);
    const older = repository.createScheduledPrompt("dm:one", {
      prompt: "older",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    const newer = repository.createScheduledPrompt("dm:one", {
      prompt: "newer",
      schedule: { type: "daily", time: "10:00", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    // Pin distinct creation instants so the cutoff lands strictly between them.
    repository.close();
    const raw = new Database(path);
    raw.prepare("UPDATE scheduled_prompts SET created_at = ? WHERE id = ?")
      .run("2026-08-01T00:00:00.000Z", older.id);
    raw.prepare("UPDATE scheduled_prompts SET created_at = ? WHERE id = ?")
      .run("2026-08-02T00:00:00.000Z", newer.id);
    raw.close();
    repository = new ArtemisRepository(path);

    const result = repository.pruneScheduledPrompts("dm:one", {
      kind: "bulk",
      statuses: ["active", "cancelled", "completed"],
      before: "2026-08-01T12:00:00.000Z"
    });

    expect(result.removedIds).toEqual([older.id]);
    expect(result.remainingCount).toBe(1);
    expect(repository.listScheduledPromptHistory("dm:one").map((job) => job.id))
      .toEqual([newer.id]);
  });

  it("resumes a canceled recurring job with a new schedule and clears cancel bookkeeping", () => {
    repository = new ArtemisRepository(":memory:");
    const created = repository.createScheduledPrompt("dm:one", {
      prompt: "standup",
      schedule: { type: "daily", time: "09:15", timezone: "America/Chicago" },
      responseType: "silent",
      scheduledByUserId: "user-1"
    });
    repository.markScheduledPromptFired(created.id, "2026-08-30T14:20:00.001Z");
    expect(repository.cancelScheduledPrompt("dm:one", created.id)).toBe(true);
    const originalCreatedAt =
      repository.listScheduledPromptHistory("dm:one").find((job) => job.id === created.id)?.createdAt ?? "";

    const resumed = repository.resumeScheduledPrompt("dm:one", created.id, {
      type: "weekly",
      time: "10:00",
      dayOfWeek: 1,
      timezone: "UTC"
    });

    expect(resumed).toBeDefined();
    expect(resumed?.status).toBe("active");
    expect(resumed?.cancelledAt).toBeUndefined();
    expect(resumed?.lastRunAt).toBeUndefined();
    expect(resumed?.prompt).toBe("standup");
    expect(resumed?.responseType).toBe("silent");
    expect(resumed?.scheduledByUserId).toBe("user-1");
    expect(resumed?.schedule).toEqual({ type: "weekly", time: "10:00", dayOfWeek: 1, timezone: "UTC" });
    expect((resumed?.createdAt ?? "") >= originalCreatedAt).toBe(true);
    // The resumed job is live again in both listings.
    expect(repository.listScheduledPrompts("dm:one").map((job) => job.id)).toEqual([created.id]);
    expect(repository.listActiveScheduledPrompts().map((job) => job.id)).toEqual([created.id]);
  });

  it("clears a stale claim when re-arming a cancelled record so the resumed job can fire", () => {
    repository = new ArtemisRepository(":memory:");
    const created = repository.createScheduledPrompt("dm:one", {
      prompt: "standup",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "silent",
      scheduledByUserId: "user-1"
    });
    // Claim the job, then cancel it mid-claim (the fire is still in flight),
    // then re-arm: the resume clears the stale claim too, so the resumed job
    // is immediately claimable by the engine.
    expect(repository.claimScheduledPrompt(created.id, "2026-08-30T14:30:00.000Z", "2026-08-30T14:20:00.000Z"))
      .toBe(true);
    expect(repository.cancelScheduledPrompt("dm:one", created.id)).toBe(true);

    const resumed = repository.resumeScheduledPrompt("dm:one", created.id, {
      type: "daily",
      time: "10:00",
      timezone: "UTC"
    });

    expect(resumed).toBeDefined();
    expect(
      repository.claimScheduledPrompt(created.id, "2026-08-30T14:31:00.000Z", "2026-08-30T14:30:30.000Z")
    ).toBe(true);
  });

  it("resumes with a one-time schedule stored as the UTC shape", () => {
    repository = new ArtemisRepository(":memory:");
    const created = repository.createScheduledPrompt("dm:one", {
      prompt: "comeback",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    repository.cancelScheduledPrompt("dm:one", created.id);

    const resumed = repository.resumeScheduledPrompt("dm:one", created.id, {
      type: "once",
      atUtc: "2026-09-01T14:15:00.000Z"
    });

    expect(resumed?.schedule).toEqual({ type: "once", atUtc: "2026-09-01T14:15:00.000Z" });
    expect(resumed?.status).toBe("active");
    const history = repository.listScheduledPromptHistory("dm:one");
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("active");
  });

  it("refuses to resume records that are not canceled or belong to another conversation", () => {
    repository = new ArtemisRepository(":memory:");
    const live = repository.createScheduledPrompt("dm:one", {
      prompt: "live",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    const done = repository.createScheduledPrompt("dm:one", {
      prompt: "done",
      schedule: { type: "once", atUtc: "2026-09-01T09:00:00.000Z" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    repository.completeScheduledPrompt(done.id, "2026-08-30T14:30:00.000Z");

    expect(repository.resumeScheduledPrompt("dm:one", live.id, { type: "daily", time: "11:00", timezone: "UTC" }))
      .toBeUndefined();
    expect(repository.resumeScheduledPrompt("dm:one", done.id, { type: "daily", time: "11:00", timezone: "UTC" }))
      .toBeUndefined();
    expect(repository.resumeScheduledPrompt("dm:one", "missing-id", { type: "daily", time: "11:00", timezone: "UTC" }))
      .toBeUndefined();
    expect(repository.resumeScheduledPrompt("dm:two", done.id, { type: "daily", time: "11:00", timezone: "UTC" }))
      .toBeUndefined();

    expect(repository.listScheduledPrompts("dm:one").map((job) => job.id)).toEqual([live.id]);
    expect(repository.listScheduledPromptHistory("dm:one").map((job) => job.status).sort())
      .toEqual(["active", "completed"]);
  });

  it("persists a resumed job across a repository reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-scheduler-resume-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artemis.sqlite");
    repository = new ArtemisRepository(path);
    const created = repository.createScheduledPrompt("dm:one", {
      prompt: "durable",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    repository.cancelScheduledPrompt("dm:one", created.id);
    const resumed = repository.resumeScheduledPrompt("dm:one", created.id, {
      type: "monthly",
      time: "07:30",
      dayOfMonth: 15,
      timezone: "Europe/Berlin"
    });
    expect(resumed).toBeDefined();
    repository.close();
    repository = undefined;

    repository = new ArtemisRepository(path);
    const listed = repository.listScheduledPrompts("dm:one");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe("active");
    expect(listed[0]?.schedule).toEqual({
      type: "monthly",
      time: "07:30",
      dayOfMonth: 15,
      timezone: "Europe/Berlin"
    });
    expect(listed[0]?.cancelledAt).toBeUndefined();
  });

  it("updates an ongoing job's prompt in place and preserves schedule, id, and history", () => {
    repository = new ArtemisRepository(":memory:");
    const created = repository.createScheduledPrompt("dm:one", {
      prompt: "old text",
      schedule: { type: "daily", time: "09:15", timezone: "America/Chicago" },
      responseType: "silent",
      scheduledByUserId: "user-1"
    });
    const originalCreatedAt =
      repository.listScheduledPromptHistory("dm:one").find((job) => job.id === created.id)?.createdAt ?? "";

    const updated = repository.updateScheduledPrompt("dm:one", created.id, {
      prompt: "new text"
    });

    expect(updated).toBeDefined();
    expect(updated?.id).toBe(created.id);
    expect(updated?.prompt).toBe("new text");
    expect(updated?.schedule).toEqual({ type: "daily", time: "09:15", timezone: "America/Chicago" });
    expect(updated?.responseType).toBe("silent");
    expect(updated?.scheduledByUserId).toBe("user-1");
    expect(updated?.status).toBe("active");
    expect(updated?.createdAt).toBe(originalCreatedAt);
    expect(repository.listScheduledPromptHistory("dm:one")).toHaveLength(1);
  });

  it("updates an ongoing job's schedule for every recurrence shape and preserves the prompt", async () => {
    repository = new ArtemisRepository(":memory:");
    const recurring = repository.createScheduledPrompt("dm:one", {
      prompt: "standup",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    // created_at carries millisecond precision and equal timestamps tie-break
    // randomly by UUID in the listing order; force distinct creation instants
    // so the creation-order assertion below stays deterministic.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const once = repository.createScheduledPrompt("dm:one", {
      prompt: "one-time",
      schedule: { type: "once", atUtc: "2026-09-01T14:15:00.000Z" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    // A fired recurring job keeps its fire marker across an update: the
    // engine must never re-fire the already-consumed occurrence.
    repository.markScheduledPromptFired(recurring.id, "2026-08-30T14:20:00.001Z");
    const recurringCreatedAt =
      repository.listScheduledPromptHistory("dm:one").find((job) => job.id === recurring.id)?.createdAt ?? "";

    const weekly = repository.updateScheduledPrompt("dm:one", recurring.id, {
      schedule: { type: "weekly", time: "10:00", dayOfWeek: 1, timezone: "UTC" }
    });
    expect(weekly?.schedule).toEqual({ type: "weekly", time: "10:00", dayOfWeek: 1, timezone: "UTC" });
    expect(weekly?.prompt).toBe("standup");
    expect(weekly?.lastRunAt).toBe("2026-08-30T14:20:00.001Z");
    expect(weekly?.createdAt).toBe(recurringCreatedAt);

    const daily = repository.updateScheduledPrompt("dm:one", once.id, {
      schedule: { type: "daily", time: "08:30", timezone: "Europe/Berlin" }
    });
    expect(daily?.schedule).toEqual({ type: "daily", time: "08:30", timezone: "Europe/Berlin" });
    expect(daily?.prompt).toBe("one-time");

    const monthly = repository.updateScheduledPrompt("dm:one", once.id, {
      schedule: { type: "monthly", time: "07:30", dayOfMonth: 15, timezone: "America/Chicago" }
    });
    expect(monthly?.schedule)
      .toEqual({ type: "monthly", time: "07:30", dayOfMonth: 15, timezone: "America/Chicago" });

    const oneTime = repository.updateScheduledPrompt("dm:one", once.id, {
      schedule: { type: "once", atUtc: "2026-09-15T09:00:00.000Z" }
    });
    expect(oneTime?.schedule).toEqual({ type: "once", atUtc: "2026-09-15T09:00:00.000Z" });

    const listed = repository.listScheduledPrompts("dm:one");
    expect(listed.map((job) => job.schedule)).toEqual([
      { type: "weekly", time: "10:00", dayOfWeek: 1, timezone: "UTC" },
      { type: "once", atUtc: "2026-09-15T09:00:00.000Z" }
    ]);
  });

  it("updates prompt and schedule together in one call", () => {
    repository = new ArtemisRepository(":memory:");
    const created = repository.createScheduledPrompt("dm:one", {
      prompt: "old",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "silent",
      scheduledByUserId: "user-1"
    });

    const updated = repository.updateScheduledPrompt("dm:one", created.id, {
      prompt: "new",
      schedule: { type: "weekly", time: "11:00", dayOfWeek: 3, timezone: "UTC" }
    });

    expect(updated?.prompt).toBe("new");
    expect(updated?.schedule).toEqual({ type: "weekly", time: "11:00", dayOfWeek: 3, timezone: "UTC" });
    expect(updated?.responseType).toBe("silent");
  });

  it("refuses to update records that are not ongoing or belong to another conversation", () => {
    repository = new ArtemisRepository(":memory:");
    const live = repository.createScheduledPrompt("dm:one", {
      prompt: "live",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    const done = repository.createScheduledPrompt("dm:one", {
      prompt: "done",
      schedule: { type: "once", atUtc: "2026-09-01T09:00:00.000Z" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    repository.completeScheduledPrompt(done.id, "2026-08-30T14:30:00.000Z");
    const cancelled = repository.createScheduledPrompt("dm:one", {
      prompt: "cancelled",
      schedule: { type: "daily", time: "10:00", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    repository.cancelScheduledPrompt("dm:one", cancelled.id);

    const changes = { prompt: "mutated" };
    expect(repository.updateScheduledPrompt("dm:one", "missing-id", changes)).toBeUndefined();
    expect(repository.updateScheduledPrompt("dm:two", live.id, changes)).toBeUndefined();
    expect(repository.updateScheduledPrompt("dm:one", done.id, changes)).toBeUndefined();
    expect(repository.updateScheduledPrompt("dm:one", cancelled.id, changes)).toBeUndefined();

    expect(repository.listScheduledPromptHistory("dm:one").find((job) => job.id === live.id)?.prompt)
      .toBe("live");
    expect(repository.listScheduledPromptHistory("dm:one").find((job) => job.id === done.id)?.prompt)
      .toBe("done");
    expect(repository.listScheduledPromptHistory("dm:one").find((job) => job.id === cancelled.id)?.prompt)
      .toBe("cancelled");
  });

  it("keeps an updated job as one row in active and history listings", () => {
    repository = new ArtemisRepository(":memory:");
    const created = repository.createScheduledPrompt("dm:one", {
      prompt: "before",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });

    repository.updateScheduledPrompt("dm:one", created.id, {
      prompt: "after",
      schedule: { type: "weekly", time: "10:00", dayOfWeek: 2, timezone: "UTC" }
    });

    expect(repository.listScheduledPrompts("dm:one")).toHaveLength(1);
    expect(repository.listScheduledPromptHistory("dm:one")).toHaveLength(1);
  });

  it("persists an updated job across a repository reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-scheduler-update-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artemis.sqlite");
    repository = new ArtemisRepository(path);
    const created = repository.createScheduledPrompt("dm:one", {
      prompt: "durable update",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "user-1"
    });
    const updated = repository.updateScheduledPrompt("dm:one", created.id, {
      schedule: { type: "weekly", time: "12:00", dayOfWeek: 5, timezone: "America/Chicago" }
    });
    expect(updated).toBeDefined();
    repository.close();
    repository = undefined;

    repository = new ArtemisRepository(path);
    const listed = repository.listScheduledPrompts("dm:one");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.prompt).toBe("durable update");
    expect(listed[0]?.schedule)
      .toEqual({ type: "weekly", time: "12:00", dayOfWeek: 5, timezone: "America/Chicago" });
  });

  it("applies migration 9 to a migration-8 database, preserving jobs, attribution, and history", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-migration9-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artemis.sqlite");
    repository = new ArtemisRepository(path);
    const identity = { key: "dm:legacy", kind: "dm" as const, channelId: "legacy" };
    const session = repository.getOrCreateSession(identity, "model");
    repository.insertAssistant(session.id, { text: "before", model: "model" });
    const created = repository.createScheduledPrompt("dm:legacy", {
      prompt: "legacy prompt",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "legacy-user"
    });
    repository.close();
    repository = undefined;

    // Downgrade the scheduled_prompts table to its migration-8 shape: the
    // attribution column exists, but no last_run_at column and no completed
    // status. Only migration 9 is rolled back.
    const downgrade = new Database(path);
    const rows = downgrade.prepare("SELECT * FROM scheduled_prompts").all() as Array<Record<string, unknown>>;
    downgrade.exec("DROP TABLE scheduled_prompts;");
    downgrade.exec(`
      CREATE TABLE scheduled_prompts (
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
        cancelled_at TEXT
      );
    `);
    const insert = downgrade.prepare(
      `INSERT INTO scheduled_prompts
       (id, conversation_key, prompt, schedule_type, at_utc, time_of_day,
        day_of_week, day_of_month, timezone, response_type, scheduled_by_user_id,
        status, created_at, cancelled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      insert.run(
        row.id,
        row.conversation_key,
        row.prompt,
        row.schedule_type,
        row.at_utc,
        row.time_of_day,
        row.day_of_week,
        row.day_of_month,
        row.timezone,
        row.response_type,
        row.scheduled_by_user_id,
        row.status,
        row.created_at,
        row.cancelled_at
      );
    }
    downgrade.prepare("DELETE FROM schema_migrations WHERE version = 9").run();
    downgrade.close();

    repository = new ArtemisRepository(path);
    const listed = repository.listScheduledPrompts("dm:legacy");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);
    expect(listed[0]?.scheduledByUserId).toBe("legacy-user");
    expect(listed[0]?.lastRunAt).toBeUndefined();
    expect(repository.listActiveScheduledPrompts().map((job) => job.id)).toEqual([created.id]);
    expect(repository.getHistory(session.id).map((message) => message.content)).toEqual(["before"]);

    // Re-arm bookkeeping lands in the rebuilt table and survives a reopen.
    repository.markScheduledPromptFired(created.id, "2026-08-30T14:20:00.001Z");
    repository.close();
    repository = undefined;
    repository = new ArtemisRepository(path);
    expect(repository.listScheduledPrompts("dm:legacy")[0]?.lastRunAt).toBe("2026-08-30T14:20:00.001Z");
  });

  it("applies incremental migrations 8 and 9 to a migration-7 database, attributing legacy rows and rebuilding the table", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-migration7-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artemis.sqlite");
    repository = new ArtemisRepository(path);
    const identity = { key: "dm:legacy", kind: "dm" as const, channelId: "legacy" };
    const session = repository.getOrCreateSession(identity, "model");
    repository.insertAssistant(session.id, { text: "before", model: "model" });
    const created = repository.createScheduledPrompt("dm:legacy", {
      prompt: "legacy prompt",
      schedule: { type: "daily", time: "09:15", timezone: "UTC" },
      responseType: "message",
      scheduledByUserId: "legacy-user"
    });
    repository.close();
    repository = undefined;

    // Downgrade the scheduled_prompts table to its historical migration-7
    // shape: no attribution column, no last_run_at column, and no completed
    // status. Migrations 8 and 9 are rolled back.
    const downgrade = new Database(path);
    const rows = downgrade.prepare("SELECT * FROM scheduled_prompts").all() as Array<Record<string, unknown>>;
    downgrade.exec("DROP TABLE scheduled_prompts;");
    downgrade.exec(`
      CREATE TABLE scheduled_prompts (
        id TEXT PRIMARY KEY,
        conversation_key TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule_type TEXT NOT NULL,
        at_utc TEXT,
        time_of_day TEXT,
        day_of_week INTEGER,
        day_of_month INTEGER,
        timezone TEXT,
        response_type TEXT NOT NULL CHECK (response_type IN ('message', 'silent')),
        status TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
        created_at TEXT NOT NULL,
        cancelled_at TEXT
      );
    `);
    const insert = downgrade.prepare(
      `INSERT INTO scheduled_prompts
       (id, conversation_key, prompt, schedule_type, at_utc, time_of_day,
        day_of_week, day_of_month, timezone, response_type, status, created_at, cancelled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      insert.run(
        row.id,
        row.conversation_key,
        row.prompt,
        row.schedule_type,
        row.at_utc,
        row.time_of_day,
        row.day_of_week,
        row.day_of_month,
        row.timezone,
        row.response_type,
        row.status,
        row.created_at,
        row.cancelled_at
      );
    }
    downgrade.prepare("DELETE FROM schema_migrations WHERE version IN (8, 9)").run();
    downgrade.close();

    repository = new ArtemisRepository(path);
    const listed = repository.listScheduledPrompts("dm:legacy");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);
    expect(listed[0]?.lastRunAt).toBeUndefined();
    expect(repository.listActiveScheduledPrompts().map((job) => job.id)).toEqual([created.id]);
    expect(repository.getHistory(session.id).map((message) => message.content)).toEqual(["before"]);

    const database = new Database(path, { readonly: true });
    const versions = database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: number }[];
    const columns = database.prepare("PRAGMA table_info(scheduled_prompts)").all() as {
      name: string;
    }[];
    database.close();
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(columns.map((column) => column.name)).toContain("scheduled_by_user_id");
    expect(columns.map((column) => column.name)).toContain("last_run_at");
  });
});
