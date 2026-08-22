import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxProvider,
  InMemoryCredentialStore
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager
} from "@earendil-works/pi-coding-agent";
import { asPiSessionManager, SqlitePiSessionManager } from "../src/pi-session-manager.js";
import { ArtemisRepository } from "../src/repository.js";

describe("PI SDK session-manager compatibility", () => {
  let repository: ArtemisRepository | undefined;

  afterEach(() => repository?.close());

  it("creates and prompts a real PI agent through the SQLite adapter", async () => {
    const root = mkdtempSync(join(tmpdir(), "artemis-pi-sdk-"));
    const settingsManager = SettingsManager.inMemory({
      defaultThinkingLevel: "off",
      defaultTools: [],
      compaction: { enabled: false }
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "PI SDK compatibility test"
    });
    await resourceLoader.reload();

    const faux = fauxProvider({
      provider: "artemis-compatibility-test",
      models: [{ id: "compatibility-model", input: ["text"] }]
    });
    faux.setResponses([fauxAssistantMessage("adapter compatible")]);
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      refreshOnCreate: false
    });
    modelRuntime.registerNativeProvider(faux.provider);

    repository = new ArtemisRepository(join(root, "artemis.sqlite"));
    const logicalSession = repository.getOrCreateSession(
      { key: "dm:sdk-compatibility", kind: "dm", channelId: "sdk-compatibility" },
      "compatibility-model"
    );
    const manager = SqlitePiSessionManager.open(repository, root, logicalSession.id);
    const { session } = await createAgentSession({
      cwd: root,
      modelRuntime,
      model: faux.getModel(),
      tools: [],
      customTools: [],
      resourceLoader,
      settingsManager,
      sessionManager: asPiSessionManager(manager)
    });

    try {
      await session.prompt("compatibility check", {
        expandPromptTemplates: false,
        source: "rpc"
      });
      expect(session.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "adapter compatible" }]
      });
    } finally {
      session.dispose();
    }

    const restored = SqlitePiSessionManager.open(repository, root, logicalSession.id);
    expect(restored.buildSessionContext().messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: [{ type: "text", text: "compatibility check" }]
        }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "adapter compatible" }]
        })
      ])
    );
  });
});
