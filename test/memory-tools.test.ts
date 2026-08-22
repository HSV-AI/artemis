import { describe, expect, it, vi } from "vitest";
import type { MemoryFact, MemoryStore } from "../src/dgraph-memory.js";
import { createMemoryTools, memoryToolInternals } from "../src/memory-tools.js";

const context = {
  scopeKey: "guild:guild:channel:channel",
  authorId: "discord-user",
  sourceMessageId: "discord-message"
};

function memoryMock(): MemoryStore {
  return {
    remember: vi.fn().mockResolvedValue("0x1"),
    supersede: vi.fn().mockResolvedValue("0x2"),
    forget: vi.fn().mockResolvedValue(undefined),
    retrieveCurrent: vi.fn().mockResolvedValue([]),
    believedAt: vi.fn().mockResolvedValue([]),
    listScope: vi.fn().mockResolvedValue([])
  };
}

describe("Wartermis memory tools", () => {
  it("registers the complete explicit memory tool set", () => {
    expect(createMemoryTools(memoryMock(), context).map((tool) => tool.name)).toEqual([
      "memory_remember",
      "memory_recall",
      "memory_supersede",
      "memory_forget",
      "memory_believed_at",
      "memory_audit"
    ]);
  });

  it("binds writes to the current Discord scope and provenance", async () => {
    const memory = memoryMock();
    const [remember, , supersede, forget] = createMemoryTools(memory, context);

    await remember.execute(
      "call",
      { statement: "The user prefers concise answers.", subject: "user.response-style" },
      undefined,
      undefined,
      {} as Parameters<typeof remember.execute>[4]
    );
    expect(memory.remember).toHaveBeenCalledWith({
      scopeKey: context.scopeKey,
      statement: "The user prefers concise answers.",
      subject: "user.response-style",
      author: context.authorId,
      sourceMessageId: context.sourceMessageId
    });

    await supersede.execute(
      "call",
      { old_uid: "0x1", statement: "The user prefers detailed answers." },
      undefined,
      undefined,
      {} as Parameters<typeof supersede.execute>[4]
    );
    expect(memory.supersede).toHaveBeenCalledWith(
      context.scopeKey,
      "0x1",
      expect.objectContaining({
        scopeKey: context.scopeKey,
        author: context.authorId,
        sourceMessageId: context.sourceMessageId
      })
    );

    await forget.execute(
      "call",
      { uid: "0x2" },
      undefined,
      undefined,
      {} as Parameters<typeof forget.execute>[4]
    );
    expect(memory.forget).toHaveBeenCalledWith(context.scopeKey, "0x2");
  });

  it("binds current, historical, and audit reads to the current scope", async () => {
    const fact: MemoryFact = {
      uid: "0x1",
      statement: "The user prefers concise answers.",
      scope_key: context.scopeKey,
      recorded_at: "2026-08-22T12:00:00.000Z"
    };
    const memory = memoryMock();
    vi.mocked(memory.retrieveCurrent).mockResolvedValue([fact]);
    const [, recall, , , believedAt, audit] = createMemoryTools(memory, context);

    const recalled = await recall.execute(
      "call", {}, undefined, undefined, {} as Parameters<typeof recall.execute>[4]
    );
    expect(recalled.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("0x1") });
    expect(recalled.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("BEGIN USER MEMORY DATA")
    });
    expect(memory.retrieveCurrent).toHaveBeenCalledWith(context.scopeKey);

    await believedAt.execute(
      "call",
      { at: "2026-08-22T12:30:00.000Z" },
      undefined,
      undefined,
      {} as Parameters<typeof believedAt.execute>[4]
    );
    expect(memory.believedAt).toHaveBeenCalledWith(
      context.scopeKey,
      new Date("2026-08-22T12:30:00.000Z")
    );

    await audit.execute(
      "call", {}, undefined, undefined, {} as Parameters<typeof audit.execute>[4]
    );
    expect(memory.listScope).toHaveBeenCalledWith(context.scopeKey);
  });

  it("formats empty, superseded, and forgotten results", () => {
    expect(memoryToolInternals.factsResult([], context.scopeKey).content[0]?.text).toContain(
      "No facts"
    );
    expect(memoryToolInternals.formatFact({
      uid: "0x2",
      statement: "replacement",
      scope_key: context.scopeKey,
      recorded_at: "2026-08-22T13:00:00.000Z",
      expired_at: "2026-08-22T14:00:00.000Z",
      ended_reason: "forgotten",
      supersedes: { uid: "0x1" }
    })).toContain("(supersedes 0x1) [forgotten 2026-08-22T14:00:00.000Z]");
  });
});
