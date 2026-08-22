import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import Database from "better-sqlite3";
import type { PiSessionStore, SourceMessage, StoredMessage } from "../src/domain.js";
import {
  importLegacyPiSessions,
  piSessionInternals,
  SqlitePiSessionManager
} from "../src/pi-session-manager.js";
import { ArtemisRepository } from "../src/repository.js";

const exactUsage: Usage = {
  input: 120,
  output: 30,
  cacheRead: 10,
  cacheWrite: 0,
  totalTokens: 160,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0, total: 3.1 }
};

function user(content: string, timestamp = Date.now()): UserMessage {
  return { role: "user", content, timestamp };
}

function assistant(
  content: AssistantMessage["content"],
  usage: Usage = exactUsage,
  stopReason: AssistantMessage["stopReason"] = "stop"
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    usage,
    stopReason,
    timestamp: Date.now()
  };
}

function createSession(repository: ArtemisRepository, channelId = "channel") {
  return repository.getOrCreateSession(
    { key: `dm:${channelId}`, kind: "dm", channelId },
    "test-model"
  );
}

describe("SqlitePiSessionManager", () => {
  const repositories: ArtemisRepository[] = [];
  afterEach(() => {
    while (repositories.length > 0) repositories.pop()?.close();
  });

  it("preserves native usage, tool results, compaction, and parent relationships across restart", () => {
    const path = join(mkdtempSync(join(tmpdir(), "artemis-pi-session-")), "artemis.sqlite");
    const firstRepository = new ArtemisRepository(path);
    repositories.push(firstRepository);
    const session = createSession(firstRepository);
    const first = SqlitePiSessionManager.open(firstRepository, "/app", session.id);

    const userId = first.appendMessage(user("research this"));
    const toolCallId = first.appendMessage(
      assistant(
        [{ type: "toolCall", id: "call-1", name: "web_fetch", arguments: { url: "https://example.com" } }],
        exactUsage,
        "toolUse"
      )
    );
    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "web_fetch",
      content: [{ type: "text", text: "result" }],
      isError: false,
      timestamp: Date.now()
    };
    const resultId = first.appendMessage(toolResult);
    const finalId = first.appendMessage(assistant([{ type: "text", text: "done" }]));
    first.appendCompaction("summary", userId, 1000, { source: "test" }, false, exactUsage);

    expect(first.getEntry(toolCallId)?.parentId).toBe(userId);
    expect(first.getEntry(resultId)?.parentId).toBe(toolCallId);
    expect(first.getEntry(finalId)?.parentId).toBe(resultId);
    firstRepository.close();
    repositories.pop();

    const secondRepository = new ArtemisRepository(path);
    repositories.push(secondRepository);
    const restored = SqlitePiSessionManager.open(secondRepository, "/app", session.id);
    const entries = restored.getEntries();
    const restoredAssistant = entries.find(
      (entry) => entry.type === "message" && entry.message.role === "assistant" && entry.id === finalId
    );

    expect(restored.getHistoryCompleteness()).toBe("complete");
    expect(restoredAssistant).toMatchObject({
      message: { usage: exactUsage, content: [{ type: "text", text: "done" }] }
    });
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "message", message: expect.objectContaining({ role: "toolResult" }) }),
        expect.objectContaining({
          type: "compaction",
          summary: "summary",
          tokensBefore: 1000,
          usage: exactUsage
        })
      ])
    );
    expect(secondRepository.loadPiSession(session.id)?.rawEntries).toHaveLength(entries.length + 1);
  });

  it("keeps a closed session archived and starts its replacement with empty PI context", () => {
    const repository = new ArtemisRepository(":memory:");
    repositories.push(repository);
    const firstSession = createSession(repository, "clear");
    const firstManager = SqlitePiSessionManager.open(repository, "/app", firstSession.id);
    firstManager.appendMessage(user("old context"));

    expect(repository.clearActiveSession("dm:clear")).toMatchObject({
      cleared: true,
      sessionId: firstSession.id
    });
    const secondSession = createSession(repository, "clear");
    const secondManager = SqlitePiSessionManager.open(repository, "/app", secondSession.id);

    expect(secondSession.id).not.toBe(firstSession.id);
    expect(secondManager.buildSessionContext().messages).toEqual([]);
    expect(repository.loadPiSession(firstSession.id)?.rawEntries).toHaveLength(2);
  });

  it("does not advance in-memory state when a SQLite append fails", () => {
    const store: PiSessionStore = {
      loadPiSession: vi.fn(() => undefined),
      createPiSession: vi.fn(),
      appendPiSessionEntry: vi.fn(() => {
        throw new Error("database unavailable");
      }),
      replacePiSessionEntries: vi.fn(),
      listLegacyPiSessions: vi.fn(() => [])
    };
    const manager = SqlitePiSessionManager.open(store, "/app", "session");

    expect(() => manager.appendMessage(user("not persisted"))).toThrow("database unavailable");
    expect(manager.getEntries()).toEqual([]);
  });

  it("supports native metadata, labels, and branches on the persisted tree", () => {
    const repository = new ArtemisRepository(":memory:");
    repositories.push(repository);
    const session = createSession(repository, "tree");
    const manager = SqlitePiSessionManager.open(repository, "/app", session.id);

    expect(manager.isPersisted()).toBe(true);
    expect(manager.getCwd()).toBe("/app");
    expect(manager.getSessionDir()).toBe("");
    expect(manager.usesDefaultSessionDir()).toBe(false);
    expect(manager.getSessionId()).toBe(session.id);
    expect(manager.getSessionFile()).toBeUndefined();
    expect(manager.getHeader()).toMatchObject({ type: "session", id: session.id });

    const rootId = manager.appendMessage(user("root"));
    manager.appendSessionInfo("  Tree\nSession  ");
    expect(manager.getSessionName()).toBe("Tree Session");
    const customId = manager.appendCustomEntry("artemis.test", { retained: true });
    const customMessageId = manager.appendCustomMessageEntry(
      "artemis.context",
      "extra context",
      false,
      { retained: true }
    );
    manager.appendLabelChange(rootId, "checkpoint");
    expect(manager.getLabel(rootId)).toBe("checkpoint");
    expect(manager.getLeafEntry()?.type).toBe("label");
    expect(manager.getChildren(customId).map((entry) => entry.id)).toEqual([customMessageId]);

    manager.branch(rootId);
    const branchId = manager.appendMessage(user("branch"));
    const summaryId = manager.branchWithSummary(rootId, "other path", { retained: true }, true, exactUsage);
    expect(manager.getBranch(branchId).map((entry) => entry.id)).toEqual([rootId, branchId]);
    expect(manager.getEntry(summaryId)).toMatchObject({
      type: "branch_summary",
      fromId: rootId,
      usage: exactUsage
    });
    expect(manager.getTree()).toHaveLength(1);
    expect(manager.buildContextEntries().length).toBeGreaterThan(0);

    manager.appendLabelChange(rootId, undefined);
    expect(manager.getLabel(rootId)).toBeUndefined();
    manager.resetLeaf();
    expect(manager.getLeafId()).toBeNull();
  });

  it("migrates older raw PI entry versions and rewrites them transactionally", () => {
    const repository = new ArtemisRepository(":memory:");
    repositories.push(repository);
    const session = createSession(repository, "migration");
    repository.createPiSession(session.id, "complete", [
      {
        entryType: "session",
        rawJson: JSON.stringify({
          type: "session",
          version: 2,
          id: session.id,
          timestamp: "2026-08-20T00:00:00.000Z",
          cwd: "/app"
        })
      },
      {
        entryId: "entry001",
        entryType: "message",
        rawJson: JSON.stringify({
          type: "message",
          id: "entry001",
          parentId: null,
          timestamp: "2026-08-20T00:00:01.000Z",
          message: {
            role: "hookMessage",
            customType: "legacy-hook",
            content: "context",
            display: false,
            timestamp: 1
          }
        })
      }
    ]);

    SqlitePiSessionManager.open(repository, "/app", session.id);

    const rewritten = repository.loadPiSession(session.id)?.rawEntries.map((raw) => JSON.parse(raw));
    expect(rewritten?.[0]).toMatchObject({ type: "session", version: 3 });
    expect(rewritten?.[1]).toMatchObject({ message: { role: "custom" } });
  });

  it("rejects a non-contiguous native entry sequence", () => {
    const path = join(mkdtempSync(join(tmpdir(), "artemis-pi-corrupt-")), "artemis.sqlite");
    const repository = new ArtemisRepository(path);
    repositories.push(repository);
    const session = createSession(repository, "corrupt");
    SqlitePiSessionManager.open(repository, "/app", session.id).appendMessage(user("saved"));
    repository.close();
    repositories.pop();

    const database = new Database(path);
    database
      .prepare(
        `UPDATE pi_session_entries
         SET ordinal = 2
         WHERE session_id = ? AND ordinal = 1`
      )
      .run(session.id);
    database.close();

    const reopened = new ArtemisRepository(path);
    repositories.push(reopened);
    expect(() => reopened.loadPiSession(session.id)).toThrow(
      `PI session entry sequence is incomplete: ${session.id}`
    );
  });
});

describe("legacy PI session import", () => {
  let repository: ArtemisRepository | undefined;
  afterEach(() => repository?.close());

  it("imports once, marks the history incomplete, and preserves speaker attribution", () => {
    repository = new ArtemisRepository(":memory:");
    const session = createSession(repository, "legacy");
    const source: SourceMessage = {
      discordMessageId: "legacy-user",
      authorId: "user-1",
      authorName: "Legacy User",
      role: "user",
      content: "remember me",
      createdAt: "2026-08-20T10:00:00.000Z"
    };
    repository.insertSourceMessages(session.id, [source]);
    repository.insertAssistant(session.id, {
      text: "remembered",
      reasoning: "legacy reasoning",
      diagnostics: [{ type: "trace", timestamp: 1 }],
      model: "saved-model"
    });

    expect(importLegacyPiSessions(repository, "/app", "test-provider", "fallback-model")).toBe(1);
    expect(importLegacyPiSessions(repository, "/app", "test-provider", "fallback-model")).toBe(0);

    const persisted = repository.loadPiSession(session.id);
    expect(persisted?.historyCompleteness).toBe("legacy_import_incomplete");
    expect(persisted?.rawEntries.map((raw) => JSON.parse(raw))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "custom",
          customType: "artemis.legacy_import",
          data: expect.objectContaining({ historyCompleteness: "legacy_import_incomplete" })
        }),
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({
            role: "user",
            content: expect.stringContaining('"author":{"id":"user-1","name":"Legacy User"}')
          })
        }),
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({
            role: "assistant",
            model: "saved-model",
            usage: expect.objectContaining({ totalTokens: 0 })
          })
        })
      ])
    );
    expect(repository.listLegacyPiSessions()).toEqual([]);
  });

  it("keeps the legacy converter isolated from normal native-session writes", () => {
    const legacyMessage: StoredMessage = {
      id: 1,
      sessionId: "legacy",
      discordMessageId: "message",
      authorId: "user",
      authorName: "User",
      role: "assistant",
      content: "answer",
      createdAt: "2026-08-20T10:00:00.000Z"
    };
    expect(
      piSessionInternals.legacyStoredToPiMessage(legacyMessage, "provider", "fallback")
    ).toMatchObject({ role: "assistant", usage: { totalTokens: 0 } });
  });
});
