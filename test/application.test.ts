import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtemisApplication } from "../src/application.js";
import type { ArtemisConfig } from "../src/config.js";
import type { DiscordGateway } from "../src/discord-gateway.js";
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
  memoryInject: false,
  sqlitePath: ":memory:",
  logLevel: "info"
};

describe("ArtemisApplication", () => {
  afterEach(() => vi.restoreAllMocks());

  it("checks the model provider before starting Discord and closes dependencies on stop", async () => {
    const order: string[] = [];
    const pi = createPiMock();
    vi.mocked(pi.checkHealth).mockImplementation(async () => {
      order.push("pi");
    });
    const discord = {
      start: vi.fn().mockImplementation(async () => {
        order.push("discord");
      }),
      stop: vi.fn()
    } as unknown as DiscordGateway;
    const repository = { close: vi.fn() } as unknown as ArtemisRepository;
    const logger = createLoggerMock();
    const application = new ArtemisApplication(config, { pi, discord, repository, logger });

    await application.start();
    expect(order).toEqual(["pi", "discord"]);
    expect(logger.info).toHaveBeenCalledWith("artemis_starting", {
      channelIds: ["channel-one", "channel-two"],
      model: "model",
      provider: "test-provider",
      personaProfile: "artemis"
    });

    application.stop();
    expect(discord.stop).toHaveBeenCalledOnce();
    expect(repository.close).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith("artemis_stopped");
  });

  it("does not start Discord when model-provider health validation fails", async () => {
    const pi = createPiMock();
    vi.mocked(pi.checkHealth).mockRejectedValue(new Error("offline"));
    const discord = { start: vi.fn(), stop: vi.fn() } as unknown as DiscordGateway;
    const repository = { close: vi.fn() } as unknown as ArtemisRepository;
    const logger = createLoggerMock();
    const application = new ArtemisApplication(config, {
      pi,
      discord,
      repository,
      logger
    });
    await expect(application.start()).rejects.toThrow("offline");
    expect(discord.start).not.toHaveBeenCalled();
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
    const repository = {
      recordLog: vi.fn(),
      close: vi.fn()
    } as unknown as ArtemisRepository;
    const application = new ArtemisApplication(config, { pi, discord, repository });

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
});
