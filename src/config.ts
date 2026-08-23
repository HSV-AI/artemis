import { readFileSync } from "node:fs";
import { resolvePersonaProfile, type PersonaProfile } from "./persona-profiles.js";

export const DEFAULT_OLLAMA_MODEL = "deepseek-v4-flash:0731-cloud";
export const DEFAULT_OLLAMA_BASE_URL = "http://ollama:11434/v1";
export const DEFAULT_SQLITE_PATH = "/data/artemis.sqlite";
export const DEFAULT_DGRAPH_URL = "http://dgraph:8080";
export const DEFAULT_GITHUB_ALLOWED_REPOSITORIES = ["mbrooks/artemis", "HSV-AI/artemis"] as const;

export type LogLevel = "debug" | "info" | "warn" | "error";
export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];

export interface ModelProviderConfig {
  providerId: string;
  providerName: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  reasoning: boolean;
  reasoningEffort?: ReasoningEffort;
  contextWindow: number;
  maxTokens: number;
  supportsDeveloperRole: boolean;
}

type ModelProviderDefinition = Omit<ModelProviderConfig, "apiKey">;

export interface ArtemisConfig {
  discordToken: string;
  discordAllowedChannelIds: readonly string[];
  discordUserIds: readonly string[];
  discordSuppressEmbeds: boolean;
  discordEmbedsAllowedChannelIds: readonly string[];
  model: ModelProviderConfig;
  persona: PersonaProfile;
  githubToken: string;
  githubAllowedRepositories: readonly string[];
  dgraphUrl: string;
  memoryEmbedUrl: string;
  memoryInject: boolean;
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

function parseCommaSeparatedIds(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((id) => id.trim()))].filter(Boolean);
}

function parseAllowedRepositories(value: string | undefined): string[] {
  const source = value === undefined ? DEFAULT_GITHUB_ALLOWED_REPOSITORIES.join(",") : value;
  const repositories = source.split(",").map((repository) => repository.trim()).filter(Boolean);
  const seen = new Set<string>();
  return repositories.filter((repository) => {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
      throw new Error(
        "Invalid configuration: GITHUB_ALLOWED_REPOSITORY must contain comma-separated owner/repository values"
      );
    }
    const normalized = repository.toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
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

function parseOptionalUrl(value: string | undefined, name: string): string {
  const normalized = value?.trim() ?? "";
  return normalized ? parseUrl(normalized, name) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configuredString(
  config: Record<string, unknown>,
  name: keyof ModelProviderDefinition
): string {
  const value = config[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid model configuration: ${name} must be a nonblank string`);
  }
  return value.trim();
}

function configuredBoolean(
  config: Record<string, unknown>,
  name: keyof ModelProviderDefinition
): boolean {
  const value = config[name];
  if (typeof value !== "boolean") {
    throw new Error(`Invalid model configuration: ${name} must be a boolean`);
  }
  return value;
}

function configuredPositiveInteger(
  config: Record<string, unknown>,
  name: keyof ModelProviderDefinition
): number {
  const value = config[name];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Invalid model configuration: ${name} must be a positive integer`);
  }
  return value as number;
}

function configuredReasoningEffort(config: Record<string, unknown>): ReasoningEffort | undefined {
  const value = config.reasoningEffort;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !REASONING_EFFORTS.includes(value as ReasoningEffort)) {
    throw new Error(
      `Invalid model configuration: reasoningEffort must be one of ${REASONING_EFFORTS.join(", ")}`
    );
  }
  return value as ReasoningEffort;
}

export function parseModelConfig(
  input: unknown,
  apiKey = "local"
): ModelProviderConfig {
  if (!isRecord(input)) {
    throw new Error("Invalid model configuration: expected a JSON object");
  }
  const config = input;
  const reasoningEffort = configuredReasoningEffort(config);
  return {
    providerId: configuredString(config, "providerId"),
    providerName: configuredString(config, "providerName"),
    baseUrl: parseUrl(configuredString(config, "baseUrl"), "model.baseUrl"),
    modelId: configuredString(config, "modelId"),
    apiKey: apiKey.trim(),
    reasoning: configuredBoolean(config, "reasoning"),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    contextWindow: configuredPositiveInteger(config, "contextWindow"),
    maxTokens: configuredPositiveInteger(config, "maxTokens"),
    supportsDeveloperRole: configuredBoolean(config, "supportsDeveloperRole")
  };
}

function parseLogLevel(value: string): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  throw new Error("Invalid configuration: LOG_LEVEL must be debug, info, warn, or error");
}

function parseBoolean(value: string, name: string, defaultValue: boolean): boolean {
  const raw = value.trim();
  if (!raw) {
    return defaultValue;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new Error(`Invalid configuration: ${name} must be true or false`);
}

export function parseConfig(
  env: Environment = process.env,
  modelConfig?: unknown
): ArtemisConfig {
  return {
    discordToken: required(env, "DISCORD_TOKEN"),
    discordAllowedChannelIds: parseCommaSeparatedIds(env.DISCORD_ALLOWED_CHANNEL_ID),
    discordUserIds: parseCommaSeparatedIds(env.DISCORD_ALLOWED_USER_ID),
    discordSuppressEmbeds: parseBoolean(
      valueOrDefault(env, "DISCORD_SUPPRESS_EMBEDS", "true"),
      "DISCORD_SUPPRESS_EMBEDS",
      true
    ),
    discordEmbedsAllowedChannelIds: parseCommaSeparatedIds(env.DISCORD_EMBEDS_ALLOWED_CHANNEL_ID),
    model: modelConfig === undefined
      ? parseModelConfig({
          providerId: "ollama",
          providerName: "Ollama",
          baseUrl: valueOrDefault(env, "OLLAMA_BASE_URL", DEFAULT_OLLAMA_BASE_URL),
          modelId: valueOrDefault(env, "OLLAMA_MODEL", DEFAULT_OLLAMA_MODEL),
          reasoning: true,
          reasoningEffort: "medium",
          contextWindow: 1_048_576,
          maxTokens: 65_536,
          supportsDeveloperRole: false
        }, valueOrDefault(env, "OLLAMA_API_KEY", "ollama"))
      : parseModelConfig(modelConfig, valueOrDefault(env, "MODEL_API_KEY", "local")),
    persona: resolvePersonaProfile(env.PERSONA_PROFILE),
    githubToken: env.GITHUB_TOKEN?.trim() ?? "",
    githubAllowedRepositories: parseAllowedRepositories(env.GITHUB_ALLOWED_REPOSITORY),
    dgraphUrl: parseUrl(valueOrDefault(env, "DGRAPH_URL", DEFAULT_DGRAPH_URL), "DGRAPH_URL"),
    memoryEmbedUrl: parseOptionalUrl(env.MEMORY_EMBED_URL, "MEMORY_EMBED_URL"),
    memoryInject: parseBoolean(
      valueOrDefault(env, "MEMORY_INJECT", "false"),
      "MEMORY_INJECT",
      false
    ),
    sqlitePath: valueOrDefault(env, "SQLITE_PATH", DEFAULT_SQLITE_PATH),
    logLevel: parseLogLevel(valueOrDefault(env, "LOG_LEVEL", "info"))
  };
}

export function loadConfig(
  env: Environment = process.env,
  readFile: (path: string, encoding: "utf8") => string = readFileSync
): ArtemisConfig {
  const configPath = env.MODEL_CONFIG_PATH?.trim();
  let modelConfig: unknown;
  if (configPath) {
    try {
      modelConfig = JSON.parse(readFile(configPath, "utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to load MODEL_CONFIG_PATH ${configPath}: ${message}`);
    }
  }

  return parseConfig(env, modelConfig);
}
