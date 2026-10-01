import type {
  ChannelHistoryMessage,
  ChannelHistoryQuery,
  ChannelHistoryReadResult
} from "./domain.js";
import { parseConversationKey } from "./scheduler-authorization.js";

/**
 * Read-only Discord message history for the current conversation.
 *
 * The conversation is resolved from the immutable harness-derived conversation
 * key (`dm:<channel-id>` or `guild:<guild-id>:channel:<channel-id>`), never
 * from a tool parameter, so there is no expressible way to read another
 * channel, another user's DM, or an enumerated conversation list. A
 * conversation that cannot be resolved on Discord returns an explicit
 * `unresolvable` status instead of falling back to any default channel.
 */

/** Discord's ViewChannel permission bit (PermissionsBitField.Flags.ViewChannel). */
const VIEW_CHANNEL_FLAG = 1n << 10n;
/** Discord's ReadMessageHistory permission bit (PermissionsBitField.Flags.ReadMessageHistory). */
const READ_MESSAGE_HISTORY_FLAG = 1n << 16n;

/** Discord API error code for an unknown channel. */
const UNKNOWN_CHANNEL_CODE = 10003;
/** Discord API error code for missing permissions. */
const MISSING_PERMISSIONS_CODE = 50013;

/** Discord epoch: 2015-01-01T00:00:00Z, the zero of snowflake timestamps. */
const DISCORD_EPOCH_MS = 1_420_070_400_000n;
/** Discord snowflakes encode their creation instant in the high bits. */
const SNOWFLAKE_TIMESTAMP_SHIFT = 22n;

/**
 * Default and maximum number of messages returned by one read. The Discord
 * messages endpoint serves at most 100 messages per call; the page budget
 * below bounds a single read to at most ten REST calls (1,000 raw messages
 * scanned) so an author-filtered read can never page unboundedly through a
 * busy channel.
 */
export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 200;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/**
 * Structural view of the Discord client the history reader needs. discord.js
 * satisfies this; unit tests substitute structural fakes. `selfUserId` is a
 * function so the client's user resolves lazily, after the ready handshake.
 */
export interface ChannelHistoryEndpoint {
  fetchChannel(channelId: string): Promise<unknown>;
  selfUserId(): string | undefined;
}

/**
 * Convert an ISO-8601 instant to the Discord snowflake whose creation instant
 * is that millisecond, for use as an exclusive `before` cursor. Returns
 * undefined for instants the runtime cannot parse or that precede the Discord
 * epoch (no snowflake can exist before it).
 */
export function snowflakeFromTimestamp(iso: string): string | undefined {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms < Number(DISCORD_EPOCH_MS)) {
    return undefined;
  }
  return String((BigInt(ms) - DISCORD_EPOCH_MS) << SNOWFLAKE_TIMESTAMP_SHIFT);
}

const SNOWFLAKE_PATTERN = /^\d+$/u;

/**
 * Resolve a `before` cursor to a Discord snowflake. Message ids pass through
 * unchanged (Discord accepts any snowflake as an exclusive cursor, even one
 * whose message no longer exists); ISO-8601 instants convert to snowflakes.
 * Anything else is rejected so a malformed cursor never widens the range.
 */
export function resolveBeforeCursor(before: string): string | undefined {
  const candidate = before.trim();
  if (SNOWFLAKE_PATTERN.test(candidate)) {
    return candidate;
  }
  return snowflakeFromTimestamp(candidate);
}

/**
 * Canonicalize a link so dedupe compares article identity rather than
 * tracking parameters: scheme + host + path with the query string and
 * fragment stripped, the host lowercased, and default ports (http 80,
 * https 443) dropped. Only HTTP(S) links canonicalize; anything else —
 * and anything unparsable — yields undefined.
 */
export function canonicalizeUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const dropPort =
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80");
  const hostPart = url.port && !dropPort ? `${host}:${url.port}` : host;
  return `${url.protocol}//${hostPart}${url.pathname}`;
}

/**
 * Extract HTTP(S) links from plain message text. Trailing sentence
 * punctuation and unmatched closing brackets or quotes are excluded; a
 * trailing parenthesis stays when the URL itself contains a balanced open
 * parenthesis (Wikipedia-style page titles). Results are canonicalized and
 * deduplicated in first-occurrence order.
 */
export function extractUrls(content: string): string[] {
  if (!content) {
    return [];
  }
  const matches = [...content.matchAll(/https?:\/\/[^\s<>"`]+/giu)].map(
    (match) => match[0] ?? ""
  );
  const urls: string[] = [];
  for (const match of matches) {
    const trimmed = trimUrlTail(match);
    if (!trimmed) {
      continue;
    }
    const canonical = canonicalizeUrl(trimmed);
    if (canonical !== undefined && !urls.includes(canonical)) {
      urls.push(canonical);
    }
  }
  return urls;
}

function trimUrlTail(url: string): string {
  let candidate = url;
  for (;;) {
    const last = candidate.slice(-1);
    if (".,;:!?'\"".includes(last)) {
      candidate = candidate.slice(0, -1);
      continue;
    }
    if (last === ")" && !candidate.includes("(")) {
      candidate = candidate.slice(0, -1);
      continue;
    }
    if (last === "]" && !candidate.includes("[")) {
      candidate = candidate.slice(0, -1);
      continue;
    }
    if (last === "}" && !candidate.includes("{")) {
      candidate = candidate.slice(0, -1);
      continue;
    }
    break;
  }
  return candidate;
}

interface DiscordApiErrorFields {
  name?: string | undefined;
  code?: number | string | undefined;
  status?: number | undefined;
  timeToReset?: number | undefined;
  retryAfter?: number | undefined;
}

function errorFields(error: unknown): DiscordApiErrorFields {
  if (typeof error !== "object" || error === null) {
    return {};
  }
  const source = error as DiscordApiErrorFields;
  return {
    name: typeof source.name === "string" ? source.name : undefined,
    code: typeof source.code === "number" || typeof source.code === "string"
      ? source.code
      : undefined,
    status: typeof source.status === "number" ? source.status : undefined,
    timeToReset: typeof source.timeToReset === "number" ? source.timeToReset : undefined,
    retryAfter: typeof source.retryAfter === "number" ? source.retryAfter : undefined
  };
}

/**
 * Classify a Discord fetch failure. Definitive answers (unknown channel,
 * permission denied, rate limit) map to their explicit statuses; everything
 * else — including any transient failure — is a generic `error` so a caller
 * never mistakes a failed read for an empty channel.
 */
function classifyFetchError(error: unknown): ChannelHistoryReadResult {
  const fields = errorFields(error);
  const code = typeof fields.code === "string" ? Number(fields.code) : fields.code;
  const numericCode = code !== undefined && Number.isInteger(code) ? code : undefined;
  if (fields.name === "RateLimitError" || fields.status === 429) {
    const resetMs = fields.timeToReset;
    const retryAfterSeconds = resetMs !== undefined
      ? Math.ceil(resetMs / 1_000)
      : fields.retryAfter !== undefined
        ? Math.ceil(fields.retryAfter)
        : undefined;
    return {
      status: "rate-limited",
      ...(retryAfterSeconds !== undefined && retryAfterSeconds > 0
        ? { retryAfterSeconds }
        : {})
    };
  }
  if (numericCode === MISSING_PERMISSIONS_CODE || fields.status === 403) {
    return { status: "permission" };
  }
  if (numericCode === UNKNOWN_CHANNEL_CODE) {
    return { status: "unresolvable" };
  }
  return { status: "error" };
}

interface HistoryMessageView {
  id?: unknown;
  author?: { id?: unknown };
  content?: unknown;
  createdTimestamp?: unknown;
}

interface HistoryPageView {
  size?: unknown;
  values?: unknown;
}

interface HistoryChannelView {
  permissionsFor?: (user: unknown) => unknown;
  messages?: {
    fetch?: (options: { limit: number; before?: string }) => Promise<unknown>;
  };
}

function toHistoryMessage(raw: unknown): ChannelHistoryMessage | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const view = raw as HistoryMessageView;
  // Discord message ids are snowflakes; a non-snowflake id is unshapable and
  // also unusable as a paging cursor, so the record is skipped.
  if (typeof view.id !== "string" || !SNOWFLAKE_PATTERN.test(view.id)) {
    return undefined;
  }
  const authorId =
    typeof view.author?.id === "string" && view.author.id !== ""
      ? view.author.id
      : "unknown";
  const content = typeof view.content === "string" ? view.content : "";
  const createdTimestamp =
    typeof view.createdTimestamp === "number" && Number.isFinite(view.createdTimestamp)
      ? view.createdTimestamp
      : Number(BigInt(view.id) >> SNOWFLAKE_TIMESTAMP_SHIFT) + Number(DISCORD_EPOCH_MS);
  return {
    messageId: view.id,
    authorId,
    timestamp: new Date(createdTimestamp).toISOString(),
    content,
    urls: extractUrls(content)
  };
}

function pageMessages(page: unknown): unknown[] {
  if (typeof page !== "object" || page === null) {
    return [];
  }
  const view = page as HistoryPageView;
  if (typeof view.values !== "function") {
    return [];
  }
  return [...(view.values as () => Iterable<unknown>)()];
}

function pageSizeOf(page: unknown): number {
  if (typeof page !== "object" || page === null) {
    return 0;
  }
  const size = (page as HistoryPageView).size;
  return typeof size === "number" ? size : 0;
}

function hasPermissionBits(
  permissions: unknown,
  flag: bigint
): boolean {
  const has = (permissions as { has?: unknown } | null | undefined)?.has;
  return typeof has === "function" && (has as (bit: bigint) => boolean).call(permissions, flag);
}

/**
 * Answer whether the bot may read the channel's history, or undefined when
 * the channel carries no guild permission bits (DM and group-DM channels:
 * participation is the access boundary and the fetch itself arbitrates
 * access) or the bot user is unavailable.
 */
function botCanReadHistory(channel: unknown, botUserId: string): boolean | undefined {
  const permissionsFor = (channel as HistoryChannelView).permissionsFor;
  if (typeof permissionsFor !== "function") {
    return undefined;
  }
  const permissions = permissionsFor.call(channel, botUserId);
  if (permissions === null || permissions === undefined) {
    return false;
  }
  return (
    hasPermissionBits(permissions, VIEW_CHANNEL_FLAG) &&
    hasPermissionBits(permissions, READ_MESSAGE_HISTORY_FLAG)
  );
}

/**
 * Read the current conversation's Discord history. The conversation comes
 * only from the harness-derived key; a key the harness could not have
 * derived, a channel that cannot be resolved, or a channel the bot cannot
 * see returns an explicit failure status and never a default channel's
 * history.
 */
export async function readChannelHistory(
  endpoint: ChannelHistoryEndpoint,
  conversationKey: string,
  query: ChannelHistoryQuery
): Promise<ChannelHistoryReadResult> {
  const identity = parseConversationKey(conversationKey);
  if (!identity) {
    return { status: "unresolvable" };
  }
  const rawBefore = query.before?.trim();
  let beforeCursor: string | undefined;
  if (rawBefore !== undefined && rawBefore !== "") {
    beforeCursor = resolveBeforeCursor(rawBefore);
    if (beforeCursor === undefined) {
      return { status: "error" };
    }
  }
  const authorFilter = query.authorId?.trim() || undefined;
  const limit = Math.min(
    MAX_HISTORY_LIMIT,
    Math.max(1, Math.floor(query.limit ?? DEFAULT_HISTORY_LIMIT))
  );

  let channel: unknown;
  try {
    channel = await endpoint.fetchChannel(identity.channelId);
  } catch (error) {
    return classifyFetchError(error);
  }
  if (channel === null || channel === undefined) {
    return { status: "unresolvable" };
  }
  const fetchMessages = (channel as HistoryChannelView).messages?.fetch;
  if (typeof fetchMessages !== "function") {
    return { status: "unresolvable" };
  }
  // Guild channels verify the bot's Read Message History up front so a
  // permission gap is an explicit error, never a silent empty list. DM
  // channels have no guild permission bits; their access errors surface
  // from the fetch itself.
  if (identity.kind === "guild") {
    const botUserId = endpoint.selfUserId();
    if (botUserId !== undefined && botCanReadHistory(channel, botUserId) === false) {
      return { status: "permission" };
    }
  }

  const collected: ChannelHistoryMessage[] = [];
  let cursor = beforeCursor;
  let pages = 0;
  let lastPageWasFull = false;
  let truncated = false;

  for (;;) {
    if (collected.length >= limit) {
      break;
    }
    if (pages >= MAX_PAGES) {
      truncated = lastPageWasFull;
      break;
    }
    const remaining = limit - collected.length;
    // Without an author filter the first fetch asks for exactly what remains,
    // so the default read touches Discord once. With a filter, scan full
    // pages backwards until the filter has collected the limit.
    const pageSize = authorFilter ? PAGE_SIZE : Math.min(PAGE_SIZE, remaining);
    let page: unknown;
    try {
      page = await fetchMessages({
        limit: pageSize,
        ...(cursor ? { before: cursor } : {})
      });
    } catch (error) {
      return classifyFetchError(error);
    }
    pages += 1;
    const messages = pageMessages(page);
    lastPageWasFull = messages.length === pageSize && pageSizeOf(page) === pageSize;
    for (const raw of messages) {
      const message = toHistoryMessage(raw);
      if (message && (!authorFilter || message.authorId === authorFilter)) {
        collected.push(message);
        if (collected.length >= limit) {
          break;
        }
      }
    }
    if (messages.length < pageSize) {
      break;
    }
    const oldestId = (messages.at(-1) as HistoryMessageView | undefined)?.id;
    if (typeof oldestId !== "string" || oldestId === "") {
      break;
    }
    cursor = oldestId;
  }

  // Deterministic newest-first order regardless of each page's return order;
  // snowflake ids are monotonic with creation time, so the id breaks ties.
  collected.sort((left, right) => {
    const leftMs = Date.parse(left.timestamp);
    const rightMs = Date.parse(right.timestamp);
    if (rightMs !== leftMs) {
      return rightMs - leftMs;
    }
    const leftId = BigInt(left.messageId || "0");
    const rightId = BigInt(right.messageId || "0");
    return rightId > leftId ? 1 : rightId < leftId ? -1 : 0;
  });
  return { status: "ok", messages: collected, truncated };
}