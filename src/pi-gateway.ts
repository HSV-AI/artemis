import { dirname, join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { AssistantMessage, ThinkingContent } from "@earendil-works/pi-ai";
import { DEFAULT_DGRAPH_URL, type ArtemisConfig } from "./config.js";
import { DgraphClient, GraphMemory } from "./dgraph-memory.js";
import type {
  ChannelMembershipChecker,
  ChannelTimezoneStore,
  ConversationKind,
  Logger,
  PiGateway,
  PiGenerationInput,
  PiGenerationResult,
  PiSessionStore,
  ScheduledPromptStore
} from "./domain.js";
import { createGitHubTools } from "./github-tools.js";
import { loadHsvaiEventCatalog } from "./hsvai-event-catalog.js";
import {
  createHsvaiGraphQueryTool,
  createHsvaiKnowledgeTool,
  HsvaiKnowledge,
  HsvaiWordPressSource
} from "./hsvai-knowledge.js";
import { createModelInfoTool, type RuntimeModelInfo } from "./model-info-tool.js";
import { createMemoryTools } from "./memory-tools.js";
import { DEFAULT_BOT_DISPLAY_NAME, type PersonaProfile } from "./persona-profiles.js";
import {
  asPiSessionManager,
  SqlitePiSessionManager
} from "./pi-session-manager.js";
import { createSchedulerTools } from "./scheduler-tools.js";
import { createChannelTimezoneTools } from "./timezone-tools.js";
import { createWebFetchTool } from "./web-fetch-tool.js";

/**
 * Maximum number of Discord messages Artemis may split a single response into
 * when replying in a group/channel. Direct messages (DMs) are not bound by this
 * limit. Documented in the system prompt so the model enforces it.
 */
export const GROUP_CHANNEL_MULTI_MESSAGE_MAX = 3;

const DISCORD_BEHAVIOR_PROMPT =
  "Discord messages are provided as JSON with explicit author metadata. Treat each author ID as a distinct speaker, preserve who said what, and do not collapse different speakers into a generic 'you'. Answer the newest message directly. Do not claim to have Discord capabilities you were not given.";

/**
 * Channel multi-message limits. Only appended to the system prompt for
 * group/channel (guild) sessions. Direct messages never receive this block so
 * the model is not told any length limitation for DMs. Selection is driven by
 * {@link buildSystemPrompt} from the conversation kind, making it deterministic.
 */
const CHANNEL_LIMITS_PROMPT_BLOCK = `

## Discord Channel Limits
Write responses like a Discord message — concise and conversational. One or two sentences usually does it. Use code blocks for code/config. Don't pad.

In group/channel messages, you may respond in up to ${GROUP_CHANNEL_MULTI_MESSAGE_MAX} messages. Each message must be a complete, self-contained thought — never split a sentence across messages.

(GROUP_CHANNEL_MULTI_MESSAGE_MAX = ${GROUP_CHANNEL_MULTI_MESSAGE_MAX})`;

const CAPABILITY_GAP_PROMPT_BLOCK =
  "\n\n## Capability Gap Protocol\n\n" +
  "When you encounter a missing capability or tool, you MUST NOT explore source code, generate code, or jury-rig a workaround. Do not self-modify. Follow this protocol instead:\n" +
  "1. Acknowledge the gap — tell the user plainly that you cannot fulfill the request with your current tools.\n" +
  "2. File a GitHub issue — use the `github_create` tool with resource `issue` against the HSV-AI/artemis project to request the missing tool or capability.\n" +
  "3. Define requirements — in the issue body specify the inputs, outputs, error cases, and acceptance criteria the new capability must satisfy.\n" +
  "4. Wait for implementation — the coder agent builds it; you do not self-modify or improvise.\n\n" +
  "Stop immediately when you realize a tool is missing. Do not attempt partial workarounds. Never generate code to compensate for a missing capability.\n\n" +
  "## Available Tools\n\n" +
  "The tools listed below are registered and available to you. Any capability not listed here is a gap: apply the Capability Gap Protocol instead of improvising.";

export interface ToolRegistryEntry {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
}

/**
 * Build the system prompt deterministically from the conversation kind, the bot's
 * Discord-resolved display name, the selected persona profile, and the registered
 * tools. Guild/channel sessions get the channel-limits block; DM sessions never
 * see limit messaging. The Capability Gap Protocol and Available Tools sections
 * are always included so the model knows its real boundaries.
 *
 * Name resolution: a named persona profile (e.g. `artemis`, `wartermis`) owns
 * its identity and its `name` is used for self-introduction regardless of the
 * Discord display name. The default `generic` profile defines no name, so the
 * bot's display name resolved from Discord at startup (see
 * `PiSdkGateway.setBotDisplayName`) is used instead. When neither a persona
 * name nor a Discord display name is available, {@link DEFAULT_BOT_DISPLAY_NAME}
 * is the sensible fallback so the bot can still introduce itself.
 */
export function buildSystemPrompt(
  kind: ConversationKind,
  persona: PersonaProfile,
  botDisplayName: string | undefined = undefined,
  tools: readonly ToolRegistryEntry[] = [],
  hsvaiCorpusRevision = ""
): string {
  const personaName = persona.name.trim();
  const discordName = botDisplayName?.trim();
  const resolvedName = personaName || discordName || DEFAULT_BOT_DISPLAY_NAME;
  const identityBlock = `Your name is ${resolvedName}. When someone asks your name, introduce yourself as ${resolvedName}.`;
  const channelLimits = kind === "guild" ? CHANNEL_LIMITS_PROMPT_BLOCK : "";
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
  const corpusState = hsvaiCorpusRevision
    ? "\n\n## HSVAI Corpus State\n" +
      `Current corpus revision: ${hsvaiCorpusRevision}. ` +
      "Historical HSVAI tool results with this revision remain current and may be reused. " +
      "Results with a different revision or no revision label are stale and must be queried again before use."
    : "";
  return `${identityBlock} ${persona.instructions.trim()} ${DISCORD_BEHAVIOR_PROMPT}${channelLimits}${CAPABILITY_GAP_PROMPT_BLOCK}\n\n${registry}${corpusState}`;
}

function createCustomTools(
  config: Partial<Pick<ArtemisConfig, "model" | "githubToken" | "githubAllowedRepositories">>,
  fetchImplementation: typeof fetch,
  resolveModelInfo: () => RuntimeModelInfo | undefined
) {
  return [
    createWebFetchTool({ fetchImplementation }),
    createModelInfoTool({ resolveModelInfo }),
    ...createGitHubTools({
      token: config.githubToken ?? "",
      allowedRepositories: config.githubAllowedRepositories ?? [],
      fetchImplementation
    })
  ];
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
  private readonly resourceLoaders = new Map<string, {
    hsvaiCorpusRevision: string;
    loader: DefaultResourceLoader;
  }>();
  private customTools: ReturnType<typeof createCustomTools> = [];
  private botDisplayName: string | undefined;
  private readonly memory: GraphMemory;
  private readonly knowledge: HsvaiKnowledge;
  private readonly timezoneStore: ChannelTimezoneStore | undefined;
  private readonly schedulerStore: ScheduledPromptStore | undefined;

  public constructor(
    private readonly config: Pick<ArtemisConfig, "model" | "persona"> &
      Partial<Pick<
        ArtemisConfig,
        | "githubToken"
        | "githubAllowedRepositories"
        | "dgraphUrl"
        | "dgraphAuth"
        | "hsvaiDgraphSyncAuth"
        | "hsvaiDgraphQueryAuth"
        | "sqlitePath"
      >>,
    private readonly sessionStore: PiSessionStore,
    private readonly fetchImplementation: typeof fetch = fetch,
    logger?: Pick<Logger, "info" | "warn">,
    timezoneStore?: ChannelTimezoneStore,
    schedulerStore?: ScheduledPromptStore,
    private readonly membership?: ChannelMembershipChecker
  ) {
    const dgraph = new DgraphClient(
      config.dgraphUrl ?? DEFAULT_DGRAPH_URL,
      fetchImplementation,
      config.dgraphAuth
    );
    const hsvaiSync = new DgraphClient(
      config.dgraphUrl ?? DEFAULT_DGRAPH_URL,
      fetchImplementation,
      config.hsvaiDgraphSyncAuth
    );
    const hsvaiQuery = new DgraphClient(
      config.dgraphUrl ?? DEFAULT_DGRAPH_URL,
      fetchImplementation,
      config.hsvaiDgraphQueryAuth
    );
    this.memory = new GraphMemory(dgraph);
    this.timezoneStore = timezoneStore;
    this.schedulerStore = schedulerStore;
    const sourceCachePath = config.sqlitePath && config.sqlitePath !== ":memory:"
      ? join(dirname(config.sqlitePath), "hsvai-source-cache.json")
      : undefined;
    this.knowledge = new HsvaiKnowledge(
      hsvaiSync,
      new HsvaiWordPressSource(fetchImplementation, loadHsvaiEventCatalog(), {
        ...(sourceCachePath ? { cachePath: sourceCachePath } : {}),
        reportCache(event) {
          const { state, ...fields } = event;
          if (state === "repaired") logger?.warn("hsvai_source_cache_repaired", fields);
          else logger?.info(`hsvai_source_cache_${state}`, fields);
        }
      }),
      hsvaiQuery
    );
  }

  /**
   * Set the bot's Discord display name, resolved from the connected Discord
   * client at startup. The name is injected into every system prompt built for
   * a persona that does not own its own name (the default `generic` profile), so
   * the model introduces itself with the name Discord users actually see. A
   * named persona profile (e.g. `artemis`, `wartermis`) keeps its own name and is
   * unaffected. Clears the cached resource loaders so the next generation
   * rebuilds the prompt with the new name.
   */
  public setBotDisplayName(name: string): void {
    const trimmed = name.trim();
    this.botDisplayName = trimmed || undefined;
    this.resourceLoaders.clear();
  }

  public async checkHealth(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await this.fetchImplementation(`${this.config.model.baseUrl}/models`, {
        headers: this.authorizationHeaders(),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`Model provider health check failed with status ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
    await this.memory.initialize();
    await this.knowledge.initializeAndSync();
    await this.initialize();
  }

  public async generate(input: PiGenerationInput): Promise<PiGenerationResult> {
    await this.initialize();
    const hsvaiCorpusRevision = await this.knowledge.corpusRevision();
    // The conversation's stored timezone is resolved by the harness and
    // injected into the scheduler tools; the model cannot set it per call.
    const defaultTimezone = this.timezoneStore?.getChannelTimezone(input.conversationKey);
    const customTools = [
      ...this.customTools,
      createHsvaiKnowledgeTool(this.knowledge, hsvaiCorpusRevision),
      createHsvaiGraphQueryTool(this.knowledge, hsvaiCorpusRevision),
      ...createMemoryTools(this.memory, {
        scopeKey: input.conversationKey,
        authorId: input.authorId,
        sourceMessageId: input.sourceMessageId,
        episodeId: input.logicalSessionId
      }),
      // Channel timezone tools read and write through the harness-injected
      // conversation key. No tool parameter can influence the channel identity.
      ...(this.timezoneStore
        ? createChannelTimezoneTools(this.timezoneStore, { conversationKey: input.conversationKey })
        : []),
      // Scheduler tools are bound to the harness-injected conversation key,
      // scheduling user, and membership authority, plus the conversation's
      // stored timezone. Model parameters cannot supply or override the
      // channel identity, the scheduling user, or the default timezone.
      ...(this.schedulerStore
        ? createSchedulerTools(this.schedulerStore, {
            conversationKey: input.conversationKey,
            schedulingUserId: input.authorId,
            ...(defaultTimezone === undefined ? {} : { defaultTimezone }),
            ...(this.membership === undefined ? {} : { membership: this.membership })
          })
        : [])
    ];
    const modelRuntime = this.modelRuntime;
    if (!modelRuntime) {
      throw new Error("PI gateway failed to initialize");
    }
    const resourceLoader = await this.getResourceLoader(input, customTools, hsvaiCorpusRevision);
    const model = modelRuntime.getModel(
      this.config.model.providerId,
      this.config.model.modelId
    );
    if (!model) {
      throw new Error(`Configured model is unavailable: ${this.config.model.modelId}`);
    }

    const sessionManager = SqlitePiSessionManager.open(
      this.sessionStore,
      process.cwd(),
      input.logicalSessionId
    );
    const { session } = await createAgentSession({
      modelRuntime,
      model,
      tools: customTools.map((tool) => tool.name),
      customTools,
      resourceLoader,
      sessionManager: asPiSessionManager(sessionManager),
      settingsManager: SettingsManager.inMemory(),
      ...(this.config.model.reasoningEffort === undefined
        ? {}
        : { thinkingLevel: this.config.model.reasoningEffort })
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

  private authorizationHeaders(): Record<string, string> {
    if (!this.usesAuthorizationHeader()) {
      return {};
    }
    return { Authorization: `Bearer ${this.config.model.apiKey}` };
  }

  private usesAuthorizationHeader(): boolean {
    const { providerId, apiKey } = this.config.model;
    return Boolean(apiKey) && !(providerId === "ollama" && apiKey === "ollama");
  }

  /**
   * Introspect the live PI state for the configured provider and model. The
   * provider and model are looked up through the registered ModelRuntime so the
   * answer reflects what Artemis is actually running, and the result is
   * undefined whenever the runtime is not initialized or the configured model
   * is not registered. The reasoning effort remains configured metadata because
   * the registered model does not carry the selected effort.
   */
  private resolveModelInfo(): RuntimeModelInfo | undefined {
    const runtime = this.modelRuntime;
    if (!runtime) {
      return undefined;
    }
    const model = runtime.getModel(
      this.config.model.providerId,
      this.config.model.modelId
    );
    if (!model) {
      return undefined;
    }
    const provider = runtime.getProvider(this.config.model.providerId);
    return {
      providerId: this.config.model.providerId,
      providerName: provider?.name,
      providerEndpoint: provider?.baseUrl,
      modelId: model.id,
      modelApi: model.api,
      reasoning: model.reasoning,
      reasoningEffort: this.config.model.reasoningEffort,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens
    };
  }

  private async initialize(): Promise<void> {
    if (this.modelRuntime) {
      return;
    }
    this.customTools = createCustomTools(this.config, this.fetchImplementation, () =>
      this.resolveModelInfo()
    );
    const credentials = new InMemoryCredentialStore();
    const modelRuntime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      refreshOnCreate: false
    });
    const modelConfig = this.config.model;
    const thinkingLevelMap = modelConfig.reasoningEffort === "xhigh" || modelConfig.reasoningEffort === "max"
      ? { [modelConfig.reasoningEffort]: modelConfig.reasoningEffort }
      : undefined;
    modelRuntime.registerProvider(modelConfig.providerId, {
      name: modelConfig.providerName,
      baseUrl: modelConfig.baseUrl,
      apiKey: modelConfig.apiKey,
      api: "openai-completions",
      authHeader: this.usesAuthorizationHeader(),
      models: [
        {
          id: modelConfig.modelId,
          name: modelConfig.modelId,
          reasoning: modelConfig.reasoning,
          thinkingLevelMap,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: modelConfig.contextWindow,
          maxTokens: modelConfig.maxTokens,
          compat: {
            supportsDeveloperRole: modelConfig.supportsDeveloperRole,
            supportsReasoningEffort: modelConfig.reasoningEffort !== undefined
          }
        }
      ]
    });
    if (modelConfig.apiKey) {
      await modelRuntime.setRuntimeApiKey(modelConfig.providerId, modelConfig.apiKey);
    }
    this.modelRuntime = modelRuntime;
  }

  private async getResourceLoader(
    input: PiGenerationInput,
    tools: readonly ToolRegistryEntry[],
    hsvaiCorpusRevision: string
  ): Promise<DefaultResourceLoader> {
    const cacheKey = input.conversationKind;
    const existing = this.resourceLoaders.get(cacheKey);
    if (existing?.hsvaiCorpusRevision === hsvaiCorpusRevision) {
      return existing.loader;
    }
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: process.cwd(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: buildSystemPrompt(
        input.conversationKind,
        this.config.persona,
        this.botDisplayName,
        tools,
        hsvaiCorpusRevision
      )
    });
    await resourceLoader.reload();
    this.resourceLoaders.set(cacheKey, { hsvaiCorpusRevision, loader: resourceLoader });
    return resourceLoader;
  }
}

export const piInternals = { extractGeneration, buildSystemPrompt };
