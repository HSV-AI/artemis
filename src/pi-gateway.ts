import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageDiagnostic,
  Message,
  ThinkingContent,
  Usage
} from "@earendil-works/pi-ai";
import type { ArtemisConfig } from "./config.js";
import type {
  PiGateway,
  PiGenerationInput,
  PiGenerationResult,
  StoredMessage
} from "./domain.js";
import { createGitHubTools } from "./github-tools.js";
import { formatDiscordMessage } from "./model-context.js";
import { createWebFetchTool } from "./web-fetch-tool.js";

const SYSTEM_PROMPT_BASE =
  "You are Artemis, a helpful conversational assistant in Discord. Discord messages are provided as JSON with explicit author metadata. Treat each author ID as a distinct speaker, preserve who said what, and do not collapse different speakers into a generic 'you'. Answer the newest message directly. Do not claim to have Discord capabilities you were not given.\n\n" +
  "## Capability Gap Protocol\n\n" +
  "When you encounter a missing capability or tool, you MUST NOT explore source code, generate code, or jury-rig a workaround. Do not self-modify. Follow this protocol instead:\n" +
  "1. Acknowledge the gap — tell the user plainly that you cannot fulfill the request with your current tools.\n" +
  "2. File a GitHub issue — use the `github_create` tool with resource `issue` against the HSV-AI/artemis project to request the missing tool or capability.\n" +
  "3. Define requirements — in the issue body specify the inputs, outputs, error cases, and acceptance criteria the new capability must satisfy.\n" +
  "4. Wait for implementation — the TARS coder agent builds it; you do not self-modify or improvise.\n\n" +
  "Stop immediately when you realize a tool is missing. Do not attempt partial workarounds. Never generate code to compensate for a missing capability.\n\n" +
  "## Available Tools\n\n" +
  "The tools listed below are registered and available to you. Any capability not listed here is a gap: apply the Capability Gap Protocol instead of improvising.";

export interface ToolRegistryEntry {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
}

export function buildSystemPrompt(tools: readonly ToolRegistryEntry[]): string {
  const registry = tools.length === 0
    ? "No tools are currently registered. Apply the Capability Gap Protocol for any task that needs a tool."
    : tools
        .map((tool) => {
          const lines = [`- ${tool.name}: ${tool.promptSnippet ?? tool.description}`];
          if (tool.promptGuidelines?.length) {
            for (const guideline of tool.promptGuidelines) {
              lines.push(`  - ${guideline}`);
            }
          }
          return lines.join("\n");
        })
        .join("\n");
  return `${SYSTEM_PROMPT_BASE}\n\n${registry}`;
}

function createCustomTools(
  config: Pick<
    ArtemisConfig,
    "ollamaBaseUrl" | "ollamaApiKey"
  > &
    Partial<Pick<ArtemisConfig, "githubToken" | "githubAllowedRepositories">>,
  fetchImplementation: typeof fetch
) {
  return [
    createWebFetchTool({
      ollamaBaseUrl: config.ollamaBaseUrl,
      ollamaApiKey: config.ollamaApiKey,
      fetchImplementation
    }),
    ...createGitHubTools({
      token: config.githubToken ?? "",
      allowedRepositories: config.githubAllowedRepositories ?? [],
      fetchImplementation
    })
  ];
}

const emptyUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};

function storedToPiMessage(message: StoredMessage, fallbackModel: string): Message {
  const timestamp = Date.parse(message.createdAt);
  if (message.role === "user") {
    return {
      role: "user",
      content: formatDiscordMessage(message),
      timestamp
    };
  }

  const content: AssistantMessage["content"] = [];
  if (message.reasoning) {
    content.push({ type: "thinking", thinking: message.reasoning });
  }
  content.push({ type: "text", text: message.content });
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "ollama",
    model: message.model ?? fallbackModel,
    ...(Array.isArray(message.diagnostics)
      ? { diagnostics: message.diagnostics as AssistantMessageDiagnostic[] }
      : {}),
    usage: emptyUsage,
    stopReason: "stop",
    timestamp
  };
}

function extractGeneration(message: AssistantMessage): PiGenerationResult {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage ?? `PI generation stopped: ${message.stopReason}`);
  }
  const text = message.content
    .filter((item): item is Extract<AssistantMessage["content"][number], { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("");
  const reasoning = message.content
    .filter((item): item is ThinkingContent => item.type === "thinking")
    .map((item) => item.thinking)
    .join("\n");
  return {
    text,
    ...(reasoning ? { reasoning } : {}),
    ...(message.diagnostics ? { diagnostics: message.diagnostics } : {}),
    model: message.responseModel ?? message.model
  };
}

export class PiSdkGateway implements PiGateway {
  private modelRuntime: ModelRuntime | undefined;
  private resourceLoader: DefaultResourceLoader | undefined;
  private customTools: ReturnType<typeof createCustomTools> = [];

  public constructor(
    private readonly config: Pick<ArtemisConfig, "ollamaBaseUrl" | "ollamaModel" | "ollamaApiKey"> &
      Partial<Pick<
        ArtemisConfig,
        "githubToken" | "githubAllowedRepositories"
      >>,
    private readonly fetchImplementation: typeof fetch = fetch
  ) {}

  public async checkHealth(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await this.fetchImplementation(`${this.config.ollamaBaseUrl}/models`, {
        headers: this.authorizationHeaders(),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`Ollama health check failed with status ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
    await this.initialize();
  }

  public async generate(input: PiGenerationInput): Promise<PiGenerationResult> {
    await this.initialize();
    const customTools = this.customTools;
    const modelRuntime = this.modelRuntime;
    const resourceLoader = this.resourceLoader;
    if (!modelRuntime || !resourceLoader) {
      throw new Error("PI gateway failed to initialize");
    }
    const model = modelRuntime.getModel("ollama", this.config.ollamaModel);
    if (!model) {
      throw new Error(`Configured Ollama model is unavailable: ${this.config.ollamaModel}`);
    }

    const sessionManager = SessionManager.inMemory(process.cwd(), {
      id: input.logicalSessionId
    });
    for (const message of input.history) {
      sessionManager.appendMessage(storedToPiMessage(message, this.config.ollamaModel));
    }
    const { session } = await createAgentSession({
      modelRuntime,
      model,
      tools: customTools.map((tool) => tool.name),
      customTools,
      resourceLoader,
      sessionManager,
      settingsManager: SettingsManager.inMemory()
    });
    try {
      await session.prompt(input.prompt, { expandPromptTemplates: false, source: "rpc" });
      const response = [...session.messages]
        .reverse()
        .find((message): message is AssistantMessage => message.role === "assistant");
      if (!response) {
        throw new Error("PI completed without an assistant message");
      }
      return extractGeneration(response);
    } finally {
      session.dispose();
    }
  }

  private authorizationHeaders(): HeadersInit {
    if (this.config.ollamaApiKey === "ollama") {
      return {};
    }
    return { Authorization: `Bearer ${this.config.ollamaApiKey}` };
  }

  private async initialize(): Promise<void> {
    if (this.modelRuntime && this.resourceLoader) {
      return;
    }
    this.customTools = createCustomTools(this.config, this.fetchImplementation);
    const credentials = new InMemoryCredentialStore();
    const modelRuntime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      refreshOnCreate: false
    });
    modelRuntime.registerProvider("ollama", {
      name: "Ollama",
      baseUrl: this.config.ollamaBaseUrl,
      apiKey: this.config.ollamaApiKey,
      api: "openai-completions",
      authHeader: this.config.ollamaApiKey !== "ollama",
      models: [
        {
          id: this.config.ollamaModel,
          name: this.config.ollamaModel,
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_048_576,
          maxTokens: 65_536,
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: true
          }
        }
      ]
    });
    await modelRuntime.setRuntimeApiKey("ollama", this.config.ollamaApiKey);

    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: process.cwd(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: buildSystemPrompt(this.customTools)
    });
    await resourceLoader.reload();
    this.modelRuntime = modelRuntime;
    this.resourceLoader = resourceLoader;
  }
}

export const piInternals = { storedToPiMessage, extractGeneration, buildSystemPrompt };
