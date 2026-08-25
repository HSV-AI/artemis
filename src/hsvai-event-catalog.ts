import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const HSVAI_EVENT_THEMES = ["research", "building", "community"] as const;
export type HsvaiEventTheme = typeof HSVAI_EVENT_THEMES[number];

export interface HsvaiCatalogPerson {
  name: string;
  evidence?: string;
  provenance?: "source" | "operator";
}

export interface HsvaiEventCatalogSource {
  sourceId: string;
  title: string;
  url: string;
  modifiedAt: string;
  text: string;
}

export interface HsvaiEventCatalogEntry {
  sourceId: string;
  title: string;
  sourceUrl: string;
  modifiedAt: string;
  sourceHash: string;
  theme: HsvaiEventTheme;
  speakers: HsvaiCatalogPerson[];
}

export interface HsvaiEventCatalog {
  version: 1;
  events: HsvaiEventCatalogEntry[];
}

const BASELINE_CATALOG_PATH = fileURLToPath(
  new URL("../data/hsvai-event-catalog.jsonl", import.meta.url)
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTheme(value: unknown): value is HsvaiEventTheme {
  return typeof value === "string" && HSVAI_EVENT_THEMES.includes(value as HsvaiEventTheme);
}

function isCatalogPerson(value: unknown): value is HsvaiCatalogPerson {
  const hasEvidence = isRecord(value) && typeof value.evidence === "string" && Boolean(value.evidence.trim());
  return isRecord(value) && typeof value.name === "string" && Boolean(value.name.trim()) &&
    (hasEvidence || value.provenance === "operator") &&
    (value.provenance === undefined || value.provenance === "source" || value.provenance === "operator");
}

export function eventCatalogSourceHash(event: HsvaiEventCatalogSource): string {
  return createHash("sha256").update(JSON.stringify({
    sourceId: event.sourceId,
    title: event.title,
    url: event.url,
    modifiedAt: event.modifiedAt,
    text: event.text
  })).digest("hex");
}

function parseCatalog(value: unknown, path: string): HsvaiEventCatalog {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.events)) {
    throw new Error(`Invalid HSVAI event catalog: ${path}`);
  }
  const sourceIds = new Set<string>();
  const events = value.events as HsvaiEventCatalogEntry[];
  for (const event of events) {
    if (!isRecord(event) || typeof event.sourceId !== "string" ||
      typeof event.sourceHash !== "string" || !isTheme(event.theme) ||
      !Array.isArray(event.speakers) || !event.speakers.every(isCatalogPerson) ||
      sourceIds.has(event.sourceId)) {
      throw new Error(`Invalid HSVAI event catalog entry: ${path}`);
    }
    sourceIds.add(event.sourceId);
  }
  return { version: 1, events };
}

function parseCatalogJsonl(content: string, path: string): HsvaiEventCatalog {
  const events = content.split(/\r?\n/u).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid HSVAI event catalog JSONL at ${path}:${index + 1}: ${message}`);
    }
  });
  return parseCatalog({ version: 1, events }, path);
}

export function loadHsvaiEventCatalog(
  path = BASELINE_CATALOG_PATH
): HsvaiEventCatalog {
  return parseCatalogJsonl(readFileSync(path, "utf8"), path);
}

export function catalogEntryForEvent(
  event: HsvaiEventCatalogSource,
  catalog: HsvaiEventCatalog
): HsvaiEventCatalogEntry | undefined {
  const entry = catalog.events.find((candidate) => candidate.sourceId === event.sourceId);
  return entry?.sourceHash === eventCatalogSourceHash(event) ? entry : undefined;
}
