import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ReasoningEffort } from "./config.js";

/**
 * Self-introspection snapshot of the model provider and model this Artemis
 * process is actually running on. Fields the runtime cannot resolve stay
 * undefined and render as explicit "unknown" values instead of guesses. The
 * model API key is deliberately excluded: it is a credential, not runtime
 * metadata for conversation consumption.
 */
export interface RuntimeModelInfo {
  providerId?: string | undefined;
  providerName?: string | undefined;
  providerEndpoint?: string | undefined;
  modelId?: string | undefined;
  modelApi?: string | undefined;
  reasoning?: boolean | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  contextWindow?: number | undefined;
  maxTokens?: number | undefined;
}

export interface ModelInfoToolOptions {
  resolveModelInfo: () => RuntimeModelInfo | undefined;
}

const parameters = Type.Object({});

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

function knownOrUnknown(value: string | undefined): string {
  return value?.trim() || "unknown";
}

function tokenLimitOrUnknown(value: number | undefined): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? `${value} tokens`
    : "unknown";
}

function reasoningLine(snapshot: RuntimeModelInfo): string {
  if (snapshot.reasoning === undefined) {
    return "Reasoning: unknown";
  }
  const support = snapshot.reasoning ? "enabled" : "disabled";
  return snapshot.reasoningEffort === undefined
    ? `Reasoning: ${support}`
    : `Reasoning: ${support} (configured effort: ${snapshot.reasoningEffort})`;
}

export function formatModelInfo(snapshot: RuntimeModelInfo | undefined): string {
  if (!snapshot) {
    return "Model runtime information is currently unavailable.";
  }
  return [
    `Provider: ${knownOrUnknown(snapshot.providerName)} (id: ${knownOrUnknown(snapshot.providerId)})`,
    `Model: ${knownOrUnknown(snapshot.modelId)}`,
    `API: ${knownOrUnknown(snapshot.modelApi)}`,
    `Endpoint: ${knownOrUnknown(snapshot.providerEndpoint)}`,
    reasoningLine(snapshot),
    `Context window: ${tokenLimitOrUnknown(snapshot.contextWindow)}`,
    `Max output tokens: ${tokenLimitOrUnknown(snapshot.maxTokens)}`
  ].join("\n");
}

export function createModelInfoTool(options: ModelInfoToolOptions) {
  return defineTool({
    name: "model_info",
    label: "Model Info",
    description:
      "Report the model provider and model this Artemis instance is currently running on.",
    promptSnippet: "Report the model provider and model Artemis is currently running on",
    promptGuidelines: [
      "Use model_info when asked what model or provider you are running on, or when a deployment-configuration check requires it; trust its result instead of guessing your own model identity."
    ],
    parameters,
    async execute() {
      let snapshot: RuntimeModelInfo | undefined;
      try {
        snapshot = options.resolveModelInfo();
      } catch {
        snapshot = undefined;
      }
      return textResult(formatModelInfo(snapshot));
    }
  });
}