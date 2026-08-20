import { describe, expect, it } from "vitest";
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_SQLITE_PATH,
  parseConfig
} from "../src/config.js";

describe("parseConfig", () => {
  it("loads required values and empty allowlists by default", () => {
    expect(
      parseConfig({
        DISCORD_TOKEN: "token"
      })
    ).toEqual({
      discordToken: "token",
      discordAllowedChannelIds: [],
      discordUserIds: [],
      ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL,
      ollamaModel: DEFAULT_OLLAMA_MODEL,
      ollamaApiKey: "ollama",
      sqlitePath: DEFAULT_SQLITE_PATH,
      logLevel: "info"
    });
  });

  it("accepts overrides and removes a trailing URL slash", () => {
    const result = parseConfig({
      DISCORD_TOKEN: " token ",
      DISCORD_ALLOWED_CHANNEL_ID: " channel-one, channel-two, channel-one ",
      DISCORD_ALLOWED_USER_ID: " user-one, user-two, user-one ",
      OLLAMA_BASE_URL: "https://ollama.example/v1/",
      OLLAMA_MODEL: "custom",
      OLLAMA_API_KEY: "secret",
      SQLITE_PATH: ":memory:",
      LOG_LEVEL: "debug"
    });
    expect(result).toMatchObject({
      discordToken: "token",
      discordAllowedChannelIds: ["channel-one", "channel-two"],
      discordUserIds: ["user-one", "user-two"],
      ollamaBaseUrl: "https://ollama.example/v1",
      ollamaModel: "custom",
      ollamaApiKey: "secret",
      sqlitePath: ":memory:",
      logLevel: "debug"
    });
  });

  it("rejects a missing Discord token", () => {
    expect(() => parseConfig({ DISCORD_TOKEN: "" })).toThrow(
      "Missing required configuration: DISCORD_TOKEN"
    );
  });

  it.each(["DISCORD_ALLOWED_CHANNEL_ID", "DISCORD_ALLOWED_USER_ID"])(
    "accepts a blank %s allowlist",
    (name) => {
      expect(
        parseConfig({
          DISCORD_TOKEN: "token",
          DISCORD_ALLOWED_CHANNEL_ID: "channel",
          DISCORD_ALLOWED_USER_ID: "user",
          [name]: ", ,"
        })
      ).toMatchObject({
        [name === "DISCORD_ALLOWED_CHANNEL_ID" ? "discordAllowedChannelIds" : "discordUserIds"]:
          []
      });
    }
  );

  it("rejects invalid URLs and log levels", () => {
    expect(() =>
      parseConfig({
        DISCORD_TOKEN: "token",
        OLLAMA_BASE_URL: "file:///tmp/ollama"
      })
    ).toThrow("Invalid URL configuration: OLLAMA_BASE_URL");
    expect(() =>
      parseConfig({
        DISCORD_TOKEN: "token",
        LOG_LEVEL: "verbose"
      })
    ).toThrow("Invalid configuration: LOG_LEVEL");
  });
});
