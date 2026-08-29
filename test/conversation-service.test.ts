import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConversationService,
  deriveConversationIdentity
} from "../src/conversation-service.js";
import type {
  ChannelMembershipChecker,
  InboundMessage,
  MembershipStatus,
  PiGateway,
  PiGenerationResult,
  ScheduledPromptRecord,
  SourceMessage
} from "../src/domain.js";
import { ArtemisRepository } from "../src/repository.js";
import { createLoggerMock, createPiMock, inbound } from "./helpers.js";

const options = {
  channelIds: ["group-1", "group-2"],
  userIds: ["603384387685449728", "second-user"],
  model: "test-model"
};

describe("conversation identity", () => {
  it("uses DM channels and parent guild channels as stable keys", () => {
    expect(deriveConversationIdentity(inbound({ channelId: "dm" }))).toEqual({
      key: "dm:dm",
      kind: "dm",
      channelId: "dm"
    });
    expect(
      deriveConversationIdentity(
        inbound({ guildId: "guild", channelId: "thread", parentChannelId: "parent" })
      )
    ).toEqual({
      key: "guild:guild:channel:parent",
      kind: "guild",
      guildId: "guild",
      channelId: "parent"
    });
  });

});

describe("ConversationService incoming message logging", () => {
  let repository: ArtemisRepository | undefined;

  afterEach(() => repository?.close());

  function createService(pi = createPiMock()) {
    repository = new ArtemisRepository(":memory:");
    const logger = createLoggerMock();
    return { service: new ConversationService(options, repository, pi, logger), pi, logger };
  }

  it("logs every incoming message to the repository even when the response pipeline ignores it", () => {
    const { service, pi } = createService();
    const ignored: InboundMessage[] = [
      inbound({ discordMessageId: "bot", isBot: true, content: "beep" }),
      inbound({ discordMessageId: "empty", content: "   " }),
      inbound({
        discordMessageId: "unmentioned",
        guildId: "guild-1",
        channelId: "group-1",
        mentionsBot: false,
        repliesToBot: false
      }),
      inbound({ discordMessageId: "unauthorized-dm", authorId: "stranger" })
    ];
    for (const message of ignored) {
      service.logMessage(message);
    }

    expect(pi.generate).not.toHaveBeenCalled();
    for (const message of ignored) {
      expect(repository?.hasIncomingMessage(message.discordMessageId)).toBe(true);
      expect(repository?.getIncomingMessage(message.discordMessageId)?.content).toBe(
        message.content
      );
    }
  });

  it("logs interactive messages without triggering a response itself", () => {
    const { service, pi } = createService();
    service.logMessage(inbound({ discordMessageId: "interactive" }));
    expect(pi.generate).not.toHaveBeenCalled();
    expect(repository?.hasIncomingMessage("interactive")).toBe(true);
  });

  it("preserves thread and parent channel context for guild thread messages", () => {
    const { service } = createService();
    service.logMessage(
      inbound({
        discordMessageId: "thread-msg",
        guildId: "guild-1",
        channelId: "thread-1",
        parentChannelId: "group-1",
        threadId: "thread-1",
        content: "thread chat"
      })
    );
    expect(repository?.getIncomingMessage("thread-msg")).toEqual(
      expect.objectContaining({
        guildId: "guild-1",
        channelId: "thread-1",
        parentChannelId: "group-1",
        threadId: "thread-1",
        content: "thread chat"
      })
    );
  });

  it("records a logger error and never throws when persistence fails", () => {
    repository = new ArtemisRepository(":memory:");
    const logger = createLoggerMock();
    const service = new ConversationService(options, repository, createPiMock(), logger);
    repository.close();
    expect(() => service.logMessage(inbound({ discordMessageId: "boom" }))).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      "incoming_message_log_failed",
      expect.objectContaining({ discordMessageId: "boom" })
    );
  });
});

describe("ConversationService clearing", () => {
  let repository: ArtemisRepository | undefined;

  afterEach(() => repository?.close());

  function createService(pi = createPiMock()) {
    repository = new ArtemisRepository(":memory:");
    const logger = createLoggerMock();
    return { service: new ConversationService(options, repository, pi, logger), pi, logger };
  }

  it("clears the active session so the next message starts fresh while retaining archived history", async () => {
    const pi = createPiMock();
    const { service, logger } = createService(pi);
    await service.handleMessage(
      inbound({ discordMessageId: "m1", channelId: "dm-clear", content: "first" })
    );

    const firstSession = repository?.getOrCreateSession(
      { key: "dm:dm-clear", kind: "dm", channelId: "dm-clear" },
      "test-model"
    );
    expect(firstSession?.id).toBeDefined();

    expect(service.clearSession({ channelId: "dm-clear" })).toEqual({ cleared: true });
    expect(logger.error).not.toHaveBeenCalled();

    await service.handleMessage(
      inbound({
        discordMessageId: "m2",
        channelId: "dm-clear",
        content: "fresh"
      })
    );

    const secondInput = vi.mocked(pi.generate).mock.calls[1]?.[0];
    expect(secondInput).not.toHaveProperty("history");

    const secondSession = repository?.getOrCreateSession(
      { key: "dm:dm-clear", kind: "dm", channelId: "dm-clear" },
      "test-model"
    );
    expect(secondSession?.id).not.toBe(firstSession?.id);
    expect(repository?.getHistory(firstSession?.id ?? "")).toEqual([
      expect.objectContaining({ role: "user", content: "first" }),
      expect.objectContaining({ role: "assistant", content: "assistant response" })
    ]);
  });

  it("reports nothing to clear for a conversation without an active session", () => {
    const { service } = createService();
    expect(service.clearSession({ channelId: "never-used" })).toEqual({ cleared: false });
  });
});

describe("ConversationService", () => {
  let repository: ArtemisRepository | undefined;

  afterEach(() => repository?.close());

  function createService(pi = createPiMock()) {
    repository = new ArtemisRepository(":memory:");
    const logger = createLoggerMock();
    return { service: new ConversationService(options, repository, pi, logger), pi, logger };
  }

  it("silently ignores bots, empty messages, disallowed channels, unmentioned guild messages, and unauthorized DMs", async () => {
    const { service, pi, logger } = createService();
    await expect(service.handleMessage(inbound({ isBot: true }))).resolves.toBeNull();
    await expect(service.handleMessage(inbound({ content: " " }))).resolves.toBeNull();
    await expect(
      service.handleMessage(
        inbound({ guildId: "guild-1", channelId: "not-allowed", mentionsBot: true })
      )
    ).resolves.toBeNull();
    await expect(
      service.handleMessage(inbound({ guildId: "guild-1", channelId: "group-1" }))
    ).resolves.toBeNull();
    await expect(service.handleMessage(inbound({ authorId: "unauthorized" }))).resolves.toBeNull();
    expect(pi.generate).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      "discord_message_ignored",
      expect.objectContaining({ authorId: "unauthorized" })
    );
    expect(logger.debug).toHaveBeenCalledWith(
      "discord_message_ignored",
      expect.objectContaining({ reason: "bot_not_mentioned" })
    );
  });

  it("allows any user in an allowed guild channel while keeping the user allowlist on DMs", async () => {
    const { service, pi } = createService(createPiMock({ text: "Hello group" }));
    const guildIndicator = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn() };
    const dmIndicator = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn() };

    await expect(
      service.handleMessage(
        inbound({
          discordMessageId: "guild-message",
          authorId: "not-in-dm-user-allowlist",
          guildId: "another-guild",
          channelId: "group-2",
          mentionsBot: true,
          content: "<@artemis> hello",
          responseIndicator: guildIndicator
        })
      )
    ).resolves.toBe("Hello group");
    await expect(
      service.handleMessage(
        inbound({
          discordMessageId: "dm-message",
          authorId: "second-user",
          channelId: "dm-channel",
          mentionsBot: false,
          responseIndicator: dmIndicator
        })
      )
    ).resolves.toBe("Hello group");

    expect(pi.generate).toHaveBeenCalledTimes(2);
    expect(vi.mocked(pi.generate).mock.calls[0]?.[0].conversationKind).toBe("guild");
    expect(vi.mocked(pi.generate).mock.calls[0]?.[0]).toMatchObject({
      conversationKey: "guild:another-guild:channel:group-2",
      sourceMessageId: "guild-message",
      authorId: "not-in-dm-user-allowlist"
    });
    expect(vi.mocked(pi.generate).mock.calls[0]?.[0].prompt).toContain(
      '"author":{"id":"not-in-dm-user-allowlist","name":"Matt"}'
    );
    expect(vi.mocked(pi.generate).mock.calls[1]?.[0].conversationKind).toBe("dm");
    expect(vi.mocked(pi.generate).mock.calls[1]?.[0]).toMatchObject({
      conversationKey: "dm:dm-channel",
      sourceMessageId: "dm-message",
      authorId: "second-user"
    });
    expect(vi.mocked(pi.generate).mock.calls[1]?.[0].prompt).toContain(
      '"author":{"id":"second-user","name":"Matt"}'
    );
    expect(guildIndicator.start).toHaveBeenCalledOnce();
    expect(guildIndicator.stop).toHaveBeenCalledOnce();
    expect(dmIndicator.start).toHaveBeenCalledOnce();
    expect(dmIndicator.stop).toHaveBeenCalledOnce();
  });

  it("responds to a direct guild reply to Artemis without a mention", async () => {
    const { service, pi } = createService(createPiMock({ text: "Reply received" }));

    await expect(
      service.handleMessage(
        inbound({
          discordMessageId: "reply-message",
          guildId: "guild-1",
          channelId: "group-1",
          mentionsBot: false,
          repliesToBot: true,
          content: "following up"
        })
      )
    ).resolves.toBe("Reply received");

    expect(pi.generate).toHaveBeenCalledOnce();
  });

  it("does not start a response indicator for ignored or duplicate messages", async () => {
    const { service } = createService();
    const ignoredIndicator = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn() };
    await service.handleMessage(
      inbound({ authorId: "unauthorized", responseIndicator: ignoredIndicator })
    );
    expect(ignoredIndicator.start).not.toHaveBeenCalled();

    const accepted = inbound({ discordMessageId: "duplicate" });
    await service.handleMessage(accepted);
    const duplicateIndicator = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn() };
    await service.handleMessage({ ...accepted, responseIndicator: duplicateIndicator });
    expect(duplicateIndicator.start).not.toHaveBeenCalled();
    expect(duplicateIndicator.stop).not.toHaveBeenCalled();
  });

  it("persists a successful DM turn and deduplicates a redelivery", async () => {
    const { service, pi } = createService(
      createPiMock({ text: "Hello human", reasoning: "thinking", diagnostics: [{ type: "trace" }] })
    );
    const message = inbound();
    await expect(service.handleMessage(message)).resolves.toBe("Hello human");
    await expect(service.handleMessage(message)).resolves.toBeNull();
    expect(pi.generate).toHaveBeenCalledTimes(1);

    const session = repository?.getOrCreateSession(
      { key: "dm:channel-1", kind: "dm", channelId: "channel-1" },
      "test-model"
    );
    expect(repository?.getHistory(session?.id ?? "")).toEqual([
      expect.objectContaining({ role: "user", content: "Hello Artemis" }),
      expect.objectContaining({ role: "assistant", content: "Hello human", reasoning: "thinking" })
    ]);
  });

  it("reuses the durable logical session ID without crossing conversations", async () => {
    repository = new ArtemisRepository(":memory:");
    const firstPi = createPiMock({ text: "first" });
    const first = new ConversationService(options, repository, firstPi, createLoggerMock());
    await first.handleMessage(inbound({ discordMessageId: "one", channelId: "dm-one" }));
    await first.handleMessage(inbound({ discordMessageId: "other", channelId: "dm-two" }));

    const secondPi = createPiMock({ text: "second" });
    const second = new ConversationService(options, repository, secondPi, createLoggerMock());
    await second.handleMessage(
      inbound({ discordMessageId: "two", channelId: "dm-one", content: "follow up" })
    );

    const input = vi.mocked(secondPi.generate).mock.calls[0]?.[0];
    const dmOneSessionId = vi.mocked(firstPi.generate).mock.calls[0]?.[0].logicalSessionId;
    const dmTwoSessionId = vi.mocked(firstPi.generate).mock.calls[1]?.[0].logicalSessionId;
    expect(input?.logicalSessionId).toBe(dmOneSessionId);
    expect(input?.logicalSessionId).not.toBe(dmTwoSessionId);
    expect(input).not.toHaveProperty("history");
  });

  it("loads and resubmits the complete thread for any user in an allowed guild channel", async () => {
    const { service, pi } = createService();
    const loadThread = vi.fn().mockResolvedValue([
      {
        discordMessageId: "old",
        threadId: "thread",
        authorId: "other-user",
        authorName: "Other",
        role: "user",
        content: "old message",
        createdAt: "2026-08-19T11:00:00.000Z"
      },
      {
        discordMessageId: "message-1",
        threadId: "thread",
        authorId: options.userIds[0] ?? "",
        authorName: "Matt",
        role: "user",
        content: "new message",
        createdAt: "2026-08-19T12:00:00.000Z"
      }
    ] satisfies SourceMessage[]);
    await service.handleMessage(
      inbound({
        authorId: "not-in-dm-user-allowlist",
        guildId: "guild-1",
        channelId: "thread",
        parentChannelId: "group-1",
        mentionsBot: true,
        loadThread
      })
    );

    expect(loadThread).toHaveBeenCalledOnce();
    const prompt = vi.mocked(pi.generate).mock.calls[0]?.[0].prompt ?? "";
    expect(prompt).toContain("old message");
    expect(prompt).toContain("new message");
    expect(prompt).toContain('"author":{"id":"other-user","name":"Other"}');
    expect(prompt).toContain(
      `"author":{"id":"${options.userIds[0]}","name":"Matt"}`
    );
    const session = repository?.getOrCreateSession(
      {
        key: "guild:guild-1:channel:group-1",
        kind: "guild",
        guildId: "guild-1",
        channelId: "group-1"
      },
      "test-model"
    );
    expect(repository?.getHistory(session?.id ?? "").filter((message) => message.role === "user")).toHaveLength(2);
  });

  it("does not load a thread for an unmentioned guild trigger", async () => {
    const { service } = createService();
    const loadThread = vi.fn().mockResolvedValue([]);
    await service.handleMessage(
      inbound({
        guildId: "guild-1",
        channelId: "thread",
        parentChannelId: "group-1",
        mentionsBot: false,
        loadThread
      })
    );
    expect(loadThread).not.toHaveBeenCalled();
  });

  it("logs PI failures without returning or persisting an assistant response", async () => {
    const pi = createPiMock();
    vi.mocked(pi.generate).mockRejectedValue(new Error("provider secret details"));
    const { service, logger } = createService(pi);
    const responseIndicator = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn() };
    await expect(service.handleMessage(inbound({ responseIndicator }))).resolves.toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      "generation_failed",
      expect.objectContaining({ errorName: "Error", errorMessage: "provider secret details" })
    );
    const session = repository?.getOrCreateSession(
      { key: "dm:channel-1", kind: "dm", channelId: "channel-1" },
      "test-model"
    );
    expect(repository?.getHistory(session?.id ?? "")).toEqual([
      expect.objectContaining({ role: "user" })
    ]);
    expect(responseIndicator.start).toHaveBeenCalledOnce();
    expect(responseIndicator.stop).toHaveBeenCalledOnce();
  });

  it("treats an empty PI answer as a logged failure", async () => {
    const { service, logger } = createService(createPiMock({ text: " " }));
    await expect(service.handleMessage(inbound())).resolves.toBeNull();
    expect(logger.error).toHaveBeenCalled();
  });

  it("serializes two messages in the same conversation", async () => {
    let release: ((result: PiGenerationResult) => void) | undefined;
    const firstResult = new Promise<PiGenerationResult>((resolve) => {
      release = resolve;
    });
    const pi: PiGateway = {
      checkHealth: vi.fn().mockResolvedValue(undefined),
      setBotDisplayName: vi.fn(),
      generate: vi
        .fn()
        .mockImplementationOnce(() => firstResult)
        .mockResolvedValueOnce({ text: "second", model: "test-model" })
    };
    const { service } = createService(pi);
    const first = service.handleMessage(inbound({ discordMessageId: "first" }));
    const second = service.handleMessage(inbound({ discordMessageId: "second" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(pi.generate).toHaveBeenCalledTimes(1);
    release?.({ text: "first", model: "test-model" });
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(pi.generate).toHaveBeenCalledTimes(2);
  });
});

describe("ConversationService scheduled prompts", () => {
  let repository: ArtemisRepository | undefined;

  afterEach(() => repository?.close());

  function jobRecord(overrides: Partial<ScheduledPromptRecord> = {}): ScheduledPromptRecord {
    return {
      id: overrides.id ?? "job-1",
      conversationKey: overrides.conversationKey ?? "guild:guild-1:channel:group-1",
      prompt: overrides.prompt ?? "Post the weekly standup summary",
      schedule: overrides.schedule ?? { type: "daily", time: "09:15", timezone: "America/Chicago" },
      responseType: overrides.responseType ?? "message",
      scheduledByUserId: overrides.scheduledByUserId ?? "603384387685449728",
      status: overrides.status ?? "active",
      createdAt: overrides.createdAt ?? "2026-08-29T14:30:00.000Z",
      ...(overrides.cancelledAt ? { cancelledAt: overrides.cancelledAt } : {})
    };
  }

  function membershipMock(status: MembershipStatus = "member"): ChannelMembershipChecker {
    return { isChannelMember: vi.fn(async () => status) };
  }

  function createService(
    pi = createPiMock(),
    membership: ChannelMembershipChecker | null = membershipMock()
  ) {
    repository = new ArtemisRepository(":memory:");
    const logger = createLoggerMock();
    const service = new ConversationService(options, repository, pi, logger, undefined, membership ?? undefined);
    return { service, pi, logger, membership };
  }

  it("runs a scheduled job in the stored conversation's session scope with that channel's permissions", async () => {
    const { service, pi, logger } = createService(
      createPiMock({ text: "standup summary" }),
      membershipMock()
    );

    await expect(service.runScheduledPrompt(jobRecord())).resolves.toMatchObject({
      text: "standup summary"
    });

    expect(pi.generate).toHaveBeenCalledTimes(1);
    const input = vi.mocked(pi.generate).mock.calls[0]?.[0];
    expect(input).toMatchObject({
      conversationKey: "guild:guild-1:channel:group-1",
      conversationKind: "guild",
      authorId: "603384387685449728",
      prompt: "Post the weekly standup summary"
    });
    expect(input?.sourceMessageId).toMatch(/^scheduled:job-1:/);
    const session = repository?.getOrCreateSession(
      { key: "guild:guild-1:channel:group-1", kind: "guild", guildId: "guild-1", channelId: "group-1" },
      "test-model"
    );
    expect(repository?.getHistory(session?.id ?? "")).toEqual([
      expect.objectContaining({
        role: "user",
        authorId: "603384387685449728",
        content: "Post the weekly standup summary"
      }),
      expect.objectContaining({ role: "assistant", content: "standup summary" })
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      "scheduled_prompt_succeeded",
      expect.objectContaining({ conversationKey: "guild:guild-1:channel:group-1" })
    );
  });

  it("runs a DM job in the DM conversation's scope", async () => {
    const { service, pi } = createService(
      createPiMock({ text: "dm summary" }),
      membershipMock()
    );

    await expect(
      service.runScheduledPrompt(
        jobRecord({ conversationKey: "dm:dm-1", scheduledByUserId: "603384387685449728" })
      )
    ).resolves.toMatchObject({ text: "dm summary" });

    expect(vi.mocked(pi.generate).mock.calls[0]?.[0]).toMatchObject({
      conversationKey: "dm:dm-1",
      conversationKind: "dm",
      authorId: "603384387685449728"
    });
  });

  it("skips a job whose scheduling user is no longer a member of the channel", async () => {
    const { service, pi, logger } = createService(createPiMock(), membershipMock("not-member"));

    await expect(service.runScheduledPrompt(jobRecord())).resolves.toBeNull();

    expect(pi.generate).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "scheduled_prompt_rejected",
      expect.objectContaining({ code: "membership-revoked", jobId: "job-1" })
    );
  });

  it("denies a job whose scheduled channel left the deployment allow-list", async () => {
    const membership = membershipMock("member");
    const { service, pi, logger } = createService(createPiMock(), membership);

    await expect(
      service.runScheduledPrompt(
        jobRecord({ conversationKey: "guild:guild-9:channel:not-allowed" })
      )
    ).resolves.toBeNull();

    expect(pi.generate).not.toHaveBeenCalled();
    expect(membership.isChannelMember).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "scheduled_prompt_rejected",
      expect.objectContaining({ code: "channel-not-allowed", conversationKey: "guild:guild-9:channel:not-allowed" })
    );
  });

  it("denies a DM job for a user outside the authorized DM allow-list", async () => {
    const membership = membershipMock("member");
    const { service, pi, logger } = createService(createPiMock(), membership);

    await expect(
      service.runScheduledPrompt(
        jobRecord({ conversationKey: "dm:dm-1", scheduledByUserId: "stranger" })
      )
    ).resolves.toBeNull();

    expect(pi.generate).not.toHaveBeenCalled();
    expect(membership.isChannelMember).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "scheduled_prompt_rejected",
      expect.objectContaining({ code: "user-not-authorized" })
    );
  });

  it("denies a job whose stored conversation key the harness could not have derived", async () => {
    const membership = membershipMock("member");
    const { service, pi, logger } = createService(createPiMock(), membership);

    await expect(
      service.runScheduledPrompt(jobRecord({ conversationKey: "user:123" }))
    ).resolves.toBeNull();

    expect(pi.generate).not.toHaveBeenCalled();
    expect(membership.isChannelMember).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "scheduled_prompt_rejected",
      expect.objectContaining({ code: "invalid-scope" })
    );
  });

  it("denies a legacy job with no recorded scheduling user", async () => {
    const membership = membershipMock("member");
    const { service, pi, logger } = createService(createPiMock(), membership);

    await expect(service.runScheduledPrompt(jobRecord({ scheduledByUserId: "" }))).resolves
      .toBeNull();

    expect(pi.generate).not.toHaveBeenCalled();
    expect(membership.isChannelMember).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "scheduled_prompt_rejected",
      expect.objectContaining({ code: "unattributed-scheduler" })
    );
  });

  it("proceeds when the fire-time membership check cannot be reached, logging that it was unverified", async () => {
    const { service, logger } = createService(
      createPiMock({ text: "still ran" }),
      membershipMock("unknown")
    );

    await expect(service.runScheduledPrompt(jobRecord())).resolves.toMatchObject({ text: "still ran" });

    expect(logger.warn).toHaveBeenCalledWith(
      "scheduled_prompt_membership_unverified",
      expect.objectContaining({ conversationKey: "guild:guild-1:channel:group-1" })
    );
    expect(logger.info).toHaveBeenCalledWith(
      "scheduled_prompt_succeeded",
      expect.objectContaining({})
    );
  });

  it("proceeds for allow-listed scopes when no membership checker is wired, with a warning", async () => {
    const { service, pi, logger } = createService(createPiMock(), null);

    await expect(service.runScheduledPrompt(jobRecord())).resolves.toMatchObject({
      text: "assistant response"
    });

    expect(pi.generate).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "scheduled_prompt_membership_unverified",
      expect.any(Object)
    );
  });

  it("serializes a scheduled run against interactive traffic in the same conversation", async () => {
    let release: ((result: PiGenerationResult) => void) | undefined;
    const firstResult = new Promise<PiGenerationResult>((resolve) => {
      release = resolve;
    });
    const pi: PiGateway = {
      checkHealth: vi.fn().mockResolvedValue(undefined),
      setBotDisplayName: vi.fn(),
      generate: vi
        .fn()
        .mockImplementationOnce(() => firstResult)
        .mockResolvedValueOnce({ text: "fired", model: "test-model" })
    };
    const { service } = createService(pi, membershipMock());
    const interactive = service.handleMessage(inbound({ discordMessageId: "interactive" }));
    const scheduled = service.runScheduledPrompt(jobRecord());
    await Promise.resolve();
    await Promise.resolve();
    expect(pi.generate).toHaveBeenCalledTimes(1);
    release?.({ text: "first", model: "test-model" });
    await expect(Promise.all([interactive, scheduled])).resolves.toEqual([
      "first",
      { text: "fired", model: "test-model" }
    ]);
  });

  it("records a failure event and returns null when the scheduled generation throws", async () => {
    const pi = createPiMock();
    vi.mocked(pi.generate).mockRejectedValue(new Error("model unavailable"));
    const { service, logger } = createService(pi, membershipMock());

    await expect(service.runScheduledPrompt(jobRecord())).resolves.toBeNull();

    expect(logger.error).toHaveBeenCalledWith(
      "scheduled_prompt_failed",
      expect.objectContaining({ jobId: "job-1", conversationKey: "guild:guild-1:channel:group-1" })
    );
  });
});
