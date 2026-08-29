import { EventEmitter } from "node:events";
import { Collection, Events, MessageFlags, type Client, type Interaction, type Message, type ThreadChannel } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationService } from "../src/conversation-service.js";
import type { InboundMessage } from "../src/domain.js";
import {
  DiscordGateway,
  createTypingIndicator,
  fetchEntireThread,
  formatUptime,
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

class FakeReadyClient extends EventEmitter {
  public readonly login = vi.fn().mockResolvedValue("token");
  public readonly destroy = vi.fn();
  public readonly application = { commands: { set: vi.fn().mockResolvedValue(new Collection()) } };
  public constructor(public readonly user: { id: string; username: string; globalName: string | null }) {
    super();
  }
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
    mentions: { parsedUsers: new Collection(), roles: new Collection(), repliedUser: null },
    channel,
    reply: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as Message;
}

describe("Discord helpers", () => {
  afterEach(() => vi.useRealTimers());

  it("formats elapsed milliseconds as concise human-readable uptime", () => {
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(30_000)).toBe("30s");
    expect(formatUptime(59_000)).toBe("59s");
    expect(formatUptime(60_000)).toBe("1m");
    expect(formatUptime(90_000)).toBe("1m");
    expect(formatUptime(3_600_000)).toBe("1h 0m");
    expect(formatUptime(3_660_000)).toBe("1h 1m");
    expect(formatUptime(86_400_000)).toBe("1d 0h 0m");
    expect(formatUptime(3 * 86_400_000 + 4 * 3_600_000 + 12 * 60_000)).toBe("3d 4h 12m");
  });

  it("clamps negative elapsed time to zero", () => {
    expect(formatUptime(-5_000)).toBe("0s");
  });

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
      mentionsBot: false,
      repliesToBot: false
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
      mentionsBot: true,
      repliesToBot: false
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

  it("recognizes a direct reply to the bot without requiring a mention", () => {
    const botReply = toInboundMessage(
      fakeMessage({
        guildId: "guild",
        mentions: {
          repliedUser: { id: "artemis-user" },
          parsedUsers: new Collection(),
          roles: new Collection()
        }
      }),
      "artemis-user"
    );
    const otherReply = toInboundMessage(
      fakeMessage({
        guildId: "guild",
        mentions: {
          repliedUser: { id: "another-user" },
          parsedUsers: new Collection(),
          roles: new Collection()
        }
      }),
      "artemis-user"
    );

    expect(botReply).toMatchObject({ mentionsBot: false, repliesToBot: true });
    expect(otherReply).toMatchObject({ mentionsBot: false, repliesToBot: false });
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
  it("registers ping, uptime, and clear-session slash commands", async () => {
    const client = new FakeClient();
    const gateway = new DiscordGateway(
      { token: "token", channelIds: ["group-one"], userIds: ["user"] },
      { handleMessage: vi.fn() } as unknown as ConversationService,
      createLoggerMock(),
      client as unknown as Client
    );
    await gateway.start();
    client.emit(Events.ClientReady, client);
    await Promise.resolve();
    expect(client.application.commands.set).toHaveBeenCalledOnce();
    const commands = vi.mocked(client.application.commands.set).mock.calls[0]?.[0] as Array<{ name: string }>;
    expect(commands.map((command) => command.name).sort()).toEqual(["clear-session", "ping", "uptime"]);
  });

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
    expect(reply).toHaveBeenNthCalledWith(1, expect.objectContaining({ content: "pong" }));
  });

  it("replies to /uptime with elapsed time since startup for authorized contexts", async () => {
    const conversations = { handleMessage: vi.fn() } as unknown as ConversationService;
    const startedAt = 1_000_000;
    const now = vi.fn(() => 1_000_000 + 3 * 86_400_000 + 4 * 3_600_000 + 12 * 60_000);
    const gateway = new DiscordGateway(
      { token: "token", channelIds: ["group-one"], userIds: ["allowed-user"], startedAt, now },
      conversations,
      createLoggerMock(),
      new FakeClient() as unknown as Client
    );
    const reply = vi.fn().mockResolvedValue(undefined);
    await gateway.handleInteraction({
      isChatInputCommand: () => true,
      commandName: "uptime",
      guildId: null,
      channelId: "dm",
      channel: null,
      user: { id: "allowed-user" },
      reply
    } as unknown as Interaction);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: "I've been up 3d 4h 12m." }));

    const unauthorizedReply = vi.fn().mockResolvedValue(undefined);
    await gateway.handleInteraction({
      isChatInputCommand: () => true,
      commandName: "uptime",
      guildId: null,
      channelId: "dm-other",
      channel: null,
      user: { id: "unauthorized-user" },
      reply: unauthorizedReply
    } as unknown as Interaction);
    expect(unauthorizedReply).not.toHaveBeenCalled();
  });

  it("sends generated responses in Discord-safe chunks", async () => {
    const conversations = {
      handleMessage: vi.fn().mockResolvedValue(`${"a".repeat(2_000)} ${"b".repeat(10)}`),
      logMessage: vi.fn()
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
      }),
      logMessage: vi.fn()
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
    expect(dmSend).toHaveBeenCalledWith(expect.objectContaining({ content: "response" }));
    expect(dmReply).not.toHaveBeenCalled();
  });

  it("logs every Discord message with its content before routing", async () => {
    const conversations = {
      handleMessage: vi.fn().mockResolvedValue(null),
      logMessage: vi.fn()
    };
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

  it("persists every incoming message to the history log independently of the response", async () => {
    const conversations = {
      handleMessage: vi.fn().mockResolvedValue(null),
      logMessage: vi.fn()
    };
    const gateway = new DiscordGateway(
      { token: "token", channelIds: ["group-one"], userIds: ["user"] },
      conversations as unknown as ConversationService,
      createLoggerMock(),
      new FakeClient() as unknown as Client
    );

    const botMessage = fakeMessage({
      id: "bot-message",
      guildId: "guild",
      author: { id: "other-bot", username: "other-bot", globalName: null, bot: true },
      content: "other bot chatter"
    });
    const unmentioned = fakeMessage({
      id: "unmentioned",
      guildId: "guild",
      channelId: "group-one",
      content: "channel chatter"
    });
    const dm = fakeMessage({ id: "dm-message", guildId: null, content: "hi" });

    await gateway.handleMessage(botMessage);
    await gateway.handleMessage(unmentioned);
    await gateway.handleMessage(dm);

    expect(conversations.logMessage).toHaveBeenCalledTimes(3);
    expect(conversations.logMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        discordMessageId: "bot-message",
        isBot: true,
        content: "other bot chatter"
      })
    );
    expect(conversations.logMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ discordMessageId: "unmentioned", mentionsBot: false })
    );
    expect(conversations.logMessage).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ discordMessageId: "dm-message", channelId: "channel", content: "hi" })
    );
    const dmLogged = vi.mocked(conversations.logMessage).mock.calls[2]?.[0];
    expect(dmLogged?.guildId).toBeUndefined();
    // logging happens before the response pipeline is invoked
    expect(vi.mocked(conversations.logMessage).mock.invocationCallOrder[0]).toBeLessThan(
      conversations.handleMessage.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );
  });

  it("does not send null responses and warns for non-sendable channels", async () => {
    const conversations = { handleMessage: vi.fn().mockResolvedValue(null), logMessage: vi.fn() };
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

  it("clears and confirms the active session for authorized clear-session commands", async () => {
    const clearSession = vi.fn().mockReturnValue({ cleared: true });
    const conversations = {
      handleMessage: vi.fn(),
      clearSession
    } as unknown as ConversationService;
    const gateway = new DiscordGateway(
      { token: "token", channelIds: ["group-one"], userIds: ["allowed-user"] },
      conversations,
      createLoggerMock(),
      new FakeClient() as unknown as Client
    );
    const reply = vi.fn().mockResolvedValue(undefined);

    // authorized DM
    await gateway.handleInteraction({
      isChatInputCommand: () => true,
      commandName: "clear-session",
      guildId: null,
      channelId: "dm",
      channel: null,
      user: { id: "allowed-user" },
      reply
    } as unknown as Interaction);
    expect(clearSession).toHaveBeenLastCalledWith({ channelId: "dm" });
    expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.stringMatching(/cleared/i) }));

    // authorized guild thread, scoped to the parent channel
    await gateway.handleInteraction({
      isChatInputCommand: () => true,
      commandName: "clear-session",
      guildId: "guild",
      channelId: "thread",
      channel: { isThread: () => true, parentId: "group-one" },
      user: { id: "anyone" },
      reply
    } as unknown as Interaction);
    expect(clearSession).toHaveBeenLastCalledWith({
      guildId: "guild",
      channelId: "thread",
      parentChannelId: "group-one"
    });
    expect(reply).toHaveBeenCalledTimes(2);
  });

  it("reports nothing to clear when no active session exists", async () => {
    const clearSession = vi.fn().mockReturnValue({ cleared: false });
    const conversations = {
      handleMessage: vi.fn(),
      clearSession
    } as unknown as ConversationService;
    const gateway = new DiscordGateway(
      { token: "token", channelIds: ["group-one"], userIds: ["allowed-user"] },
      conversations,
      createLoggerMock(),
      new FakeClient() as unknown as Client
    );
    const reply = vi.fn().mockResolvedValue(undefined);
    await gateway.handleInteraction({
      isChatInputCommand: () => true,
      commandName: "clear-session",
      guildId: null,
      channelId: "dm",
      channel: null,
      user: { id: "allowed-user" },
      reply
    } as unknown as Interaction);
    expect(clearSession).toHaveBeenCalledWith({ channelId: "dm" });
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/no active session/i) }));
  });

  it("ignores clear-session from unauthorized DMs and disallowed channels", async () => {
    const clearSession = vi.fn();
    const conversations = {
      handleMessage: vi.fn(),
      clearSession
    } as unknown as ConversationService;
    const gateway = new DiscordGateway(
      { token: "token", channelIds: ["group-one"], userIds: ["allowed-user"] },
      conversations,
      createLoggerMock(),
      new FakeClient() as unknown as Client
    );
    const reply = vi.fn().mockResolvedValue(undefined);
    await gateway.handleInteraction({
      isChatInputCommand: () => true,
      commandName: "clear-session",
      guildId: null,
      channelId: "dm",
      channel: null,
      user: { id: "unauthorized-user" },
      reply
    } as unknown as Interaction);
    await gateway.handleInteraction({
      isChatInputCommand: () => true,
      commandName: "clear-session",
      guildId: "guild",
      channelId: "not-allowed",
      channel: { isThread: () => false },
      user: { id: "allowed-user" },
      reply
    } as unknown as Interaction);
    expect(clearSession).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
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
    const commands = vi.mocked(client.application.commands.set).mock.calls[0]?.[0] ?? [];
    expect(commands.map((command: { name: string }) => command.name)).toEqual(
      expect.arrayContaining(["ping", "uptime", "clear-session"])
    );
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

  it("resolves the bot display name from Discord on ready and reports it", async () => {
    const onBotIdentity = vi.fn();
    const client = new FakeReadyClient({ id: "kipp-user", username: "kipp_bot", globalName: "KIPP" });
    const logger = createLoggerMock();
    const gateway = new DiscordGateway(
      { token: "token", channelIds: ["group-one"], userIds: ["user"], onBotIdentity },
      { handleMessage: vi.fn().mockResolvedValue(null) } as unknown as ConversationService,
      logger,
      client as unknown as Client
    );
    await gateway.start();
    client.emit(Events.ClientReady, client);
    await Promise.resolve();

    expect(onBotIdentity).toHaveBeenCalledWith("KIPP");
    expect(logger.info).toHaveBeenCalledWith(
      "discord_ready",
      expect.objectContaining({ botUserId: "kipp-user", botDisplayName: "KIPP" })
    );
  });

  it("falls back to the Discord username when no global display name is set", async () => {
    const onBotIdentity = vi.fn();
    const client = new FakeReadyClient({ id: "kipp-user", username: "kipp_bot", globalName: null });
    const gateway = new DiscordGateway(
      { token: "token", channelIds: ["group-one"], userIds: ["user"], onBotIdentity },
      { handleMessage: vi.fn().mockResolvedValue(null) } as unknown as ConversationService,
      createLoggerMock(),
      client as unknown as Client
    );
    await gateway.start();
    client.emit(Events.ClientReady, client);
    await Promise.resolve();

    expect(onBotIdentity).toHaveBeenCalledWith("kipp_bot");
  });

  it("does not report a display name when the Discord user is unavailable", async () => {
    const onBotIdentity = vi.fn();
    const client = new EventEmitter();
    Object.assign(client, {
      login: vi.fn().mockResolvedValue("token"),
      destroy: vi.fn(),
      user: null,
      application: { commands: { set: vi.fn().mockResolvedValue(new Collection()) } }
    });
    const gateway = new DiscordGateway(
      { token: "token", channelIds: ["group-one"], userIds: ["user"], onBotIdentity },
      { handleMessage: vi.fn().mockResolvedValue(null) } as unknown as ConversationService,
      createLoggerMock(),
      client as unknown as Client
    );
    await gateway.start();
    client.emit(Events.ClientReady, client);
    await Promise.resolve();

    expect(onBotIdentity).not.toHaveBeenCalled();
  });
});

describe("DiscordGateway link-embed suppression", () => {
  it("suppresses embeds on guild replies and DM sends by default", async () => {
    const conversations = {
      handleMessage: vi.fn().mockResolvedValue("response with https://example.com link"),
      logMessage: vi.fn()
    } as unknown as ConversationService;
    const gateway = new DiscordGateway(
      { token: "token", channelIds: ["channel"], userIds: ["user"] },
      conversations,
      createLoggerMock(),
      new FakeClient() as unknown as Client
    );

    const guildReply = vi.fn().mockResolvedValue(undefined);
    await gateway.handleMessage(
      fakeMessage({
        guildId: "guild",
        reply: guildReply,
        channel: {
          isThread: () => false,
          isSendable: () => true,
          sendTyping: vi.fn().mockResolvedValue(undefined),
          send: vi.fn()
        }
      })
    );
    expect(guildReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "response with https://example.com link",
        flags: MessageFlags.SuppressEmbeds
      })
    );

    const dmSend = vi.fn().mockResolvedValue(undefined);
    await gateway.handleMessage(
      fakeMessage({
        reply: vi.fn(),
        channel: {
          isThread: () => false,
          isSendable: () => true,
          sendTyping: vi.fn().mockResolvedValue(undefined),
          send: dmSend
        }
      })
    );
    expect(dmSend).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "response with https://example.com link",
        flags: MessageFlags.SuppressEmbeds
      })
    );
  });

  it("suppresses embeds on slash-command replies by default", async () => {
    const gateway = new DiscordGateway(
      { token: "token", channelIds: ["group-one"], userIds: ["allowed-user"] },
      { handleMessage: vi.fn() } as unknown as ConversationService,
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
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "pong", flags: MessageFlags.SuppressEmbeds })
    );
  });

  it("omits the suppress flag when suppression is globally disabled", async () => {
    const conversations = {
      handleMessage: vi.fn().mockResolvedValue("response https://example.com"),
      logMessage: vi.fn()
    } as unknown as ConversationService;
    const gateway = new DiscordGateway(
      { token: "token", channelIds: ["channel"], userIds: ["user"], suppressEmbeds: false },
      conversations,
      createLoggerMock(),
      new FakeClient() as unknown as Client
    );
    const dmSend = vi.fn().mockResolvedValue(undefined);
    await gateway.handleMessage(
      fakeMessage({
        reply: vi.fn(),
        channel: {
          isThread: () => false,
          isSendable: () => true,
          sendTyping: vi.fn().mockResolvedValue(undefined),
          send: dmSend
        }
      })
    );
    expect(dmSend).toHaveBeenCalledWith(expect.objectContaining({ content: "response https://example.com" }));
    expect(dmSend).not.toHaveBeenCalledWith(expect.objectContaining({ flags: expect.anything() }));
  });

  it("omits the suppress flag for channels in the embed allowlist override", async () => {
    const conversations = {
      handleMessage: vi.fn().mockResolvedValue("response https://example.com"),
      logMessage: vi.fn()
    } as unknown as ConversationService;
    const gateway = new DiscordGateway(
      {
        token: "token",
        channelIds: ["channel", "parent"],
        userIds: ["user"],
        embedsAllowedChannelIds: ["channel"]
      },
      conversations,
      createLoggerMock(),
      new FakeClient() as unknown as Client
    );
    const allowedSend = vi.fn().mockResolvedValue(undefined);
    await gateway.handleMessage(
      fakeMessage({
        reply: vi.fn(),
        channel: {
          isThread: () => false,
          isSendable: () => true,
          sendTyping: vi.fn().mockResolvedValue(undefined),
          send: allowedSend
        }
      })
    );
    expect(allowedSend).toHaveBeenCalledWith(expect.objectContaining({ content: "response https://example.com" }));
    expect(allowedSend).not.toHaveBeenCalledWith(expect.objectContaining({ flags: expect.anything() }));

    const suppressedReply = vi.fn().mockResolvedValue(undefined);
    await gateway.handleMessage(
      fakeMessage({
        guildId: "guild",
        channelId: "other",
        reply: suppressedReply,
        channel: {
          isThread: () => false,
          isSendable: () => true,
          sendTyping: vi.fn().mockResolvedValue(undefined),
          send: vi.fn()
        }
      })
    );
    expect(suppressedReply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.SuppressEmbeds })
    );
  });

  it("resolves the embed override through a thread's parent channel", async () => {
    const conversations = {
      handleMessage: vi.fn().mockResolvedValue("response https://example.com"),
      logMessage: vi.fn()
    } as unknown as ConversationService;
    const gateway = new DiscordGateway(
      {
        token: "token",
        channelIds: ["parent"],
        userIds: ["user"],
        embedsAllowedChannelIds: ["parent"]
      },
      conversations,
      createLoggerMock(),
      new FakeClient() as unknown as Client
    );
    const threadReply = vi.fn().mockResolvedValue(undefined);
    await gateway.handleMessage(
      fakeMessage({
        guildId: "guild",
        channelId: "thread",
        reply: threadReply,
        channel: {
          id: "thread",
          isThread: () => true,
          parentId: "parent",
          isSendable: () => true,
          sendTyping: vi.fn().mockResolvedValue(undefined),
          send: vi.fn()
        }
      })
    );
    expect(threadReply).toHaveBeenCalledWith(expect.objectContaining({ content: "response https://example.com" }));
    expect(threadReply).not.toHaveBeenCalledWith(expect.objectContaining({ flags: expect.anything() }));
  });
});

describe("DiscordGateway.sendToConversation", () => {
  const guildIdentity = {
    key: "guild:g1:channel:channel",
    kind: "guild" as const,
    guildId: "g1",
    channelId: "channel"
  };
  const dmIdentity = { key: "dm:dm-channel", kind: "dm" as const, channelId: "dm-channel" };

  interface SendableClient {
    client: Client;
    send: ReturnType<typeof vi.fn>;
  }

  function createSendableClient(sendImplementation?: () => Promise<void>): SendableClient {
    const send = vi.fn(sendImplementation ?? (async () => undefined));
    const channel = { id: "channel", isSendable: () => true, send };
    const client = new FakeClient();
    Object.assign(client, { channels: { fetch: vi.fn().mockResolvedValue(channel) } });
    return { client: client as unknown as Client, send };
  }

  function createGateway(
    client: Client,
    logger = createLoggerMock(),
    options: { suppressEmbeds?: boolean; embedsAllowedChannelIds?: string[] } = {}
  ): DiscordGateway {
    return new DiscordGateway(
      {
        token: "token",
        channelIds: [],
        userIds: [],
        suppressEmbeds: options.suppressEmbeds ?? true,
        embedsAllowedChannelIds: options.embedsAllowedChannelIds ?? []
      },
      { handleMessage: vi.fn() } as unknown as ConversationService,
      logger,
      client
    );
  }

  it("posts scheduler output to the resolved channel with suppressed embeds", async () => {
    const { client, send } = createSendableClient();
    const gateway = createGateway(client);

    await expect(gateway.sendToConversation(guildIdentity, "Standing reminder")).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith({
      content: "Standing reminder",
      flags: MessageFlags.SuppressEmbeds
    });
  });

  it("omits the suppression flag for per-channel embed allowlists and disabled suppression", async () => {
    const allowed = createSendableClient();
    await createGateway(allowed.client, createLoggerMock(), {
      embedsAllowedChannelIds: ["channel"]
    }).sendToConversation(guildIdentity, "plain");
    expect(allowed.send).toHaveBeenCalledWith({ content: "plain" });

    const disabled = createSendableClient();
    await createGateway(disabled.client, createLoggerMock(), { suppressEmbeds: false }).sendToConversation(
      dmIdentity,
      "plain"
    );
    expect(disabled.send).toHaveBeenCalledWith({ content: "plain" });
  });

  it("splits long scheduler output at Discord-safe boundaries", async () => {
    const { client, send } = createSendableClient();
    const gateway = createGateway(client);
    const content = "word ".repeat(600); // 3000 characters

    await gateway.sendToConversation(guildIdentity, content);
    expect(send.mock.calls.length).toBeGreaterThan(1);
    for (const call of send.mock.calls) {
      expect(((call[0] as { content: string }).content as string).length).toBeLessThanOrEqual(2000);
    }
  });

  it("warns and reports failure when the resolved channel is not sendable", async () => {
    const send = vi.fn();
    const raw = new FakeClient();
    Object.assign(raw, { channels: { fetch: vi.fn().mockResolvedValue({ id: "channel", isSendable: () => false }) } });
    const logger = createLoggerMock();
    const gateway = createGateway(raw as unknown as Client, logger);

    await expect(gateway.sendToConversation(dmIdentity, "hello")).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "discord_channel_not_sendable",
      expect.objectContaining({ conversationKey: "dm:dm-channel", channelId: "dm-channel" })
    );
  });

  it("logs an error and reports failure when the channel cannot be fetched", async () => {
    const raw = new FakeClient();
    Object.assign(raw, { channels: { fetch: vi.fn().mockRejectedValue(new Error("unknown channel")) } });
    const logger = createLoggerMock();
    const gateway = createGateway(raw as unknown as Client, logger);

    await expect(gateway.sendToConversation(dmIdentity, "hello")).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      "scheduler_channel_unavailable",
      expect.objectContaining({ conversationKey: "dm:dm-channel", errorMessage: "unknown channel" })
    );
  });

  it("logs scheduler_channel_unresolved and reports failure when the channel fetch resolves null", async () => {
    // discord.js resolves a channel fetch to null (instead of rejecting) when
    // the channel cannot be built because its guild is not in the client's
    // cache — e.g. delivery attempted before the ready handshake.
    const raw = new FakeClient();
    Object.assign(raw, { channels: { fetch: vi.fn().mockResolvedValue(null) } });
    const logger = createLoggerMock();
    const gateway = createGateway(raw as unknown as Client, logger);

    await expect(gateway.sendToConversation(guildIdentity, "hello")).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      "scheduler_channel_unresolved",
      expect.objectContaining({
        conversationKey: "guild:g1:channel:channel",
        channelId: "channel"
      })
    );
    // Null resolution is not a "not sendable" channel; it must not be
    // mislabeled as one.
    expect(logger.warn).not.toHaveBeenCalledWith(
      "discord_channel_not_sendable",
      expect.anything()
    );
  });

  it("reports readiness only after the client completes its ready handshake", async () => {
    const raw = new FakeClient();
    const gateway = createGateway(raw as unknown as Client);

    expect(gateway.isDiscordReady()).toBe(false);
    await gateway.start();
    expect(gateway.isDiscordReady()).toBe(false);
    raw.emit(Events.ClientReady, raw);
    expect(gateway.isDiscordReady()).toBe(true);
  });
});
