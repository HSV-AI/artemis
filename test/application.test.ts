import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Collection, Events, type Client } from "discord.js";
import { ArtemisApplication } from "../src/application.js";
import type { ArtemisConfig } from "../src/config.js";
import type { DiscordGateway } from "../src/discord-gateway.js";
import { SCHEDULER_POLL_INTERVAL_MS } from "../src/scheduler-runner.js";
import type { ArtemisRepository } from "../src/repository.js";
import { ARTEMIS_PROFILE } from "../src/personas/artemis.js";
import { createLoggerMock, createPiMock, modelConfig } from "./helpers.js";

const config: ArtemisConfig = {
  discordToken: "token",
  discordAllowedChannelIds: ["channel-one", "channel-two"],
  discordUserIds: ["user-one", "user-two"],
  discordSuppressEmbeds: true,
  discordEmbedsAllowedChannelIds: [],
  model: modelConfig({ modelId: "model" }),
  persona: ARTEMIS_PROFILE,
  githubToken: "",
  githubAllowedRepositories: ["mbrooks/artemis", "HSV-AI/artemis"],
  dgraphUrl: "http://dgraph:8080",
  dgraphAuth: { username: "memory", password: "memory-password", namespace: 0 },
  hsvaiDgraphSyncAuth: { username: "hsvai-sync", password: "sync-password", namespace: 1 },
  hsvaiDgraphQueryAuth: { username: "hsvai-query", password: "query-password", namespace: 1 },
  sqlitePath: ":memory:",
  logLevel: "info"
};

describe("ArtemisApplication", () => {
  afterEach(() => vi.restoreAllMocks());

  it("checks the model provider, then starts Discord and the scheduler, and closes everything on stop", async () => {
    const order: string[] = [];
    const pi = createPiMock();
    vi.mocked(pi.checkHealth).mockImplementation(async () => {
      order.push("pi");
    });
    const discord = {
      start: vi.fn().mockImplementation(async () => {
        order.push("discord");
      }),
      stop: vi.fn().mockImplementation(() => {
        order.push("discord-stop");
      })
    } as unknown as DiscordGateway;
    const scheduler = {
      start: vi.fn(() => {
        order.push("scheduler");
      }),
      stop: vi.fn(() => {
        order.push("scheduler-stop");
      })
    };
    const repository = { close: vi.fn() } as unknown as ArtemisRepository;
    const logger = createLoggerMock();
    const application = new ArtemisApplication(config, { pi, discord, repository, logger, scheduler });

    await application.start();
    expect(order).toEqual(["pi", "discord", "scheduler"]);
    expect(logger.info).toHaveBeenCalledWith("artemis_starting", {
      channelIds: ["channel-one", "channel-two"],
      model: "model",
      provider: "test-provider",
      personaProfile: "artemis"
    });

    application.stop();
    expect(order).toEqual([
      "pi",
      "discord",
      "scheduler",
      "scheduler-stop",
      "discord-stop"
    ]);
    expect(repository.close).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith("artemis_stopped");
  });

  it("does not start Discord when model-provider health validation fails", async () => {
    const pi = createPiMock();
    vi.mocked(pi.checkHealth).mockRejectedValue(new Error("offline"));
    const discord = { start: vi.fn(), stop: vi.fn() } as unknown as DiscordGateway;
    const scheduler = { start: vi.fn(), stop: vi.fn() };
    const repository = { close: vi.fn() } as unknown as ArtemisRepository;
    const logger = createLoggerMock();
    const application = new ArtemisApplication(config, {
      pi,
      discord,
      repository,
      logger,
      scheduler
    });
    await expect(application.start()).rejects.toThrow("offline");
    expect(discord.start).not.toHaveBeenCalled();
    expect(scheduler.start).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith("artemis_start_failed", {
      errorName: "Error",
      errorMessage: "offline"
    });
  });

  it("wires the default logger to both the console and repository", async () => {
    const consoleWrite = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const pi = createPiMock();
    const discord = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn()
    } as unknown as DiscordGateway;
    const scheduler = { start: vi.fn(), stop: vi.fn() };
    const repository = {
      recordLog: vi.fn(),
      close: vi.fn()
    } as unknown as ArtemisRepository;
    const application = new ArtemisApplication(config, { pi, discord, repository, scheduler });

    await application.start();
    application.stop();

    expect(consoleWrite).toHaveBeenCalledTimes(2);
    expect(repository.recordLog).toHaveBeenCalledTimes(2);
    expect(repository.recordLog).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ level: "info", event: "artemis_starting" })
    );
    expect(repository.recordLog).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ level: "info", event: "artemis_stopped" })
    );
  });

  it("holds the default scheduler until the Discord gateway reports ready", async () => {
    vi.useFakeTimers();
    try {
      const pi = createPiMock();
      const discord = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
        isDiscordReady: vi.fn().mockReturnValue(false)
      } as unknown as DiscordGateway;
      const repository = {
        close: vi.fn(),
        listActiveScheduledPrompts: vi.fn().mockReturnValue([]),
        recordEvent: vi.fn()
      } as unknown as ArtemisRepository;
      const logger = createLoggerMock();
      // No scheduler injected: the composition default-wires the runner with
      // its Discord readiness gate.
      const application = new ArtemisApplication(config, { pi, discord, repository, logger });

      await application.start();
      // The immediate catch-up poll defers while Discord is not ready: jobs
      // are neither listed nor consumed, so nothing can fire pre-ready.
      expect(discord.isDiscordReady).toHaveBeenCalled();
      expect(repository.listActiveScheduledPrompts).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        "scheduler_deferred_not_ready",
        expect.anything()
      );

      vi.mocked(discord.isDiscordReady).mockReturnValue(true);
      await vi.advanceTimersByTimeAsync(SCHEDULER_POLL_INTERVAL_MS);
      expect(repository.listActiveScheduledPrompts).toHaveBeenCalledOnce();

      application.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("wires the Discord bot display name into the PI gateway on ready", async () => {
    const client = new EventEmitter();
    Object.assign(client, {
      login: vi.fn().mockResolvedValue("token"),
      destroy: vi.fn(),
      user: { id: "kipp-user", username: "kipp_bot", globalName: "KIPP" },
      application: { commands: { set: vi.fn().mockResolvedValue(new Collection()) } }
    });
    const pi = createPiMock();
    const repository = { close: vi.fn() } as unknown as ArtemisRepository;
    const scheduler = { start: vi.fn(), stop: vi.fn() };
    const application = new ArtemisApplication(config, {
      pi,
      repository,
      logger: createLoggerMock(),
      discordClient: client as unknown as Client,
      scheduler
    });

    await application.start();
    client.emit(Events.ClientReady, client);
    await Promise.resolve();

    expect(pi.setBotDisplayName).toHaveBeenCalledWith("KIPP");

    application.stop();
  });
});
