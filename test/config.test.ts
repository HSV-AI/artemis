import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GITHUB_ALLOWED_REPOSITORIES,
  DEFAULT_DGRAPH_URL,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_SQLITE_PATH,
  loadConfig,
  parseConfig
} from "../src/config.js";
import { ARTEMIS_PROFILE } from "../src/personas/artemis.js";

const providerDefinition = {
  providerId: "configured-provider",
  providerName: "Configured Provider",
  baseUrl: "https://inference.example/v1",
  modelId: "configured-model",
  reasoning: true,
  reasoningEffort: "medium",
  contextWindow: 64_000,
  maxTokens: 8_192,
  supportsDeveloperRole: false
};

describe("parseConfig", () => {
  it("loads required values, empty Discord allowlists, and safe defaults", () => {
    expect(
      parseConfig({
        DISCORD_TOKEN: "token"
      })
    ).toEqual({
      discordToken: "token",
      discordAllowedChannelIds: [],
      discordUserIds: [],
      discordSuppressEmbeds: true,
      discordEmbedsAllowedChannelIds: [],
      model: {
        providerId: "ollama",
        providerName: "Ollama",
        baseUrl: DEFAULT_OLLAMA_BASE_URL,
        modelId: DEFAULT_OLLAMA_MODEL,
        apiKey: "ollama",
        reasoning: true,
        reasoningEffort: "medium",
        contextWindow: 1_048_576,
        maxTokens: 65_536,
        supportsDeveloperRole: false
      },
      persona: ARTEMIS_PROFILE,
      githubToken: "",
      githubAllowedRepositories: DEFAULT_GITHUB_ALLOWED_REPOSITORIES,
      dgraphUrl: DEFAULT_DGRAPH_URL,
      sqlitePath: DEFAULT_SQLITE_PATH,
      logLevel: "info"
    });
  });

  it("retains the existing Ollama environment workflow without a model file", () => {
    const result = parseConfig({
      DISCORD_TOKEN: "token",
      OLLAMA_BASE_URL: "https://ollama.example/v1/",
      OLLAMA_MODEL: "custom-ollama-model",
      OLLAMA_API_KEY: "ollama-secret"
    });
    expect(result.model).toMatchObject({
      providerId: "ollama",
      providerName: "Ollama",
      baseUrl: "https://ollama.example/v1",
      modelId: "custom-ollama-model",
      apiKey: "ollama-secret"
    });
  });

  it("accepts overrides and removes a trailing URL slash", () => {
    const result = parseConfig({
      DISCORD_TOKEN: " token ",
      DISCORD_ALLOWED_CHANNEL_ID: " channel-one, channel-two, channel-one ",
      DISCORD_ALLOWED_USER_ID: " user-one, user-two, user-one ",
      MODEL_API_KEY: "secret",
      GITHUB_TOKEN: " github-secret ",
      GITHUB_ALLOWED_REPOSITORY: " mbrooks/artemis, HSV-AI/artemis, MBROOKS/ARTEMIS ",
      DGRAPH_URL: "http://memory.example:8080/",
      SQLITE_PATH: ":memory:",
      LOG_LEVEL: "debug"
    }, { ...providerDefinition, baseUrl: "https://model.example/v1/" });
    expect(result).toMatchObject({
      discordToken: "token",
      discordAllowedChannelIds: ["channel-one", "channel-two"],
      discordUserIds: ["user-one", "user-two"],
      model: expect.objectContaining({
        providerId: "configured-provider",
        providerName: "Configured Provider",
        baseUrl: "https://model.example/v1",
        modelId: "configured-model",
        apiKey: "secret"
      }),
      githubToken: "github-secret",
      githubAllowedRepositories: ["mbrooks/artemis", "HSV-AI/artemis"],
      dgraphUrl: "http://memory.example:8080",
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
    expect(() => parseConfig({
      DISCORD_TOKEN: "token",
      OLLAMA_BASE_URL: "file:///tmp/ollama"
    })).toThrow("Invalid URL configuration: model.baseUrl");
    expect(() =>
      parseConfig(
        { DISCORD_TOKEN: "token" },
        { ...providerDefinition, baseUrl: "file:///tmp/model" }
      )
    ).toThrow("Invalid URL configuration: model.baseUrl");
    expect(() =>
      parseConfig({
        DISCORD_TOKEN: "token",
        LOG_LEVEL: "verbose"
      })
    ).toThrow("Invalid configuration: LOG_LEVEL");
    expect(() => parseConfig({
      DISCORD_TOKEN: "token",
      DGRAPH_URL: "file:///data/dgraph"
    })).toThrow("Invalid URL configuration: DGRAPH_URL");
  });

  it("loads model settings from MODEL_CONFIG_PATH", () => {
    const readFile = vi.fn().mockReturnValue(JSON.stringify(providerDefinition));
    const result = loadConfig(
      { DISCORD_TOKEN: "token", MODEL_CONFIG_PATH: "model.config.json" },
      readFile
    );
    expect(readFile).toHaveBeenCalledWith("model.config.json", "utf8");
    expect(result.model).toMatchObject({
      providerId: "configured-provider",
      providerName: "Configured Provider",
      baseUrl: "https://inference.example/v1",
      modelId: "configured-model",
      contextWindow: 64_000
    });
  });

  it("reports unreadable and invalid model config files", () => {
    expect(() => loadConfig(
      { DISCORD_TOKEN: "token", MODEL_CONFIG_PATH: "missing.json" },
      () => { throw new Error("not found"); }
    )).toThrow("Unable to load MODEL_CONFIG_PATH missing.json: not found");
    expect(() => loadConfig(
      { DISCORD_TOKEN: "token", MODEL_CONFIG_PATH: "invalid.json" },
      () => "not json"
    )).toThrow("Unable to load MODEL_CONFIG_PATH invalid.json");
  });

  it("selects a named persona profile", () => {
    const result = parseConfig({ DISCORD_TOKEN: "token", PERSONA_PROFILE: " WARTERMIS " });
    expect(result.persona.id).toBe("wartermis");
  });

  it("rejects an unknown persona profile", () => {
    expect(() => parseConfig({ DISCORD_TOKEN: "token", PERSONA_PROFILE: "unknown" })).toThrow(
      "PERSONA_PROFILE must be one of artemis, wartermis"
    );
  });

  it.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)(
    "accepts reasoning effort %s",
    (reasoningEffort) => {
      const result = parseConfig(
        { DISCORD_TOKEN: "token" },
        { ...providerDefinition, reasoningEffort }
      );
      expect(result.model.reasoningEffort).toBe(reasoningEffort);
    }
  );

  it("allows providers without reasoning-effort support to omit it", () => {
    const result = parseConfig(
      { DISCORD_TOKEN: "token" },
      { ...providerDefinition, reasoningEffort: undefined }
    );
    expect(result.model.reasoningEffort).toBeUndefined();
  });

  it("rejects invalid model field types", () => {
    expect(() => parseConfig(
      { DISCORD_TOKEN: "token" },
      { ...providerDefinition, providerId: "" }
    )).toThrow("providerId must be a nonblank string");
    expect(() => parseConfig(
      { DISCORD_TOKEN: "token" },
      { ...providerDefinition, contextWindow: 0 }
    )).toThrow("contextWindow must be a positive integer");
    expect(() => parseConfig(
      { DISCORD_TOKEN: "token" },
      { ...providerDefinition, reasoning: "yes" }
    )).toThrow("reasoning must be a boolean");
    expect(() => parseConfig(
      { DISCORD_TOKEN: "token" },
      { ...providerDefinition, reasoningEffort: "extreme" }
    )).toThrow("reasoningEffort must be one of");
    expect(() => parseConfig(
      { DISCORD_TOKEN: "token" },
      { ...providerDefinition, modelId: undefined }
    )).toThrow("modelId must be a nonblank string");
    expect(() => parseConfig({ DISCORD_TOKEN: "token" }, [])).toThrow(
      "expected a JSON object"
    );
  });

  it("allows a blank GitHub repository allowlist and rejects malformed entries", () => {
    expect(parseConfig({
      DISCORD_TOKEN: "token",
      GITHUB_ALLOWED_REPOSITORY: ""
    }).githubAllowedRepositories).toEqual([]);
    expect(() => parseConfig({
      DISCORD_TOKEN: "token",
      GITHUB_ALLOWED_REPOSITORY: "artemis"
    })).toThrow("GITHUB_ALLOWED_REPOSITORY");
    expect(() => parseConfig({
      DISCORD_TOKEN: "token",
      GITHUB_ALLOWED_REPOSITORY: "owner/repo?ref=main"
    })).toThrow("GITHUB_ALLOWED_REPOSITORY");
  });

  it("suppresses Discord link embeds by default and accepts an explicit disable", () => {
    expect(parseConfig({ DISCORD_TOKEN: "token" }).discordSuppressEmbeds).toBe(true);
    expect(
      parseConfig({ DISCORD_TOKEN: "token", DISCORD_SUPPRESS_EMBEDS: "false" }).discordSuppressEmbeds
    ).toBe(false);
    expect(
      parseConfig({ DISCORD_TOKEN: "token", DISCORD_SUPPRESS_EMBEDS: "true" }).discordSuppressEmbeds
    ).toBe(true);
  });

  it("rejects an invalid DISCORD_SUPPRESS_EMBEDS value", () => {
    expect(() => parseConfig({ DISCORD_TOKEN: "token", DISCORD_SUPPRESS_EMBEDS: "yes" })).toThrow(
      "Invalid configuration: DISCORD_SUPPRESS_EMBEDS must be true or false"
    );
  });

  it("parses DISCORD_EMBEDS_ALLOWED_CHANNEL_ID as a trimmed, deduplicated allowlist", () => {
    expect(
      parseConfig({
        DISCORD_TOKEN: "token",
        DISCORD_EMBEDS_ALLOWED_CHANNEL_ID: " channel-one, channel-two, channel-one "
      }).discordEmbedsAllowedChannelIds
    ).toEqual(["channel-one", "channel-two"]);
    expect(parseConfig({ DISCORD_TOKEN: "token" }).discordEmbedsAllowedChannelIds).toEqual([]);
    expect(
      parseConfig({ DISCORD_TOKEN: "token", DISCORD_EMBEDS_ALLOWED_CHANNEL_ID: ", ," })
        .discordEmbedsAllowedChannelIds
    ).toEqual([]);
  });
});
