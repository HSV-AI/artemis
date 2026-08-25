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

  it("bootstraps a fresh empty database with the current schema and migrations 1 through 5", () => {
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

    expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5]);
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

  it("starts a verified migration-5 database without modification or conversion work", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-steady-state-"));
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
    repository.close();
    repository = undefined;

    const before = new Database(path, { readonly: true });
    const beforeVersions = before
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: number }[];
    const beforeMessages = before
      .prepare("SELECT content FROM messages ORDER BY id")
      .all() as { content: string }[];
    before.close();

    repository = new ArtemisRepository(path);
    expect(repository.getHistory(session.id).map((message) => message.content)).toEqual(
      beforeMessages.map((row) => row.content)
    );
    repository.close();
    repository = undefined;

    const after = new Database(path, { readonly: true });
    const afterVersions = after
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: number }[];
    after.close();

    expect(beforeVersions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5]);
    expect(afterVersions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5]);
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
});
