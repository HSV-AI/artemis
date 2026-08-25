import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  catalogEntryForEvent,
  eventCatalogSourceHash,
  loadHsvaiEventCatalog,
  type HsvaiEventCatalogSource
} from "../src/hsvai-event-catalog.js";

let temporaryDirectory: string | undefined;

afterEach(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

function source(text: string): HsvaiEventCatalogSource {
  return {
    sourceId: "event:1",
    title: "Synthetic Event",
    url: "https://example.test/events/1",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    text
  };
}

describe("HSVAI event catalog", () => {
  it("loads reviewed JSONL and applies only a source-matched entry", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-event-catalog-"));
    temporaryDirectory = directory;
    const path = join(directory, "catalog.jsonl");
    const event = source("Reviewed Speaker presents a synthetic event.");
    const reviewed = {
      sourceId: event.sourceId,
      title: event.title,
      sourceUrl: event.url,
      modifiedAt: event.modifiedAt,
      sourceHash: eventCatalogSourceHash(event),
      theme: "community" as const,
      speakers: [{ name: "Reviewed Speaker", provenance: "operator" as const }]
    };
    writeFileSync(path, `${JSON.stringify(reviewed)}\n`, "utf8");

    const catalog = loadHsvaiEventCatalog(path);

    expect(catalogEntryForEvent(event, catalog)).toEqual(reviewed);
    expect(catalogEntryForEvent(source("Changed source text."), catalog)).toBeUndefined();
  });

  it("identifies the invalid JSONL line", () => {
    const directory = mkdtempSync(join(tmpdir(), "artemis-event-catalog-"));
    temporaryDirectory = directory;
    const path = join(directory, "catalog.jsonl");
    writeFileSync(path, `${JSON.stringify({ sourceId: "event:1" })}\nnot-json\n`, "utf8");

    expect(() => loadHsvaiEventCatalog(path)).toThrow(`${path}:2`);
  });
});
