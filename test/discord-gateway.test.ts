import { EventEmitter } from "node:events";
import { Collection, Events, type Client, type Interaction, type Message, type ThreadChannel } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationService } from "../src/conversation-service.js";
import type { InboundMessage } from "../src/domain.js";
import {
  DiscordGateway,
  createTypingIndicator,
  fetchEntireThread,
  splitDiscordMessage,
  toInboundMessage
} from "../src/discord-gateway.js";
import { createLoggerMock } from "./helpers.js";

class FakeClient extends EventEmitter {
  public readonly login = vi.fn().mockResolvedValue("token");
  public readonly destroy = vi.fn();
  public readonly user = { id: "artemis-user" };
  public readonly application = { commands: { set: vi.fn().mockResolvedValue(new Collection()) } };
}

function fakeMessage(overrides: Record<string, unknown> = {}): Message {
  const channel = {
    id: "channel",
    isThread: () => false,
    isSendable: () => true,
    sendTyping: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined)
  };
  return {
    id: "message",
    author: { id: "user", username: "user", globalName: null, bot: false },
    member: null,
    content: "hello",
    createdAt: new Date("2026-08-19T00:00:00.000Z"),
    createdTimestamp: Date.parse("2026-08-19T00:00:00.000Z"),
    guildId: null,
    channelId: "channel",
    mentions: { parsedUsers: new Collection(), roles: new Collection() },
    channel,
    reply: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as Message;
}

describe("Discord helpers", () => {
  afterEach(() => vi.useRealTimers());

  it("splits long responses at natural boundaries", () => {
    expect(splitDiscordMessage("short", 10)).toEqual(["short"]);
    expect(splitDiscordMessage("one two three four", 10)).toEqual(["one two", "three four"]);
    expect(splitDiscordMessage("abcdefghijkl", 5)).toEqual(["abcde", "fghij", "kl"]);
  });

  it("normalizes DMs and threads", async () => {
    const direct = toInboundMessage(fakeMessage(), "artemis-user");
    expect(direct).toMatchObject({
      channelId: "channel",
      role: "user",
      isBot: false,
      mentionsBot: false
    });
    expect(direct.guildId).toBeUndefined();

    const thread = {
      id: "thread",
      parentId: "parent",
      isThread: () => true,
      isSendable: () => true,
      fetchStarterMessage: vi.fn().mockResolvedValue(null),
      messages: {
        fetch: vi.fn().mockResolvedValue({ size: 0, values: () => [], last: () => undefined })
      }
    };
    const normalized = toInboundMessage(
      fakeMessage({
        guildId: "guild",
        channelId: "thread",
        channel: thread,
        mentions: {
          parsedUsers: new Collection([["artemis-user", { id: "artemis-user" }]]),
          roles: new Collection()
        }
      }),
      "artemis-user"
    );
    expect(normalized).toMatchObject({
      guildId: "guild",
      channelId: "thread",
      parentChannelId: "parent",
      threadId: "thread",
      mentionsBot: true
    });
    await expect(normalized.loadThread?.()).resolves.toEqual([]);
  });

  it("recognizes only the bot's managed role as a bot mention", () => {
    const botRoleMention = toInboundMessage(
      fakeMessage({
        guildId: "guild",
        content: "<@&bot-role> hello",
        mentions: {
          parsedUsers: new Collection(),
          roles: new Collection([
            ["bot-role", { id: "bot-role", tags: { botId: "artemis-user" } }]
          ])
        }
      }),
      "artemis-user"
    );
    const unrelatedRoleMention = toInboundMessage(
      fakeMessage({
        guildId: "guild",
        content: "<@&other-role> hello",
        mentions: {
          parsedUsers: new Collection(),
          roles: new Collection([
            ["other-role", { id: "other-role", tags: { botId: "another-bot" } }]
          ])
        }
      }),
      "artemis-user"
    );

    expect(botRoleMention.mentionsBot).toBe(true);
    expect(unrelatedRoleMention.mentionsBot).toBe(false);
  });

  it.each(["@everyone hello", "@here hello"])(
    "does not treat %s as a direct bot mention",
    (content) => {
      const normalized = toInboundMessage(
        fakeMessage({
          guildId: "guild",
          content,
          mentions: { everyone: true, parsedUsers: new Collection(), roles: new Collection() }
        }),
        "artemis-user"
      );

      expect(normalized.mentionsBot).toBe(false);
    }
  );

  it("fetches, deduplicates, and orders the complete thread", async () => {
    const starter = fakeMessage({ id: "starter", createdTimestamp: 1 });
    const later = fakeMessage({ id: "later", createdTimestamp: 3, content: "later" });
    const earlier = fakeMessage({ id: "earlier", createdTimestamp: 2, content: "earlier" });
    const page = new Collection<string, Message>([
      ["later", later],
      ["earlier", earlier],
      ["starter", starter]
    ]);
    const thread = {
      fetchStarterMessage: vi.fn().mockResolvedValue(starter),
      messages: { fetch: vi.fn().mockResolvedValue(page) }
    } as unknown as ThreadChannel;
    const messages = await fetchEntireThread(thread, "artemis-user");
    expect(messages.map((message) => message.discordMessageId)).toEqual(["starter", "earlier", "later"]);
  });

  it("starts, refreshes, and stops a typing indicator", async () => {
    vi.useFakeTimers();
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const message = fakeMessage({
      channel: { isThread: () => false, isSendable: () => true, sendTyping }
    });
    const indicator = createTypingIndicator(message, createLoggerMock(), 100);

    await indicator.start();
    expect(sendTyping).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(300);
    expect(sendTyping).toHaveBeenCalledTimes(4);
    indicator.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(sendTyping).toHaveBeenCalledTimes(4);
  });

  it("logs a typing failure without scheduling refreshes", async () => {
    vi.useFakeTimers();
    const logger = createLoggerMock();
    const sendTyping = vi.fn().mockRejectedValue(new Error("missing permission"));
    const message = fakeMessage({
      channel: { isThread: () => false, isSendable: () => true, sendTyping }
    });
    const indicator = createTypingIndicator(message, logger, 100);

    await indicator.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(logger.warn).toHaveBeenCalledWith(
      "discord_typing_failed",
      expect.objectContaining({
        discordMessageId: "message",
        errorMessage: "missing permission"
      })
    );
    expect(sendTyping).toHaveBeenCalledOnce();
  });

  it("continues when the Discord channel cannot show typing", async () => {
    const logger = createLoggerMock();
    const message = fakeMessage({
      channel: { isThread: () => false, isSendable: () => true }
    });
    const indicator = createTypingIndicator(message, logger, 100);

    await indicator.start();
    expect(logger.warn).toHaveBeenCalledWith("discord_typing_unavailable", {
      discordMessageId: "message",
      channelId: "channel"
    });
  });
});

describe("DiscordGateway", () => {
  it("handles ping for authorized DMs and allowed channels across guilds", async () => {
    const conversations = { handleMessage: vi.fn() } as unknown as ConversationService;
    const gateway = new DiscordGateway(
      {
        token: "token",
        channelIds: ["group-one", "group-two"],
        userIds: ["allowed-user"]
      },
      conversations,
      createLoggerMock(),
      new FakeClient() as unknown as Client
    );
    const reply = vi.fn().mockResolvedValue(undefined);
    await gateway.handleInteraction({
      isChatInputCommand: () => true,
      commandName: "ping",
      guildId: null,
      channelId: "dm",
      channel: null,
      user: { id: "allowed-user" },
      reply
    } as unknown as Interaction);
    await gateway.handleInteraction({
      isChatInputCommand: () => true,
      commandName: "ping",
      guildId: null,
      channelId: "dm-other",
      channel: null,
      user: { id: "unauthorized-user" },
      reply
    } as unknown as Interaction);
    await gateway.handleInteraction({
      isChatInputCommand: () => true,
      commandName: "ping",
      guildId: "guild",
      channelId: "group-one",
      channel: { isThread: () => false },
      user: { id: "unauthorized-user" },
      reply
    } as unknown as Interaction);
    await gateway.handleInteraction({
      isChatInputCommand: () => true,
      commandName: "ping",
      guildId: "guild",
      channelId: "not-allowed",
      channel: { isThread: () => false },
      user: { id: "allowed-user" },
      reply
    } as unknown as Interaction);
    await gateway.handleInteraction({
      isChatInputCommand: () => true,
      commandName: "ping",
      guildId: "guild",
      channelId: "thread",
      channel: { isThread: () => true, parentId: "group-two" },
      user: { id: "unauthorized-user" },
      reply
    } as unknown as Interaction);
    await gateway.handleInteraction({
      isChatInputCommand: () => true,
      commandName: "ping",
      guildId: "other",
      channelId: "group-one",
      channel: { isThread: () => false },
      user: { id: "allowed-user" },
      reply
    } as unknown as Interaction);
    await gateway.handleInteraction({ isChatInputCommand: () => false } as unknown as Interaction);
    expect(reply).toHaveBeenCalledTimes(4);
    expect(reply).toHaveBeenNthCalledWith(1, "pong");
  });

  it("sends generated responses in Discord-safe chunks", async () => {
    const conversations = {
      handleMessage: vi.fn().mockResolvedValue(`${"a".repeat(2_000)} ${"b".repeat(10)}`)
    } as unknown as ConversationService;
    const client = new FakeClient();
    const gateway = new DiscordGateway(
      { token: "token", channelIds: ["group-one"], userIds: ["user"] },
      conversations,
      createLoggerMock(),
      client as unknown as Client
    );
    const send = vi.fn().mockResolvedValue(undefined);
    const message = fakeMessage({
      channel: {
        isThread: () => false,
        isSendable: () => true,
        sendTyping: vi.fn().mockResolvedValue(undefined),
        send
      }
    });
    await gateway.handleMessage(message);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("uses replies for guild responses and ordinary sends for DMs", async () => {
    const conversations = {
      handleMessage: vi.fn().mockImplementation(async (message: InboundMessage) => {
        await message.responseIndicator?.start();
        message.responseIndicator?.stop();
        return message.guildId ? `${"a".repeat(2_000)} ${"b".repeat(10)}` : "response";
      })
    } as unknown as ConversationService;
    const gateway = new DiscordGateway(
      { token: "token", channelIds: ["channel"], userIds: ["user"] },
      conversations,
      createLoggerMock(),
      new FakeClient() as unknown as Client
    );
    const guildSend = vi.fn().mockResolvedValue(undefined);
    const guildReply = vi.fn().mockResolvedValue(undefined);
    const guildTyping = vi.fn().mockResolvedValue(undefined);
    await gateway.handleMessage(
      fakeMessage({
        guildId: "guild",
        reply: guildReply,
        channel: {
          isThread: () => false,
          isSendable: () => true,
          sendTyping: guildTyping,
          send: guildSend
        }
      })
    );
    expect(guildTyping).toHaveBeenCalledOnce();
    expect(guildReply).toHaveBeenCalledTimes(2);
    expect(guildSend).not.toHaveBeenCalled();

    const dmSend = vi.fn().mockResolvedValue(undefined);
    const dmReply = vi.fn().mockResolvedValue(undefined);
    await gateway.handleMessage(
      fakeMessage({
        reply: dmReply,
        channel: {
          isThread: () => false,
          isSendable: () => true,
          sendTyping: vi.fn().mockResolvedValue(undefined),
          send: dmSend
        }
      })
    );
    expect(dmSend).toHaveBeenCalledWith("response");
    expect(dmReply).not.toHaveBeenCalled();
  });

  it("logs every Discord message with its content before routing", async () => {
    const conversations = { handleMessage: vi.fn().mockResolvedValue(null) };
    const logger = createLoggerMock();
    const gateway = new DiscordGateway(
      { token: "token", channelIds: ["group-one"], userIds: ["user"] },
      conversations as unknown as ConversationService,
      logger,
      new FakeClient() as unknown as Client
    );
    const message = fakeMessage({
      id: "guild-message",
      guildId: "guild",
      content: "visible server message",
      author: { id: "server-user", username: "server-user", globalName: null, bot: true }
    });

    await gateway.handleMessage(message);

    expect(logger.audit).toHaveBeenCalledWith("discord_message_received", {
      discordMessageId: "guild-message",
      guildId: "guild",
      channelId: "channel",
      authorId: "server-user",
      authorName: "server-user",
      isBot: true,
      content: "visible server message",
      createdAt: "2026-08-19T00:00:00.000Z"
    });
    expect(vi.mocked(logger.audit).mock.invocationCallOrder[0]).toBeLessThan(
      conversations.handleMessage.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );

    await gateway.handleMessage(fakeMessage({ guildId: "other", id: "other-message" }));
    await gateway.handleMessage(fakeMessage({ guildId: null, id: "dm-message" }));
    expect(logger.audit).toHaveBeenCalledTimes(3);
    expect(logger.audit).toHaveBeenNthCalledWith(
      2,
      "discord_message_received",
      expect.objectContaining({ discordMessageId: "other-message", guildId: "other" })
    );
    expect(logger.audit).toHaveBeenNthCalledWith(
      3,
      "discord_message_received",
      expect.objectContaining({ discordMessageId: "dm-message", guildId: null })
    );
  });

  it("does not send null responses and warns for non-sendable channels", async () => {
    const conversations = { handleMessage: vi.fn().mockResolvedValue(null) };
    const logger = createLoggerMock();
    const gateway = new DiscordGateway(
      { token: "token", channelIds: ["group-one"], userIds: ["user"] },
      conversations as unknown as ConversationService,
      logger,
      new FakeClient() as unknown as Client
    );
    await gateway.handleMessage(fakeMessage());

    conversations.handleMessage.mockResolvedValue("response");
    await gateway.handleMessage(
      fakeMessage({ channel: { isThread: () => false, isSendable: () => false } })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "discord_channel_not_sendable",
      expect.objectContaining({ channelId: "channel" })
    );
  });

  it("binds Discord lifecycle handlers, registers ping, logs in, and stops", async () => {
    const client = new FakeClient();
    const logger = createLoggerMock();
    const gateway = new DiscordGateway(
      { token: "token", channelIds: ["group-one"], userIds: ["user"] },
      { handleMessage: vi.fn().mockResolvedValue(null) } as unknown as ConversationService,
      logger,
      client as unknown as Client
    );
    await gateway.start();
    await gateway.start();
    expect(client.login).toHaveBeenCalledTimes(2);

    client.emit(Events.ClientReady, client);
    client.emit(Events.ShardDisconnect, { code: 1000 }, 0);
    client.emit(Events.ShardReconnecting, 0);
    client.emit(Events.ShardResume, 0, 2);
    client.emit(Events.Error, new Error("socket"));
    client.emit(Events.Warn, "warning");
    await Promise.resolve();

    expect(client.application.commands.set).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      "discord_ready",
      expect.objectContaining({ botUserId: "artemis-user", channelIds: ["group-one"] })
    );
    expect(logger.warn).toHaveBeenCalledWith("discord_disconnected", { shardId: 0, closeCode: 1000 });
    expect(logger.error).toHaveBeenCalledWith(
      "discord_error",
      expect.objectContaining({ errorMessage: "socket" })
    );
    gateway.stop();
    expect(client.destroy).toHaveBeenCalledOnce();
  });
});
