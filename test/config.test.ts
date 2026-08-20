import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTHORIZED_USER_ID,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_SQLITE_PATH,
  parseConfig
} from "../src/config.js";

describe("parseConfig", () => {
  it("loads required values and safe defaults", () => {
    expect(parseConfig({ DISCORD_TOKEN: "token", DISCORD_GUILD_ID: "guild" })).toEqual({
      discordToken: "token",
      discordGuildId: "guild",
      authorizedUserId: DEFAULT_AUTHORIZED_USER_ID,
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
      DISCORD_GUILD_ID: "guild",
      AUTHORIZED_USER_ID: "user",
      OLLAMA_BASE_URL: "https://ollama.example/v1/",
      OLLAMA_MODEL: "custom",
      OLLAMA_API_KEY: "secret",
      SQLITE_PATH: ":memory:",
      LOG_LEVEL: "debug"
    });
    expect(result).toMatchObject({
      discordToken: "token",
      authorizedUserId: "user",
      ollamaBaseUrl: "https://ollama.example/v1",
      ollamaModel: "custom",
      ollamaApiKey: "secret",
      sqlitePath: ":memory:",
      logLevel: "debug"
    });
  });

  it.each(["DISCORD_TOKEN", "DISCORD_GUILD_ID"])("rejects missing %s", (name) => {
    const env = { DISCORD_TOKEN: "token", DISCORD_GUILD_ID: "guild", [name]: "" };
    expect(() => parseConfig(env)).toThrow(`Missing required configuration: ${name}`);
  });

  it("rejects invalid URLs and log levels", () => {
    expect(() =>
      parseConfig({
        DISCORD_TOKEN: "token",
        DISCORD_GUILD_ID: "guild",
        OLLAMA_BASE_URL: "file:///tmp/ollama"
      })
    ).toThrow("Invalid URL configuration: OLLAMA_BASE_URL");
    expect(() =>
      parseConfig({ DISCORD_TOKEN: "token", DISCORD_GUILD_ID: "guild", LOG_LEVEL: "verbose" })
    ).toThrow("Invalid configuration: LOG_LEVEL");
  });
});
