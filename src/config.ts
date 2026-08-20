export const DEFAULT_DISCORD_ALLOWED_USER_ID = "603384387685449728";
export const DEFAULT_OLLAMA_MODEL = "deepseek-v4-flash:0731-cloud";
export const DEFAULT_OLLAMA_BASE_URL = "http://ollama:11434/v1";
export const DEFAULT_SQLITE_PATH = "/data/artemis.sqlite";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ArtemisConfig {
  discordToken: string;
  discordAllowedChannelIds: readonly string[];
  discordUserIds: readonly string[];
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaApiKey: string;
  sqlitePath: string;
  logLevel: LogLevel;
}

type Environment = Record<string, string | undefined>;

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required configuration: ${name}`);
  }
  return value;
}

function valueOrDefault(env: Environment, name: string, defaultValue: string): string {
  return env[name]?.trim() || defaultValue;
}

function parseCommaSeparatedIds(value: string, name: string): string[] {
  const ids = [...new Set(value.split(",").map((id) => id.trim()))].filter(Boolean);
  if (ids.length === 0) {
    throw new Error(`Invalid configuration: ${name} must contain at least one ID`);
  }
  return ids;
}

function parseUrl(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid URL configuration: ${name}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid URL configuration: ${name}`);
  }
  return value.replace(/\/$/, "");
}

function parseLogLevel(value: string): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  throw new Error("Invalid configuration: LOG_LEVEL must be debug, info, warn, or error");
}

export function parseConfig(env: Environment = process.env): ArtemisConfig {
  return {
    discordToken: required(env, "DISCORD_TOKEN"),
    discordAllowedChannelIds: parseCommaSeparatedIds(
      required(env, "DISCORD_ALLOWED_CHANNEL_ID"),
      "DISCORD_ALLOWED_CHANNEL_ID"
    ),
    discordUserIds: parseCommaSeparatedIds(
      valueOrDefault(env, "DISCORD_ALLOWED_USER_ID", DEFAULT_DISCORD_ALLOWED_USER_ID),
      "DISCORD_ALLOWED_USER_ID"
    ),
    ollamaBaseUrl: parseUrl(
      valueOrDefault(env, "OLLAMA_BASE_URL", DEFAULT_OLLAMA_BASE_URL),
      "OLLAMA_BASE_URL"
    ),
    ollamaModel: valueOrDefault(env, "OLLAMA_MODEL", DEFAULT_OLLAMA_MODEL),
    ollamaApiKey: valueOrDefault(env, "OLLAMA_API_KEY", "ollama"),
    sqlitePath: valueOrDefault(env, "SQLITE_PATH", DEFAULT_SQLITE_PATH),
    logLevel: parseLogLevel(valueOrDefault(env, "LOG_LEVEL", "info"))
  };
}
