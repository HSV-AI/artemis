import { describe, expect, it, vi } from "vitest";
import {
  createModelInfoTool,
  formatModelInfo,
  type RuntimeModelInfo
} from "../src/model-info-tool.js";

function fullSnapshot(): RuntimeModelInfo {
  return {
    providerId: "test-provider",
    providerName: "Test Provider",
    providerEndpoint: "http://model-provider/v1",
    modelId: "test-model",
    modelApi: "openai-completions",
    reasoning: true,
    reasoningEffort: "medium",
    contextWindow: 32_000,
    maxTokens: 4_096
  };
}

function executeTool(tool: ReturnType<typeof createModelInfoTool>) {
  return tool.execute("call", {}, undefined, undefined, {} as Parameters<typeof tool.execute>[4]);
}

function resultText(result: { content: ReadonlyArray<{ type: unknown; text?: unknown }> }): string {
  const text = result.content[0]?.text;
  return typeof text === "string" ? text : "";
}

describe("model_info tool", () => {
  it("registers a self-introspection PI tool without parameters", () => {
    const tool = createModelInfoTool({ resolveModelInfo: () => fullSnapshot() });
    expect(tool).toMatchObject({
      name: "model_info",
      label: "Model Info",
      parameters: { type: "object" }
    });
    expect(tool.description.toLowerCase()).toContain("provider");
    expect(tool.description.toLowerCase()).toContain("model");
  });

  it("reports the resolved provider and model without inventing values", async () => {
    const resolver = vi.fn(() => fullSnapshot());
    const tool = createModelInfoTool({ resolveModelInfo: resolver });
    const result = await executeTool(tool);
    expect(resolver).toHaveBeenCalledOnce();
    expect(result.content[0]?.type).toBe("text");
    expect(resultText(result)).toBe(
      [
        "Provider: Test Provider (id: test-provider)",
        "Model: test-model",
        "API: openai-completions",
        "Endpoint: http://model-provider/v1",
        "Reasoning: enabled (configured effort: medium)",
        "Context window: 32000 tokens",
        "Max output tokens: 4096 tokens"
      ].join("\n")
    );
  });

  it("reports unknown for fields the runtime cannot resolve", async () => {
    const tool = createModelInfoTool({
      resolveModelInfo: () => ({
        providerId: "test-provider",
        providerName: "   ",
        modelId: "test-model",
        reasoning: false,
        contextWindow: 0,
        maxTokens: undefined
      })
    });
    const result = await executeTool(tool);
    const text = resultText(result);
    expect(text).toContain("Provider: unknown (id: test-provider)");
    expect(text).toContain("Model: test-model");
    expect(text).toContain("API: unknown");
    expect(text).toContain("Endpoint: unknown");
    expect(text).toContain("Reasoning: disabled");
    expect(text).not.toContain("configured effort");
    expect(text).toContain("Context window: unknown");
    expect(text).toContain("Max output tokens: unknown");
  });

  it("reports enabled reasoning without an effort when none is configured", () => {
    const text = formatModelInfo({
      providerId: "test-provider",
      providerName: "Test Provider",
      modelId: "test-model",
      reasoning: true
    });
    expect(text).toContain("Reasoning: enabled");
    expect(text).not.toContain("configured effort");
  });

  it("states unavailability instead of guessing when the runtime is unresolvable", async () => {
    const tool = createModelInfoTool({ resolveModelInfo: () => undefined });
    const result = await executeTool(tool);
    expect(resultText(result)).toBe("Model runtime information is currently unavailable.");
  });

  it("surfaces unavailability when resolution fails unexpectedly", async () => {
    const tool = createModelInfoTool({
      resolveModelInfo: () => {
        throw new Error("resolver boom");
      }
    });
    const result = await executeTool(tool);
    expect(resultText(result)).toBe("Model runtime information is currently unavailable.");
  });
});