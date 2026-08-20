import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConversationService,
  deriveConversationIdentity,
  formatThreadSnapshot
} from "../src/conversation-service.js";
import type { PiGateway, PiGenerationResult, SourceMessage } from "../src/domain.js";
import { ArtemisRepository } from "../src/repository.js";
import { createLoggerMock, createPiMock, inbound } from "./helpers.js";

const options = {
  guildId: "guild-1",
  authorizedUserId: "603384387685449728",
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

  it("formats a complete chronological thread with author labels", () => {
    const messages: SourceMessage[] = [
      {
        discordMessageId: "2",
        authorId: "artemis",
        authorName: "Artemis",
        role: "assistant",
        content: "answer",
        createdAt: "2026-08-19T00:00:02.000Z"
      },
      {
        discordMessageId: "1",
        authorId: "user",
        authorName: "Matt",
        role: "user",
        content: "question",
        createdAt: "2026-08-19T00:00:01.000Z"
      }
    ];
    expect(formatThreadSnapshot(messages)).toContain(
      "[2026-08-19T00:00:01.000Z] Matt (user): question\n" +
        "[2026-08-19T00:00:02.000Z] Artemis: answer"
    );
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

  it("silently ignores bots, empty messages, unsupported guilds, unmentioned guild messages, and unauthorized users", async () => {
    const { service, pi, logger } = createService();
    await expect(service.handleMessage(inbound({ isBot: true }))).resolves.toBeNull();
    await expect(service.handleMessage(inbound({ content: " " }))).resolves.toBeNull();
    await expect(service.handleMessage(inbound({ guildId: "other" }))).resolves.toBeNull();
    await expect(service.handleMessage(inbound({ guildId: "guild-1" }))).resolves.toBeNull();
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

  it("responds to a mentioned guild message without changing DM behavior", async () => {
    const { service, pi } = createService(createPiMock({ text: "Hello group" }));

    await expect(
      service.handleMessage(
        inbound({
          discordMessageId: "guild-message",
          guildId: "guild-1",
          channelId: "guild-channel",
          mentionsBot: true,
          content: "<@artemis> hello"
        })
      )
    ).resolves.toBe("Hello group");
    await expect(
      service.handleMessage(
        inbound({ discordMessageId: "dm-message", channelId: "dm-channel", mentionsBot: false })
      )
    ).resolves.toBe("Hello group");

    expect(pi.generate).toHaveBeenCalledTimes(2);
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

  it("loads and resubmits the complete thread after authorization", async () => {
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
        authorId: options.authorizedUserId,
        authorName: "Matt",
        role: "user",
        content: "new message",
        createdAt: "2026-08-19T12:00:00.000Z"
      }
    ] satisfies SourceMessage[]);
    await service.handleMessage(
      inbound({
        guildId: "guild-1",
        channelId: "thread",
        parentChannelId: "parent",
        mentionsBot: true,
        loadThread
      })
    );

    expect(loadThread).toHaveBeenCalledOnce();
    expect(vi.mocked(pi.generate).mock.calls[0]?.[0].prompt).toContain("old message");
    expect(vi.mocked(pi.generate).mock.calls[0]?.[0].prompt).toContain("new message");
    const session = repository?.getOrCreateSession(
      { key: "guild:guild-1:channel:parent", kind: "guild", guildId: "guild-1", channelId: "parent" },
      "test-model"
    );
    expect(repository?.getHistory(session?.id ?? "").filter((message) => message.role === "user")).toHaveLength(2);
  });

  it("does not load a thread for an unmentioned or unauthorized trigger", async () => {
    const { service } = createService();
    const loadThread = vi.fn().mockResolvedValue([]);
    await service.handleMessage(
      inbound({ guildId: "guild-1", mentionsBot: false, loadThread })
    );
    await service.handleMessage(
      inbound({
        discordMessageId: "unauthorized",
        authorId: "other",
        guildId: "guild-1",
        mentionsBot: true,
        loadThread
      })
    );
    expect(loadThread).not.toHaveBeenCalled();
  });

  it("logs PI failures without returning or persisting an assistant response", async () => {
    const pi = createPiMock();
    vi.mocked(pi.generate).mockRejectedValue(new Error("provider secret details"));
    const { service, logger } = createService(pi);
    await expect(service.handleMessage(inbound())).resolves.toBeNull();
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
