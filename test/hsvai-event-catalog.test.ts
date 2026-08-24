import { describe, expect, it, vi } from "vitest";
import {
  catalogEntryForEvent,
  enrichHsvaiEventCatalog,
  eventCatalogSourceHash,
  extractDeterministicEventMetadata,
  hsvaiEventCatalogPaths,
  loadHsvaiEventCatalog,
  mergeHsvaiEventCatalog,
  OpenAiEventExtractionModel,
  type HsvaiEventCatalogSource
} from "../src/hsvai-event-catalog.js";
import { modelConfig } from "./helpers.js";

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
  it("represents reviewed speakerless events with an empty speaker list", () => {
    const catalog = loadHsvaiEventCatalog(
      hsvaiEventCatalogPaths.baseline,
      `${hsvaiEventCatalogPaths.baseline}.missing`
    );

    expect(catalog.events.some((event) => event.speakers.length === 0)).toBe(true);
    expect(catalog.events.flatMap((event) => event.speakers).map((person) => person.name))
      .not.toContain("No Speaker");
  });

  it("extracts synthetic presenters and facilitators as speakers", () => {
    const metadata = extractDeterministicEventMetadata(source(
      "event:1",
      "Test Speaker presenting the results.\nTest Facilitator will be there to facilitate tables.",
      "Synthetic Paper Review"
    ));

    expect(metadata).toEqual({
      theme: "research",
      speakers: expect.arrayContaining([
        expect.objectContaining({ name: "Test Speaker" }),
        expect.objectContaining({ name: "Test Facilitator" })
      ])
    });
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
    expect(catalogEntryForEvent(current, catalog)).toEqual(existingEntry);
  });

  it("keeps reviewed metadata over a same-source runtime entry", () => {
    const event = source("event:reviewed", "Synthetic source text.");
    const reviewed = {
      sourceId: event.sourceId,
      title: event.title,
      sourceUrl: event.url,
      modifiedAt: event.modifiedAt,
      sourceHash: eventCatalogSourceHash(event),
      theme: "community" as const,
      speakers: [{
        name: "Reviewed Speaker",
        provenance: "operator" as const
      }]
    };
    const generated = { ...reviewed, speakers: [] };

    expect(mergeHsvaiEventCatalog(
      { version: 1, events: [reviewed] },
      { version: 1, events: [generated] }
    ).events).toEqual([reviewed]);

    const changed = { ...generated, sourceHash: "changed-source-hash" };
    expect(mergeHsvaiEventCatalog(
      { version: 1, events: [reviewed] },
      { version: 1, events: [changed] }
    ).events).toEqual([changed]);
  });

  it("uses the configured provider and canonicalizes model people from source", async () => {
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
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "test-model",
      response_format: { type: "json_object" }
    });
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
});
