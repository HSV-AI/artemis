import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enrichHsvaiEventCatalog,
  eventCatalogSourceHash,
  loadHsvaiEventCatalog,
  OpenAiEventExtractionModel,
  type HsvaiEventCatalogSource
} from "../src/hsvai-event-catalog.js";
import { modelConfig } from "./helpers.js";

let temporaryDirectory: string | undefined;

afterEach(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

function source(sourceId: string, text: string, title = "Synthetic Event"): HsvaiEventCatalogSource {
  return {
    sourceId,
    title,
    url: `https://example.test/events/${sourceId.split(":").at(-1)}`,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    text
  };
}

describe("HSVAI event catalog", () => {
  it("loads and merges synthetic JSONL catalogs", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-event-catalog-"));
    temporaryDirectory = directory;
    const baselinePath = join(directory, "baseline.jsonl");
    const runtimePath = join(directory, "runtime.jsonl");
    const reviewed = {
      sourceId: "event:1",
      title: "Reviewed Event",
      sourceUrl: "https://example.test/events/1",
      modifiedAt: "2026-01-01T00:00:00.000Z",
      sourceHash: "a".repeat(64),
      theme: "community",
      speakers: [{ name: "Reviewed Speaker", provenance: "operator" }]
    };
    const generated = { ...reviewed, speakers: [] };
    const added = {
      ...reviewed,
      sourceId: "event:3",
      sourceUrl: "https://example.test/events/3",
      sourceHash: "c".repeat(64),
      speakers: []
    };
    writeFileSync(
      baselinePath,
      `\n${JSON.stringify(reviewed)}\n`,
      "utf8"
    );
    writeFileSync(runtimePath, `${JSON.stringify(generated)}\n${JSON.stringify(added)}\n`, "utf8");

    expect(loadHsvaiEventCatalog(baselinePath, runtimePath).events).toEqual([
      reviewed,
      added
    ]);
  });

  it("identifies the invalid JSONL line", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-event-catalog-"));
    temporaryDirectory = directory;
    const baselinePath = join(directory, "baseline.jsonl");
    writeFileSync(baselinePath, `${JSON.stringify({ sourceId: "event:1" })}\nnot-json\n`, "utf8");

    expect(() => loadHsvaiEventCatalog(baselinePath, join(directory, "missing.jsonl")))
      .toThrow(`${baselinePath}:2`);
  });

  it("keeps current seed entries and asks the model only for changed events", async () => {
    const current = source("event:1", "Synthetic paper review.");
    const added = source("event:2", "Synthetic content without deterministic classification.");
    const existingEntry = {
      sourceId: current.sourceId,
      title: current.title,
      sourceUrl: current.url,
      modifiedAt: current.modifiedAt,
      sourceHash: eventCatalogSourceHash(current),
      theme: "research" as const,
      speakers: []
    };
    const extract = vi.fn().mockResolvedValue(new Map([[
      added.sourceId,
      {
        theme: "building" as const,
        speakers: [{ name: "Model Speaker", evidence: "Model Speaker demonstrates a tool." }]
      }
    ]]));
    const catalog = await enrichHsvaiEventCatalog(
      [current, { ...added, text: "Model Speaker demonstrates a tool." }],
      { version: 1, events: [existingEntry] },
      extract
    );

    expect(extract).toHaveBeenCalledOnce();
    expect(extract.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ sourceId: added.sourceId })
    ]);
    expect(catalog.events).toEqual([
      existingEntry,
      expect.objectContaining({
        sourceId: added.sourceId,
        theme: "building",
        speakers: [expect.objectContaining({ name: "Model Speaker" })]
      })
    ]);
  });

  it("canonicalizes model people from source", async () => {
    const event = source("event:3", "Model Speaker leads a synthetic workshop.");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        events: [{
          sourceId: event.sourceId,
          theme: "building",
          speakers: [{ name: "Model Speaker" }]
        }]
      }) } }]
    }), { status: 200 }));
    const extractor = new OpenAiEventExtractionModel(modelConfig(), fetchMock);

    await expect(extractor.extract([event])).resolves.toEqual(new Map([[
      event.sourceId,
      expect.objectContaining({
        theme: "building",
        speakers: [{ name: "Model Speaker", evidence: event.text }]
      })
    ]]));
  });

  it("rejects model names absent from synthetic source data", async () => {
    const event = source("event:4", "No named speaker is present.");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        events: [{
          sourceId: event.sourceId,
          theme: "community",
          speakers: [{ name: "Unsupported Speaker" }]
        }]
      }) } }]
    }), { status: 200 }));

    await expect(new OpenAiEventExtractionModel(modelConfig(), fetchMock).extract([event]))
      .rejects.toThrow("unsupported person");
  });

  it("reports model transport, empty-response, and omitted-event failures", async () => {
    const event = source("event:5", "Synthetic source text.");
    const failed = new OpenAiEventExtractionModel(
      modelConfig(),
      vi.fn().mockResolvedValue(new Response("offline", { status: 503 }))
    );
    await expect(failed.extract([event])).rejects.toThrow("failed (503)");

    const empty = new OpenAiEventExtractionModel(
      modelConfig(),
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200 }))
    );
    await expect(empty.extract([event])).rejects.toThrow("returned no content");

    const omitted = new OpenAiEventExtractionModel(
      modelConfig(),
      vi.fn().mockResolvedValue(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ events: [] }) } }]
      }), { status: 200 }))
    );
    await expect(omitted.extract([event])).rejects.toThrow(`omitted ${event.sourceId}`);
  });

  it("combines deterministic and model extraction for changed events", async () => {
    const event = source(
      "event:6",
      "Test Facilitator will be there to facilitate working groups.",
      "Synthetic Coding Workshop"
    );
    const extract = vi.fn().mockResolvedValue(new Map([[
      event.sourceId,
      { theme: "community" as const, speakers: [] }
    ]]));

    await expect(enrichHsvaiEventCatalog(
      [event],
      { version: 1, events: [] },
      extract
    )).resolves.toMatchObject({
      events: [{
        sourceId: event.sourceId,
        theme: "building",
        speakers: [expect.objectContaining({ name: "Test Facilitator" })]
      }]
    });
  });
});
