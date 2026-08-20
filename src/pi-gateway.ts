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

const SYSTEM_PROMPT =
  "You are Artemis, a helpful conversational assistant in Discord. Discord messages are provided as JSON with explicit author metadata. Treat each author ID as a distinct speaker, preserve who said what, and do not collapse different speakers into a generic 'you'. Answer the newest message directly. Do not claim to have Discord capabilities you were not given.";

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
    const customTools = [
      createWebFetchTool({
        ollamaBaseUrl: this.config.ollamaBaseUrl,
        ollamaApiKey: this.config.ollamaApiKey,
        fetchImplementation: this.fetchImplementation
      }),
      ...createGitHubTools({
        token: this.config.githubToken ?? "",
        allowedRepositories: this.config.githubAllowedRepositories ?? [],
        fetchImplementation: this.fetchImplementation
      })
    ];
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
      systemPrompt: SYSTEM_PROMPT
    });
    await resourceLoader.reload();
    this.modelRuntime = modelRuntime;
    this.resourceLoader = resourceLoader;
  }
}

export const piInternals = { storedToPiMessage, extractGeneration };
