import { describe, expect, it, vi } from "vitest";
import {
  DgraphClient,
  GraphMemory,
  dgraphMemoryInternals
} from "../src/dgraph-memory.js";
import type { DgraphHttpError, NoveltyError } from "../src/dgraph-memory.js";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function accessToken(expiresAt = Date.now() + 60_000): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.ceil(expiresAt / 1_000) })).toString("base64url");
  return `header.${payload}.signature`;
}

const input = {
  scopeKey: "dm:channel",
  statement: "The user prefers concise answers.",
  author: "discord-user",
  sourceMessageId: "discord-message"
};

describe("DgraphClient", () => {
  it("sends schema, query, mutation, and upsert requests through the HTTP API", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: {} }))
      .mockResolvedValueOnce(jsonResponse({ data: { facts: [] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { uids: { fact: "0x1" } } }))
      .mockResolvedValueOnce(jsonResponse({
        data: { uids: { fact: "0x2" }, queries: { found: [{ uid: "0x1" }] } }
      }));
    const client = new DgraphClient("http://dgraph:8080", fetchMock);

    await client.alter("name: string .");
    await expect(client.query("query {}", { $scope: "scope" })).resolves.toEqual({ facts: [] });
    await expect(client.mutate([{ uid: "_:fact" }])).resolves.toEqual({ fact: "0x1" });
    await expect(client.upsert("query {}", [{ set: [{ uid: "_:fact" }] }])).resolves.toEqual({
      uids: { fact: "0x2" },
      queries: { found: [{ uid: "0x1" }] }
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "http://dgraph:8080/alter", {
      method: "POST",
      headers: { "Content-Type": "application/dql" },
      body: "name: string ."
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "http://dgraph:8080/query?ro=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query {}", variables: { $scope: "scope" } })
    });
  });

  it("authenticates once and sends the namespace JWT on concurrent requests", async () => {
    const token = accessToken();
    const fetchMock = vi.fn().mockImplementation(async (input: URL | RequestInfo) =>
      String(input).endsWith("/admin")
        ? jsonResponse({ data: { login: { response: { accessJWT: token } } } })
        : jsonResponse({ data: { facts: [] } })
    );
    const client = new DgraphClient("http://dgraph:8080", fetchMock, {
      username: "reader",
      password: "secret",
      namespace: 7
    });

    await Promise.all([client.query("query one {}"), client.query("query two {}")]);

    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/admin"))).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith("http://dgraph:8080/admin", expect.objectContaining({
      body: expect.stringContaining("namespace: 7")
    }));
    expect(fetchMock).toHaveBeenCalledWith("http://dgraph:8080/query?ro=true", expect.objectContaining({
      headers: expect.objectContaining({ "X-Dgraph-AccessToken": token })
    }));
  });

  it("logs in again and retries once after an unauthorized response", async () => {
    const firstToken = accessToken();
    const secondToken = accessToken(Date.now() + 120_000);
    let loginCount = 0;
    let queryCount = 0;
    const fetchMock = vi.fn().mockImplementation(async (input: URL | RequestInfo) => {
      if (String(input).endsWith("/admin")) {
        loginCount += 1;
        return jsonResponse({
          data: { login: { response: { accessJWT: loginCount === 1 ? firstToken : secondToken } } }
        });
      }
      queryCount += 1;
      return queryCount === 1
        ? jsonResponse({ errors: [{ message: "unauthorized" }] }, 401)
        : jsonResponse({ data: { facts: [] } });
    });
    const client = new DgraphClient("http://dgraph:8080", fetchMock, {
      username: "reader",
      password: "secret",
      namespace: 1
    });

    await expect(client.query("query {}", {})).resolves.toEqual({ facts: [] });
    expect(loginCount).toBe(2);
    expect(queryCount).toBe(2);
  });

  it.each([
    ["HTTP failure", new Response("offline", { status: 503 }), "503"],
    ["GraphQL failure", jsonResponse({ errors: [{ message: "denied" }] }), "denied"],
    ["missing token", jsonResponse({ data: { login: { response: {} } } }), "no access token"]
  ])("reports %s during login", async (_case, loginResponse, message) => {
    const client = new DgraphClient(
      "http://dgraph:8080",
      vi.fn().mockResolvedValue(loginResponse),
      { username: "reader", password: "secret", namespace: 1 }
    );

    await expect(client.query("query {}")).rejects.toThrow(message);
  });

  it("reports HTTP and Dgraph response errors", async () => {
    const httpClient = new DgraphClient(
      "http://dgraph:8080",
      vi.fn().mockResolvedValue(new Response("offline", { status: 503 }))
    );
    await expect(httpClient.alter("schema")).rejects.toMatchObject({
      operation: "/alter",
      status: 503,
      body: "offline"
    } satisfies Partial<DgraphHttpError>);

    const dgraphClient = new DgraphClient(
      "http://dgraph:8080",
      vi.fn().mockResolvedValue(jsonResponse({ errors: [{ message: "bad query" }] }))
    );
    await expect(dgraphClient.query("bad", {})).rejects.toThrow("bad query");
  });
});

describe("GraphMemory", () => {
  it("initializes the schema, remembers facts, and retrieves current facts", async () => {
    const fact = {
      uid: "0x1",
      statement: input.statement,
      scope_key: input.scopeKey,
      recorded_at: "2026-08-22T12:00:00.000Z"
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: {} }))
      .mockResolvedValueOnce(jsonResponse({ data: { facts: [] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { uids: { fact: "0x1" } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { facts: [fact] } }));
    const memory = new GraphMemory(
      new DgraphClient("http://dgraph:8080", fetchMock),
      () => new Date("2026-08-22T12:00:00.000Z")
    );

    await memory.initialize();
    await expect(memory.remember({ ...input, subject: "user.response-style" })).resolves.toBe("0x1");
    await expect(memory.retrieveCurrent(input.scopeKey)).resolves.toEqual([fact]);

    const mutationBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as {
      set: Record<string, unknown>[];
    };
    expect(mutationBody.set[0]).toMatchObject({
      statement: input.statement,
      scope_key: input.scopeKey,
      subject: "user.response-style",
      author: input.author,
      source_message_id: input.sourceMessageId,
      valid_from: "2026-08-22T12:00:00.000Z",
      recorded_at: "2026-08-22T12:00:00.000Z"
    });
  });

  it("supersedes and forgets only active facts in the requested scope", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        data: { uids: { fact: "0x2" }, queries: { found: [{ uid: "0x1" }] } }
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: { queries: { found: [{ uid: "0x2" }] } }
      }));
    const memory = new GraphMemory(
      new DgraphClient("http://dgraph:8080", fetchMock),
      () => new Date("2026-08-22T13:00:00.000Z")
    );

    await expect(memory.supersede(input.scopeKey, "0x1", {
      ...input,
      statement: "The user prefers detailed answers."
    })).resolves.toBe("0x2");
    await expect(memory.forget(input.scopeKey, "0x2")).resolves.toBeUndefined();

    const supersedeBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      query: string;
      mutations: { set: Record<string, unknown>[] }[];
    };
    expect(supersedeBody.query).toContain('eq(scope_key, "dm:channel")');
    expect(supersedeBody.mutations[0]?.set).toEqual(expect.arrayContaining([
      expect.objectContaining({ uid: "uid(target)", ended_reason: "superseded" }),
      expect.objectContaining({ uid: "_:fact", supersedes: { uid: "uid(target)" } })
    ]));
  });

  it("queries historical and complete memory", async () => {
    const fact = {
      uid: "0x1",
      statement: input.statement,
      scope_key: input.scopeKey,
      recorded_at: "2026-08-22T12:00:00.000Z"
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { facts: [fact] } }))
      .mockResolvedValueOnce(jsonResponse({ data: {} }));
    const memory = new GraphMemory(new DgraphClient("http://dgraph:8080", fetchMock));

    await expect(
      memory.believedAt(input.scopeKey, new Date("2026-08-22T12:30:00.000Z"))
    ).resolves.toEqual([fact]);
    await expect(memory.listScope(input.scopeKey)).resolves.toEqual([]);
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain("2026-08-22T12:30:00.000Z");
  });

  it("rejects invalid writes, UIDs, scopes, and missing mutation results", async () => {
    const emptyMutation = new GraphMemory(
      new DgraphClient(
        "http://dgraph:8080",
        vi.fn().mockImplementation(async () => jsonResponse({ data: {} }))
      )
    );
    await expect(emptyMutation.remember({ ...input, statement: " " })).rejects.toThrow("statement");
    await expect(emptyMutation.remember({ ...input, scopeKey: " " })).rejects.toThrow("scope key");
    await expect(emptyMutation.remember({ ...input, author: " " })).rejects.toThrow("author");
    await expect(emptyMutation.remember({ ...input, sourceMessageId: " " })).rejects.toThrow("source message ID");
    await expect(emptyMutation.remember(input)).rejects.toThrow("returned no uid");
    await expect(emptyMutation.forget(input.scopeKey, "not-a-uid")).rejects.toThrow("Invalid Dgraph fact uid");
    await expect(emptyMutation.supersede(input.scopeKey, "0x1", {
      ...input,
      scopeKey: "dm:other"
    })).rejects.toThrow("does not match");

    const inactive = new GraphMemory(
      new DgraphClient("http://dgraph:8080", vi.fn().mockImplementation(async () => jsonResponse({
        data: { queries: { found: [] } }
      })))
    );
    await expect(inactive.forget(input.scopeKey, "0x1")).rejects.toThrow("not an active fact");
    await expect(inactive.supersede(input.scopeKey, "0x1", input)).rejects.toThrow("not an active fact");
  });

  it("refuses duplicate and similar facts unless a similar fact is forced", async () => {
    const existing = {
      uid: "0x1",
      statement: "The deployment window starts Thursday for the release team.",
      scope_key: input.scopeKey,
      recorded_at: "2026-08-22T12:00:00.000Z"
    };
    const duplicateMemory = new GraphMemory(new DgraphClient(
      "http://dgraph:8080",
      vi.fn().mockResolvedValueOnce(jsonResponse({ data: { facts: [existing] } }))
    ));

    await expect(duplicateMemory.remember({
      ...input,
      statement: existing.statement
    })).rejects.toMatchObject({
      verdict: "duplicate",
      matchUid: "0x1"
    } satisfies Partial<NoveltyError>);

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { facts: [existing] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { uids: { fact: "0x2" } } }));
    const similarMemory = new GraphMemory(new DgraphClient("http://dgraph:8080", fetchMock));
    await expect(similarMemory.remember({
      ...input,
      statement: "The deployment window starts Friday for the release team.",
      allowSimilar: true
    })).resolves.toBe("0x2");
  });

  it("fuses full-text, graph, and recency retrieval deterministically", async () => {
    const fulltext = {
      uid: "0x1",
      statement: "The release train leaves Tuesday.",
      scope_key: input.scopeKey,
      recorded_at: "2026-08-22T13:00:00.000Z"
    };
    const related = {
      uid: "0x2",
      statement: "Release tickets close Monday.",
      scope_key: input.scopeKey,
      recorded_at: "2026-08-22T12:00:00.000Z"
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { facts: [fulltext] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { entities: [{ related: [related] }] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { facts: [fulltext, related] } }));
    const memory = new GraphMemory(new DgraphClient("http://dgraph:8080", fetchMock));

    const ranked = await memory.searchRanked(input.scopeKey, "release train", {
      episodeId: "session-1"
    });

    expect(ranked[0]).toMatchObject({
      fact: { uid: "0x1" },
      channels: ["fulltext", "recency"]
    });
    expect(ranked[1]).toMatchObject({
      fact: { uid: "0x2" },
      channels: ["graph", "recency"]
    });
  });

  it("returns episode and entity facts and deduplicates graph search results", async () => {
    const fact = {
      uid: "0x4",
      statement: "The release team uses a weekly deployment window.",
      scope_key: input.scopeKey,
      recorded_at: "2026-08-22T12:00:00.000Z"
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { episodes: [{ facts: [fact] }, {}] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { entities: [{ facts: [fact] }, {}] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { facts: [] } }))
      .mockResolvedValueOnce(jsonResponse({ data: {
        entities: [{ related: [fact] }, { related: [fact] }]
      } }))
      .mockResolvedValueOnce(jsonResponse({ data: { facts: [] } }));
    const memory = new GraphMemory(new DgraphClient("http://dgraph:8080", fetchMock));

    await expect(memory.factsForEpisode(input.scopeKey, "session-1")).resolves.toEqual([fact]);
    await expect(memory.factsAboutEntity(input.scopeKey, "release team")).resolves.toEqual([fact]);
    await expect(memory.searchRanked(input.scopeKey, "deployment", { episodeId: "session-1" }))
      .resolves.toEqual([expect.objectContaining({ fact, channels: ["graph"] })]);
  });

  it("rejects blank searches", async () => {
    const memory = new GraphMemory(
      new DgraphClient("http://dgraph:8080", vi.fn())
    );

    await expect(memory.searchRanked(input.scopeKey, " ")).rejects.toThrow("requires a query");
  });

  it("escapes DQL string literals and validates Dgraph UIDs", () => {
    expect(dgraphMemoryInternals.dqlString('scope"\\value')).toBe('"scope\\"\\\\value"');
    expect(dgraphMemoryInternals.validatedUid("0xABC123")).toBe("0xABC123");
  });
});
