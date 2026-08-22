import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConversationService,
  deriveConversationIdentity
} from "../src/conversation-service.js";
import type { PiGateway, PiGenerationResult, SourceMessage } from "../src/domain.js";
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
    expect(vi.mocked(pi.generate).mock.calls[0]?.[0].prompt).toContain(
      '"author":{"id":"not-in-dm-user-allowlist","name":"Matt"}'
    );
    expect(vi.mocked(pi.generate).mock.calls[1]?.[0].conversationKind).toBe("dm");
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

  it("restores prior history for a later service instance without crossing conversations", async () => {
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
    expect(input?.history.map((message) => message.content)).toEqual(["Hello Artemis", "first"]);
    expect(input?.history).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ discordMessageId: "other" })])
    );
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
