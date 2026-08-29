import type {
  ConversationIdentity,
  MembershipStatus,
  ScheduledPromptRecord
} from "./domain.js";

/** Discord's ViewChannel permission bit (PermissionsBitField.Flags.ViewChannel). */
const VIEW_CHANNEL_FLAG = 1n << 10n;

/**
 * API error codes that conclusively establish a resource does not exist:
 * unknown channel (10003), unknown member (10007), unknown user (10013), and
 * unknown guild (10004). Any other failure stays "unknown".
 */
const DEFINITIVE_MISS_CODES = new Set([10003, 10007, 10013, 10004]);

/**
 * Narrow structural view of the Discord client the membership resolver needs.
 * discord.js satisfies this; unit tests substitute structural fakes.
 */
export interface ChannelMembershipEndpoint {
  fetchGuild(guildId: string): Promise<unknown>;
  fetchChannel(channelId: string): Promise<unknown>;
}

/**
 * Parse a stable conversation key produced by the harness
 * (see {@link deriveChannelIdentity}). Keys the harness could not have derived
 * return undefined so callers can reject them instead of guessing a scope.
 */
export function parseConversationKey(key: string): ConversationIdentity | undefined {
  const dm = /^dm:([^:\s]+)$/.exec(key);
  if (dm) {
    return { key, kind: "dm", channelId: dm[1] ?? "" };
  }
  const guild = /^guild:([^:\s]+):channel:([^:\s]+)$/.exec(key);
  if (guild) {
    return { key, kind: "guild", guildId: guild[1] ?? "", channelId: guild[2] ?? "" };
  }
  return undefined;
}

function definitiveMiss(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  const numeric = typeof code === "number" ? code : typeof code === "string" ? Number(code) : NaN;
  return Number.isInteger(numeric) && DEFINITIVE_MISS_CODES.has(numeric);
}

async function fetchDefinitive(
  fetcher: () => Promise<unknown>
): Promise<{ value?: unknown; unknownResource?: boolean }> {
  try {
    return { value: await fetcher() };
  } catch (error) {
    if (definitiveMiss(error)) {
      return { unknownResource: true };
    }
    return {};
  }
}

/**
 * Extract the DM/group conversation's recipients from a Discord channel
 * object: `recipientId` for one-to-one DM channels, `recipientIds` (array or
 * key-based collection) for group conversations. Undefined when the shape is
 * unrecognized, leaving the answer "unknown".
 */
function dmRecipients(channel: unknown): string[] | undefined {
  if (typeof channel !== "object" || channel === null) {
    return undefined;
  }
  const recipientId = (channel as { recipientId?: unknown }).recipientId;
  if (typeof recipientId === "string") {
    return [recipientId];
  }
  const recipientIds = (channel as { recipientIds?: unknown }).recipientIds;
  if (Array.isArray(recipientIds)) {
    return recipientIds.filter((value): value is string => typeof value === "string");
  }
  if (typeof recipientIds === "object" && recipientIds !== null && "keys" in recipientIds) {
    return [...(recipientIds as { keys(): Iterable<unknown> }).keys()]
      .filter((key): key is string => typeof key === "string");
  }
  return undefined;
}

/**
 * Resolve whether `userId` is a member of the channel behind
 * `conversationKey`, from live Discord state:
 *
 * - DM conversations: the channel's recipient (or the group recipient list)
 *   must contain the user.
 * - Channel Groups: the user must be a guild member with the View Channel
 *   permission on the conversation's (parent) channel.
 *
 * Returns "not-member" only on definitive negative answers (resource unknown,
 * permission denied); transient failures return "unknown".
 */
export async function resolveChannelMembership(
  endpoint: ChannelMembershipEndpoint,
  conversationKey: string,
  userId: string
): Promise<MembershipStatus> {
  const identity = parseConversationKey(conversationKey);
  if (!identity) {
    return "unknown";
  }
  if (userId.trim() === "") {
    return "not-member";
  }

  if (identity.kind === "dm") {
    const outcome = await fetchDefinitive(() => endpoint.fetchChannel(identity.channelId));
    if (outcome.value === undefined) {
      return outcome.unknownResource === true ? "not-member" : "unknown";
    }
    const recipients = dmRecipients(outcome.value);
    if (recipients === undefined) {
      return "unknown";
    }
    return recipients.includes(userId) ? "member" : "not-member";
  }

  const guildOutcome = await fetchDefinitive(() => endpoint.fetchGuild(identity.guildId ?? ""));
  if (guildOutcome.value === undefined) {
    return guildOutcome.unknownResource === true ? "not-member" : "unknown";
  }
  const guild = guildOutcome.value;
  const members = (guild as { members?: { fetch(id: string): Promise<unknown> } } | null)
    ?.members;
  if (typeof members?.fetch !== "function") {
    return "unknown";
  }
  const memberOutcome = await fetchDefinitive(() => members.fetch(userId));
  if (memberOutcome.value === undefined && memberOutcome.unknownResource === true) {
    return "not-member";
  }
  if (memberOutcome.value === undefined) {
    return "unknown";
  }
  const channelOutcome = await fetchDefinitive(() => endpoint.fetchChannel(identity.channelId));
  if (channelOutcome.value === undefined && channelOutcome.unknownResource === true) {
    return "not-member";
  }
  if (channelOutcome.value === undefined) {
    return "unknown";
  }
  const channel = channelOutcome.value;
  if (typeof (channel as { permissionsFor?: unknown }).permissionsFor !== "function") {
    return "not-member";
  }
  const permissions = (
    channel as { permissionsFor(member: unknown): { has(flag: bigint): boolean } | null }
  ).permissionsFor(memberOutcome.value);
  return permissions?.has(VIEW_CHANNEL_FLAG) === true ? "member" : "not-member";
}


export interface ScheduledPromptRunCandidate {
  /** Stable conversation key stored with the job; always harness-derived. */
  conversationKey: string;
  /** Harness-injected Discord user who requested the schedule. */
  scheduledByUserId: string;
}

export type ScheduledPromptRejectionCode =
  | "invalid-scope"
  | "channel-not-allowed"
  | "user-not-authorized"
  | "membership-revoked"
  | "unattributed-scheduler";

export type ScheduledPromptRunDecision =
  | { allowed: true; membershipVerified: boolean; identity: ConversationIdentity }
  | { allowed: false; code: ScheduledPromptRejectionCode; detail: string };

export type ScheduledPromptScopeCheck =
  | { ok: true }
  | { ok: false; code: ScheduledPromptRejectionCode; detail: string };

export interface ScheduledPromptRunCheck {
  candidate: ScheduledPromptRunCandidate;
  membership: MembershipStatus;
  allowedChannelIds: readonly string[];
  allowedUserIds: readonly string[];
}

/**
 * Scope-level gate: conversation key shape, deployment allow-lists, and the
 * scheduling-user attribution. Pure and synchronous — no Discord traffic. A
 * passing scope check is required before any membership lookup happens.
 */
export function checkScheduledPromptScope(
  candidate: ScheduledPromptRunCandidate,
  allowedChannelIds: readonly string[],
  allowedUserIds: readonly string[]
): ScheduledPromptScopeCheck {
  const scheduledByUserId = candidate.scheduledByUserId.trim();
  if (scheduledByUserId === "") {
    return {
      ok: false,
      code: "unattributed-scheduler",
      detail:
        "The scheduled prompt has no recorded scheduling user, so its membership cannot be authorized."
    };
  }
  const identity = parseConversationKey(candidate.conversationKey);
  if (!identity) {
    return {
      ok: false,
      code: "invalid-scope",
      detail: `"${candidate.conversationKey}" is not a harness-derived DM or Channel Group conversation key.`
    };
  }
  if (identity.kind === "guild") {
    if (!allowedChannelIds.includes(identity.channelId)) {
      return {
        ok: false,
        code: "channel-not-allowed",
        detail: `Channel ${identity.channelId} is not an allowlisted Artemis Channel Group.`
      };
    }
  } else if (!allowedUserIds.includes(scheduledByUserId)) {
    return {
      ok: false,
      code: "user-not-authorized",
      detail: `User ${scheduledByUserId} is not an authorized DM user for this deployment.`
    };
  }
  return { ok: true };
}

/**
 * Fire-time authorization: applies the scope gate first, then the live
 * membership gate. Only a definitive "not member" at fire time revokes the
 * job; an unreachable check keeps just the allow-list gates and reports the
 * membership as unverified so the caller can log it.
 */
export function authorizeScheduledPromptRun(check: ScheduledPromptRunCheck): ScheduledPromptRunDecision {
  const scope = checkScheduledPromptScope(check.candidate, check.allowedChannelIds, check.allowedUserIds);
  if (!scope.ok) {
    return { allowed: false, code: scope.code, detail: scope.detail };
  }
  const identity = parseConversationKey(check.candidate.conversationKey);
  if (!identity) {
    // checkScheduledPromptScope already rejected unparseable keys; this branch
    // is unreachable but keeps the decision exhaustive for the type system.
    return {
      allowed: false,
      code: "invalid-scope",
      detail: `"${check.candidate.conversationKey}" is not a harness-derived conversation key.`
    };
  }
  if (check.membership === "not-member") {
    return {
      allowed: false,
      code: "membership-revoked",
      detail: `User ${check.candidate.scheduledByUserId} is no longer a member of ${check.candidate.conversationKey}.`
    };
  }
  return { allowed: true, membershipVerified: check.membership === "member", identity };
}

/** Convenience wrapper taking the full stored job record. */
export function authorizeScheduledPrompt(
  record: ScheduledPromptRecord,
  membership: MembershipStatus,
  allowedChannelIds: readonly string[],
  allowedUserIds: readonly string[]
): ScheduledPromptRunDecision {
  return authorizeScheduledPromptRun({
    candidate: record,
    membership,
    allowedChannelIds,
    allowedUserIds
  });
}