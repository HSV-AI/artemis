import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISCORD_ALLOWED_USER_ID,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_SQLITE_PATH,
  parseConfig
} from "../src/config.js";

describe("parseConfig", () => {
  it("loads required values and safe defaults", () => {
    expect(
      parseConfig({
        DISCORD_TOKEN: "token",
        DISCORD_ALLOWED_CHANNEL_ID: "channel"
      })
    ).toEqual({
      discordToken: "token",
      discordAllowedChannelIds: ["channel"],
      discordUserIds: [DEFAULT_DISCORD_ALLOWED_USER_ID],
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

  it.each(["DISCORD_TOKEN", "DISCORD_ALLOWED_CHANNEL_ID"])(
    "rejects missing %s",
    (name) => {
      const env = {
        DISCORD_TOKEN: "token",
        DISCORD_ALLOWED_CHANNEL_ID: "channel",
        [name]: ""
      };
      expect(() => parseConfig(env)).toThrow(`Missing required configuration: ${name}`);
    }
  );

  it.each(["DISCORD_ALLOWED_CHANNEL_ID", "DISCORD_ALLOWED_USER_ID"])(
    "rejects an empty %s allowlist",
    (name) => {
      expect(() =>
        parseConfig({
          DISCORD_TOKEN: "token",
          DISCORD_ALLOWED_CHANNEL_ID: "channel",
          [name]: ", ,"
        })
      ).toThrow(`${name} must contain at least one ID`);
    }
  );

  it("rejects invalid URLs and log levels", () => {
    expect(() =>
      parseConfig({
        DISCORD_TOKEN: "token",
        DISCORD_ALLOWED_CHANNEL_ID: "channel",
        OLLAMA_BASE_URL: "file:///tmp/ollama"
      })
    ).toThrow("Invalid URL configuration: OLLAMA_BASE_URL");
    expect(() =>
      parseConfig({
        DISCORD_TOKEN: "token",
        DISCORD_ALLOWED_CHANNEL_ID: "channel",
        LOG_LEVEL: "verbose"
      })
    ).toThrow("Invalid configuration: LOG_LEVEL");
  });
});
