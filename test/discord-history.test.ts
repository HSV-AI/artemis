import { describe, expect, it, vi } from "vitest";
import type { ChannelHistoryReadResult } from "../src/domain.js";
import {
  canonicalizeUrl,
  extractUrls,
  readChannelHistory,
  snowflakeFromTimestamp,
  type ChannelHistoryEndpoint
} from "../src/discord-history.js";

function fakeMessage(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "id-1",
    author: { id: "author-1" },
    content: "hello world",
    createdTimestamp: Date.parse("2026-08-29T14:00:00.000Z"),
    ...overrides
  };
}

/** Structural view of a discord.js Collection as returned by messages.fetch. */
interface FakePage {
  size: number;
  values: () => IterableIterator<unknown>;
}

function page(messages: unknown[]): FakePage {
  return { size: messages.length, values: () => messages.values() };
}

interface FetchCall {
  limit: number;
  before?: string;
}

function channelMock(options: {
  /** Sequential pages, one per messages.fetch call. */
  pages?: FakePage[];
  /** Error thrown by messages.fetch when pages are exhausted (or immediately). */
  fetchError?: unknown;
  permissions?: "present" | "absent" | "null" | "partial";
}): unknown & { calls: FetchCall[]; fetch: ReturnType<typeof vi.fn> } {
  const calls: FetchCall[] = [];
  const pending: FakePage[] = [...(options.pages ?? [])];
  const fetch = vi.fn(async (fetchOptions: { limit: number; before?: string }) => {
    calls.push({ limit: fetchOptions.limit, ...(fetchOptions.before ? { before: fetchOptions.before } : {}) });
    if (options.fetchError) {
      throw options.fetchError;
    }
    return pending.shift() ?? page([]);
  });
  const channel: Record<string, unknown> = { messages: { fetch } };
  if (options.permissions === "present") {
    channel.permissionsFor = (user: unknown) => ({
      has: (flag: bigint) => user === "artemis-user" && (flag === (1n << 10n) || flag === (1n << 16n))
    });
  } else if (options.permissions === "null") {
    channel.permissionsFor = () => null;
  }
  return Object.assign(channel, { calls, fetch }) as unknown as unknown & { calls: FetchCall[]; fetch: ReturnType<typeof vi.fn> };
}

function endpointMock(options: {
  channel?: unknown;
  channelError?: unknown;
  selfUserId?: string;
}): ChannelHistoryEndpoint {
  return {
    fetchChannel: vi.fn(async () => {
      if (options.channelError) {
        throw options.channelError;
      }
      return options.channel ?? null;
    }),
    selfUserId: () => options.selfUserId ?? "artemis-user"
  };
}

async function read(
  endpoint: ChannelHistoryEndpoint,
  conversationKey: string,
  query: Parameters<typeof readChannelHistory>[2] = {}
): Promise<ChannelHistoryReadResult> {
  return readChannelHistory(endpoint, conversationKey, query);
}

describe("canonicalizeUrl", () => {
  it("strips query strings and fragments so dedupe compares article identity", () => {
    expect(canonicalizeUrl("https://example.com/x?utm_source=TLDR")).toBe("https://example.com/x");
    expect(canonicalizeUrl("https://example.com/x?utm_source=TLDR#section")).toBe("https://example.com/x");
    expect(canonicalizeUrl("https://example.com/x")).toBe("https://example.com/x");
  });

  it("keeps the path verbatim", () => {
    expect(canonicalizeUrl("https://example.com/a/b/index.html")).toBe("https://example.com/a/b/index.html");
    expect(canonicalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("drops default ports and keeps non-default ports", () => {
    expect(canonicalizeUrl("https://example.com:443/x")).toBe("https://example.com/x");
    expect(canonicalizeUrl("http://example.com:80/x")).toBe("http://example.com/x");
    expect(canonicalizeUrl("https://example.com:8443/x")).toBe("https://example.com:8443/x");
  });

  it("lowercases the host", () => {
    expect(canonicalizeUrl("https://WWW.Example.COM/News")).toBe("https://www.example.com/News");
  });

  it("rejects non-HTTP schemes and unparsable text", () => {
    expect(canonicalizeUrl("mailto:someone@example.com")).toBeUndefined();
    expect(canonicalizeUrl("ftp://example.com/x")).toBeUndefined();
    expect(canonicalizeUrl("javascript:alert(1)")).toBeUndefined();
    expect(canonicalizeUrl("not a url")).toBeUndefined();
    expect(canonicalizeUrl("")).toBeUndefined();
  });
});

describe("extractUrls", () => {
  it("extracts, canonicalizes, and dedupes multiple URLs preserving first occurrence", () => {
    const content =
      "Fresh: https://example.com/a?utm_source=TLDR again https://example.com/b and https://example.com/a again";
    expect(extractUrls(content)).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("strips trailing sentence punctuation and unmatched closing brackets", () => {
    expect(extractUrls("See https://example.com/x.")).toEqual(["https://example.com/x"]);
    expect(extractUrls("(read https://example.com/x)")).toEqual(["https://example.com/x"]);
    expect(extractUrls('"posted https://example.com/x"')).toEqual(["https://example.com/x"]);
    expect(extractUrls("doc https://example.com/x]:")).toEqual(["https://example.com/x"]);
  });

  it("keeps balanced trailing parentheses inside URLs", () => {
    expect(extractUrls("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)"
    ]);
  });

  it("ignores text without an HTTP(S) scheme and non-HTTP schemes", () => {
    expect(extractUrls("bare example.com/page and mailto:list@example.com")).toEqual([]);
    expect(extractUrls("no links here at all")).toEqual([]);
  });

  it("returns an empty list for blank content", () => {
    expect(extractUrls("")).toEqual([]);
  });
});

describe("snowflakeFromTimestamp", () => {
  it("converts an ISO-8601 instant to the Discord snowflake cursor", () => {
    expect(snowflakeFromTimestamp("2015-01-01T00:00:00.001Z")).toBe("4194304");
    expect(
      snowflakeFromTimestamp("2026-08-29T14:15:00.000Z")
    ).toBe(String((1_788_012_900_000n - 1_420_070_400_000n) << 22n));
  });

  it("rejects invalid and pre-Discord-epoch instants", () => {
    expect(snowflakeFromTimestamp("not-a-timestamp")).toBeUndefined();
    expect(snowflakeFromTimestamp("2014-12-31T23:59:59.999Z")).toBeUndefined();
  });
});

describe("readChannelHistory", () => {
  const guildKey = "guild:guild-1:channel:channel-1";
  const dmKey = "dm:dm-1";

  it("returns the conversation's messages newest-first with ids, authors, timestamps, content, and canonicalized urls", async () => {
    const channel = channelMock({
      permissions: "present",
      pages: [page([
        fakeMessage({
          id: "1001",
          author: { id: "author-2" },
          content: "older https://example.com/old?utm_source=x",
          createdTimestamp: Date.parse("2026-08-29T13:00:00.000Z")
        }),
        fakeMessage({
          id: "1002",
          author: { id: "author-1" },
          content: "newer https://example.com/new",
          createdTimestamp: Date.parse("2026-08-29T14:00:00.000Z")
        })
      ])]
    });
    const endpoint = endpointMock({ channel });

    const result = await read(endpoint, guildKey, { limit: 10 });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.truncated).toBe(false);
    expect(result.messages.map((message) => message.messageId)).toEqual(["1002", "1001"]);
    expect(result.messages[0]).toEqual({
      messageId: "1002",
      authorId: "author-1",
      timestamp: "2026-08-29T14:00:00.000Z",
      content: "newer https://example.com/new",
      urls: ["https://example.com/new"]
    });
    expect(result.messages[1]?.urls).toEqual(["https://example.com/old"]);
  });

  it("verifies ViewChannel and ReadMessageHistory for a guild channel before fetching", async () => {
    const channel = {
      permissionsFor: vi.fn(() => ({
        has: (flag: bigint) => flag !== (1n << 16n) // ViewChannel yes, ReadMessageHistory no
      })),
      messages: { fetch: vi.fn() }
    };
    const endpoint = endpointMock({ channel });

    const result = await read(endpoint, guildKey);

    expect(result).toEqual({ status: "permission" });
    expect(channel.messages.fetch).not.toHaveBeenCalled();
  });

  it("fails closed when a guild channel reports no resolvable bot permissions", async () => {
    const channel = {
      permissionsFor: vi.fn(() => null),
      messages: { fetch: vi.fn() }
    };
    const result = await read(endpointMock({ channel }), guildKey);
    expect(result.status).toBe("permission");
  });

  it("reads a DM conversation without a guild permission check", async () => {
    const channel = channelMock({
      pages: [page([
        fakeMessage({ id: "2001", author: { id: "dm-user" }, content: "hi https://example.com/dm" })
      ])]
    });
    const result = await read(endpointMock({ channel }), dmKey, { limit: 5 });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.authorId).toBe("dm-user");
      expect(result.messages[0]?.urls).toEqual(["https://example.com/dm"]);
    }
    expect(channel.calls).toEqual([{ limit: 5 }]);
  });

  it("resolves an unresolvable conversation instead of defaulting to any channel", async () => {
    const unknownChannel = { code: 10003, status: 404, name: "DiscordAPIError" };
    const failed = await read(endpointMock({ channelError: unknownChannel }), guildKey);
    expect(failed.status).toBe("unresolvable");

    const nullChannel = await read(endpointMock({ channel: null }), guildKey);
    expect(nullChannel.status).toBe("unresolvable");

    const shapeless = await read(endpointMock({ channel: { id: "weird" } }), guildKey);
    expect(shapeless.status).toBe("unresolvable");

    const unparseable = await read(endpointMock({}), "not-a-harness-key");
    expect(unparseable.status).toBe("unresolvable");
  });

  it("surfaces a missing Read Message History permission from the messages fetch", async () => {
    const channel = channelMock({
      permissions: "present",
      fetchError: { code: 50013, status: 403, name: "DiscordAPIError" }
    });
    const result = await read(endpointMock({ channel }), guildKey, { limit: 5 });
    expect(result.status).toBe("permission");
  });

  it("surfaces a 403 from the messages fetch as a permission error", async () => {
    const channel = channelMock({ fetchError: { status: 403, name: "DiscordAPIError" } });
    const result = await read(endpointMock({ channel }), dmKey, { limit: 5 });
    expect(result.status).toBe("permission");
  });

  it("surfaces a Discord rate limit with a retry hint instead of partial results", async () => {
    const rateLimit = { name: "RateLimitError", timeToReset: 5_400 };
    const channel = channelMock({ fetchError: rateLimit });
    const result = await read(endpointMock({ channel }), dmKey, { limit: 5 });
    expect(result.status).toBe("rate-limited");
    if (result.status !== "rate-limited") return;
    expect(result.retryAfterSeconds).toBe(6);
  });

  it("surfaces an HTTP 429 as rate limited", async () => {
    const channel = channelMock({ fetchError: { status: 429, name: "HTTPError" } });
    const result = await read(endpointMock({ channel }), dmKey, { limit: 5 });
    expect(result.status).toBe("rate-limited");
  });

  it("returns a generic error for other failures", async () => {
    const channel = channelMock({ fetchError: new Error("network down") });
    const result = await read(endpointMock({ channel }), dmKey, { limit: 5 });
    expect(result.status).toBe("error");

    const channelFetchError = await read(
      endpointMock({ channelError: new Error("discord unreachable") }),
      dmKey
    );
    expect(channelFetchError.status).toBe("error");
  });

  it("treats an empty channel history as genuinely empty, not an error", async () => {
    const channel = channelMock({ permissions: "present", pages: [page([])] });
    const result = await read(endpointMock({ channel }), guildKey, { limit: 5 });
    expect(result).toEqual({ status: "ok", messages: [], truncated: false });
  });

  it("skips an unshapable message without failing the read", async () => {
    const channel = channelMock({
      permissions: "present",
      pages: [page([
        fakeMessage({ id: "not-a-snowflake" }),
        fakeMessage({ id: "2002", author: {}, content: "no author" }),
        fakeMessage({ id: "2001" })
      ])]
    });
    const result = await read(endpointMock({ channel }), guildKey, { limit: 10 });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.messages.map((message) => message.messageId)).toEqual(["2002", "2001"]);
    expect(result.messages[0]?.authorId).toBe("unknown");
  });

  it("pages backwards until the author filter has collected the limit", async () => {
    const pageOne = Array.from({ length: 100 }, (_, index) =>
      fakeMessage({
        id: String(2_000 - index),
        author: { id: "someone-else" },
        content: `noise ${index}`,
        createdTimestamp: 1_788_000_000_000 + (2_000 - index)
      })
    );
    const pageTwo = [
      fakeMessage({
        id: "1500",
        author: { id: "artemis-user" },
        content: "post one https://example.com/one",
        createdTimestamp: Date.parse("2026-08-28T12:00:00.000Z")
      }),
      fakeMessage({
        id: "1400",
        author: { id: "artemis-user" },
        content: "post two https://example.com/two",
        createdTimestamp: Date.parse("2026-08-28T11:00:00.000Z")
      })
    ];
    const channel = channelMock({ permissions: "present", pages: [page(pageOne), page(pageTwo)] });
    const result = await read(endpointMock({ channel }), guildKey, { limit: 2, authorId: "artemis-user" });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.messages.map((message) => message.messageId)).toEqual(["1500", "1400"]);
    expect(result.truncated).toBe(false);
    expect(channel.calls[0]).toEqual({ limit: 100 });
    // The cursor is the oldest raw message id scanned on the page.
    expect(channel.calls[1]?.before).toBe("1901");
  });

  it("marks the scan truncated when the page budget exhausts before reaching the limit", async () => {
    // Ten full pages (the scan budget) of messages by another author.
    const pages = Array.from({ length: 10 }, (_, pageIndex) =>
      Array.from({ length: 100 }, (_, index) => {
        const idNumber = 100_000 - pageIndex * 100 - index;
        return fakeMessage({
          id: String(idNumber),
          author: { id: "someone-else" },
          content: "noise",
          createdTimestamp: 1_788_000_000_000 - (100_000 - idNumber)
        });
      })
    );
    const channel = channelMock({ permissions: "present", pages: pages.map(page) });
    const result = await read(endpointMock({ channel }), guildKey, { limit: 3, authorId: "artemis-user" });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.messages).toHaveLength(0);
    expect(result.truncated).toBe(true);
    expect(channel.calls).toHaveLength(10);
  });

  it("uses a message-id or timestamp before cursor to bound the range", async () => {
    const channel = channelMock({
      pages: [page([fakeMessage({ id: "900", author: { id: "author-1" }, content: "hi" })])]
    });
    await read(endpointMock({ channel }), dmKey, { limit: 5, before: "1000" });
    expect(channel.calls).toEqual([{ limit: 5, before: "1000" }]);

    const timestampChannel = channelMock({
      pages: [page([fakeMessage({ id: "800", author: { id: "author-1" }, content: "hi" })])]
    });
    await read(endpointMock({ channel: timestampChannel }), dmKey, { limit: 5, before: "2015-01-01T00:00:00.001Z" });
    expect(timestampChannel.calls).toEqual([{ limit: 5, before: "4194304" }]);
  });

  it("returns an error for an invalid before cursor without touching Discord", async () => {
    const channel = channelMock({ permissions: "present", pages: [] });
    const result = await read(endpointMock({ channel }), dmKey, { limit: 5, before: "yesterday-ish" });
    expect(result.status).toBe("error");
    expect(channel.fetch).not.toHaveBeenCalled();
  });

  it("returns disjoint sets for two different conversations", async () => {
    const guildChannel = channelMock({
      permissions: "present",
      pages: [page([fakeMessage({ id: "3001", author: { id: "guild-user" }, content: "guild msg" })])]
    });
    const dmChannel = channelMock({
      pages: [page([fakeMessage({ id: "3002", author: { id: "dm-user" }, content: "dm msg" })])]
    });
    const guildResult = await read(endpointMock({ channel: guildChannel }), guildKey);
    const dmResult = await read(endpointMock({ channel: dmChannel }), dmKey);

    expect(guildResult.status).toBe("ok");
    expect(dmResult.status).toBe("ok");
    if (guildResult.status === "ok" && dmResult.status === "ok") {
      expect(guildResult.messages.map((message) => message.messageId)).toEqual(["3001"]);
      expect(dmResult.messages.map((message) => message.messageId)).toEqual(["3002"]);
      expect(guildResult.messages.some((message) => message.messageId === "3002")).toBe(false);
      expect(dmResult.messages.some((message) => message.messageId === "3001")).toBe(false);
    }
  });
});