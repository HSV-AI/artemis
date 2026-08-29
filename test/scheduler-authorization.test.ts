import { describe, expect, it, vi } from "vitest";
import type { ChannelMembershipEndpoint } from "../src/scheduler-authorization.js";
import {
  authorizeScheduledPromptRun,
  parseConversationKey,
  resolveChannelMembership
} from "../src/scheduler-authorization.js";
import type { ConversationService } from "../src/conversation-service.js";
import { DiscordGateway } from "../src/discord-gateway.js";
import { createLoggerMock } from "./helpers.js";

/** Discord's ViewChannel permission bit (PermissionsBitField.Flags.ViewChannel). */
const VIEW_CHANNEL_FLAG = 1n << 10n;

function apiError(code: number): unknown {
  return Object.assign(new Error(`API error ${code}`), { code });
}

interface EndpointOptions {
  guild?: unknown;
  guildError?: unknown;
  member?: unknown;
  memberError?: unknown;
  channel?: unknown;
  channelError?: unknown;
}

function endpointWith(options: EndpointOptions): ChannelMembershipEndpoint {
  return {
    fetchGuild: vi.fn(async () => {
      if (options.guildError) throw options.guildError;
      return (
        options.guild ?? {
          members: {
            fetch: vi.fn(async () => {
              if (options.memberError) throw options.memberError;
              return options.member ?? { id: "user-1" };
            })
          }
        }
      );
    }),
    fetchChannel: vi.fn(async () => {
      if (options.channelError) throw options.channelError;
      return options.channel ?? null;
    })
  };
}

describe("parseConversationKey", () => {
  it("parses a harness-derived DM conversation key", () => {
    expect(parseConversationKey("dm:channel-9")).toEqual({
      key: "dm:channel-9",
      kind: "dm",
      channelId: "channel-9"
    });
  });

  it("parses a harness-derived guild Channel Group key", () => {
    expect(parseConversationKey("guild:g1:channel:c1")).toEqual({
      key: "guild:g1:channel:c1",
      kind: "guild",
      guildId: "g1",
      channelId: "c1"
    });
  });

  it("rejects anything that is not exactly a harness-derived conversation key", () => {
    expect(parseConversationKey("")).toBeUndefined();
    expect(parseConversationKey("dm:")).toBeUndefined();
    expect(parseConversationKey("dm:  ")).toBeUndefined();
    expect(parseConversationKey("user:123")).toBeUndefined();
    expect(parseConversationKey("guild:g1")).toBeUndefined();
    expect(parseConversationKey("guild:g1:thread:c1")).toBeUndefined();
    expect(parseConversationKey("guild:g1:channel:")).toBeUndefined();
    expect(parseConversationKey("DM:channel")).toBeUndefined();
    expect(parseConversationKey("dm:channel extra")).toBeUndefined();
    expect(parseConversationKey("dm:guild:g1:channel:c1")).toBeUndefined();
  });
});

describe("resolveChannelMembership", () => {
  it("verifies a guild member who can view the scheduled parent channel", async () => {
    const endpoint = endpointWith({
      member: { id: "user-1" },
      channel: {
        permissionsFor: (member: unknown) => {
          expect(member).toEqual({ id: "user-1" });
          return { has: (flag: bigint) => flag === VIEW_CHANNEL_FLAG };
        }
      }
    });
    expect(await resolveChannelMembership(endpoint, "guild:g1:channel:c1", "user-1")).toBe("member");
  });

  it("denies a guild member who cannot view the channel", async () => {
    const endpoint = endpointWith({
      channel: { permissionsFor: () => ({ has: () => false }) }
    });
    expect(await resolveChannelMembership(endpoint, "guild:g1:channel:c1", "user-1")).toBe(
      "not-member"
    );
  });

  it("passes the Discord ViewChannel permission flag when checking channel access", async () => {
    const seenFlags: bigint[] = [];
    const endpoint = endpointWith({
      channel: {
        permissionsFor: () => ({
          has: (flag: bigint) => {
            seenFlags.push(flag);
            return true;
          }
        })
      },
      member: { id: "user-1" }
    });
    expect(await resolveChannelMembership(endpoint, "guild:g1:channel:c1", "user-1")).toBe("member");
    expect(seenFlags).toEqual([1n << 10n]);
  });

  it("denies a guild channel that cannot resolve permissions instead of granting access", async () => {
    const endpoint = endpointWith({ channel: {} });
    expect(await resolveChannelMembership(endpoint, "guild:g1:channel:c1", "user-1")).toBe(
      "not-member"
    );
    const nullPermissions = endpointWith({
      channel: { permissionsFor: () => null }
    });
    expect(await resolveChannelMembership(nullPermissions, "guild:g1:channel:c1", "user-1")).toBe(
      "not-member"
    );
  });

  it("denies an unknown guild member without guessing", async () => {
    expect(
      await resolveChannelMembership(
        endpointWith({ memberError: apiError(10007) }),
        "guild:g1:channel:c1",
        "user-1"
      )
    ).toBe("not-member");
  });

  it("stays unverifiable when a transient failure prevents a membership answer", async () => {
    const endpoint = endpointWith({ memberError: new Error("rate limited") });
    expect(await resolveChannelMembership(endpoint, "guild:g1:channel:c1", "user-1")).toBe("unknown");
  });

  it("denies a missing guild but stays unverifiable on transient guild failures", async () => {
    const gone = endpointWith({ guildError: apiError(10004) });
    expect(await resolveChannelMembership(gone, "guild:gone:channel:c1", "user-1")).toBe(
      "not-member"
    );

    const transient = endpointWith({ guildError: new Error("gateway down") });
    expect(await resolveChannelMembership(transient, "guild:g1:channel:c1", "user-1")).toBe(
      "unknown"
    );
  });

  it("denies a scheduling user that is blank", async () => {
    const endpoint = endpointWith({});
    expect(await resolveChannelMembership(endpoint, "guild:g1:channel:c1", "")).toBe("not-member");
    expect(await resolveChannelMembership(endpoint, "guild:g1:channel:c1", "   ")).toBe("not-member");
  });

  it("treats a conversation key the harness cannot have derived as unverifiable", async () => {
    const endpoint = endpointWith({ channel: {}, member: {} });
    expect(await resolveChannelMembership(endpoint, "user:123", "user-1")).toBe("unknown");
    expect(await resolveChannelMembership(endpoint, "", "user-1")).toBe("unknown");
  });
});

describe("DM membership resolution", () => {
  it("verifies the DM channel's recipient", async () => {
    const endpoint = endpointWith({ channel: { recipientId: "user-1" } });
    expect(await resolveChannelMembership(endpoint, "dm:dm-1", "user-1")).toBe("member");
    expect(await resolveChannelMembership(endpoint, "dm:dm-1", "someone-else")).toBe("not-member");
  });

  it("verifies group conversation members from the recipient list", async () => {
    const endpoint = endpointWith({ channel: { recipientIds: ["user-1", "user-2"] } });
    expect(await resolveChannelMembership(endpoint, "dm:group-1", "user-2")).toBe("member");
    expect(await resolveChannelMembership(endpoint, "dm:group-1", "user-9")).toBe("not-member");
  });

  it("denies a DM channel that no longer exists and stays unverifiable on transient failures", async () => {
    const missing = endpointWith({ channelError: apiError(10003) });
    expect(await resolveChannelMembership(missing, "dm:gone", "user-1")).toBe("not-member");

    const transient = endpointWith({ channelError: new Error("socket hang up") });
    expect(await resolveChannelMembership(transient, "dm:dm-1", "user-1")).toBe("unknown");
  });
});

describe("authorizeScheduledPromptRun", () => {
  const candidate = {
    conversationKey: "guild:g1:channel:c1",
    scheduledByUserId: "user-1"
  };

  it("allows an allowlisted guild job for a verified member and reports verification", () => {
    expect(
      authorizeScheduledPromptRun({
        candidate,
        membership: "member",
        allowedChannelIds: ["c1"],
        allowedUserIds: []
      })
    ).toEqual({
      allowed: true,
      membershipVerified: true,
      identity: { key: "guild:g1:channel:c1", kind: "guild", guildId: "g1", channelId: "c1" }
    });
  });

  it("allows an authorized DM user's job for a verified member", () => {
    expect(
      authorizeScheduledPromptRun({
        candidate: { conversationKey: "dm:dm-1", scheduledByUserId: "user-1" },
        membership: "member",
        allowedChannelIds: [],
        allowedUserIds: ["user-1", "user-2"]
      })
    ).toEqual({
      allowed: true,
      membershipVerified: true,
      identity: { key: "dm:dm-1", kind: "dm", channelId: "dm-1" }
    });
  });

  it("allows a job whose fire-time membership check is unreachable, without claiming verification", () => {
    expect(
      authorizeScheduledPromptRun({
        candidate,
        membership: "unknown",
        allowedChannelIds: ["c1"],
        allowedUserIds: []
      })
    ).toEqual({
      allowed: true,
      membershipVerified: false,
      identity: expect.objectContaining({ key: "guild:g1:channel:c1" })
    });
  });

  it("denies a guild job whose channel left the deployment allow-list", () => {
    expect(
      authorizeScheduledPromptRun({
        candidate,
        membership: "member",
        allowedChannelIds: ["other"],
        allowedUserIds: []
      })
    ).toEqual({
      allowed: false,
      code: "channel-not-allowed",
      detail: expect.stringContaining("c1")
    });
  });

  it("denies a DM job for a user outside the authorized DM allow-list", () => {
    expect(
      authorizeScheduledPromptRun({
        candidate: { conversationKey: "dm:dm-1", scheduledByUserId: "stranger" },
        membership: "member",
        allowedChannelIds: [],
        allowedUserIds: ["user-1"]
      })
    ).toEqual({
      allowed: false,
      code: "user-not-authorized",
      detail: expect.stringContaining("stranger")
    });
  });

  it("denies a job whose scheduling user no longer belongs to the channel", () => {
    expect(
      authorizeScheduledPromptRun({
        candidate,
        membership: "not-member",
        allowedChannelIds: ["c1"],
        allowedUserIds: []
      })
    ).toEqual({
      allowed: false,
      code: "membership-revoked",
      detail: expect.stringContaining("user-1")
    });
  });

  it("denies jobs with a blank or unattributed scheduling user", () => {
    for (const scheduledByUserId of ["", "   "]) {
      expect(
        authorizeScheduledPromptRun({
          candidate: { ...candidate, scheduledByUserId },
          membership: "member",
          allowedChannelIds: ["c1"],
          allowedUserIds: []
        })
      ).toEqual({
        allowed: false,
        code: "unattributed-scheduler",
        detail: expect.any(String)
      });
    }
  });

  it("denies a job bound to a conversation key the harness could not have derived", () => {
    expect(
      authorizeScheduledPromptRun({
        candidate: { ...candidate, conversationKey: "user:123" },
        membership: "member",
        allowedChannelIds: ["c1"],
        allowedUserIds: ["user-1"]
      })
    ).toEqual({
      allowed: false,
      code: "invalid-scope",
      detail: expect.stringContaining("user:123")
    });
  });
});

describe("DiscordGateway membership", () => {
  it("resolves guild membership over the live Discord client", async () => {
    const fetched = { id: "user-1" };
    const memberFetch = vi.fn(async () => fetched);
    const client = {
      channels: { fetch: vi.fn(async () => ({ permissionsFor: () => ({ has: () => true }) })) },
      guilds: { fetch: vi.fn(async () => ({ members: { fetch: memberFetch } })) }
    };
    const gateway = new DiscordGateway(
      { token: "t", channelIds: [], userIds: [] },
      {} as ConversationService,
      createLoggerMock(),
      client as never
    );

    expect(await gateway.isChannelMember("guild:g1:channel:c1", "user-1")).toBe("member");
    expect(client.guilds.fetch).toHaveBeenCalledWith("g1");
    expect(memberFetch).toHaveBeenCalledWith("user-1");
  });

  it("resolves DM membership through the live Discord client", async () => {
    const client = {
      channels: { fetch: vi.fn(async () => ({ recipientId: "user-1" })) },
      guilds: { fetch: vi.fn() }
    };
    const gateway = new DiscordGateway(
      { token: "t", channelIds: [], userIds: [] },
      {} as ConversationService,
      createLoggerMock(),
      client as never
    );

    expect(await gateway.isChannelMember("dm:dm-1", "user-1")).toBe("member");
    expect(await gateway.isChannelMember("dm:dm-1", "user-2")).toBe("not-member");
  });

  it("stays unverifiable when the Discord client cannot answer", async () => {
    const client = {
      channels: { fetch: vi.fn(async () => {
        throw new Error("transient");
      }) },
      guilds: { fetch: vi.fn(async () => {
        throw new Error("transient");
      }) }
    };
    const gateway = new DiscordGateway(
      { token: "t", channelIds: [], userIds: [] },
      {} as ConversationService,
      createLoggerMock(),
      client as never
    );

    expect(await gateway.isChannelMember("guild:g1:channel:c1", "user-1")).toBe("unknown");
  });
});