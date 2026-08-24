import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { DgraphClient } from "./dgraph-memory.js";
import { EmbeddingClient } from "./embedding-client.js";
import {
  enrichHsvaiEventCatalog,
  hsvaiEventCatalogPaths,
  loadHsvaiEventCatalog,
  OpenAiEventExtractionModel
} from "./hsvai-event-catalog.js";
import { HsvaiKnowledge, HsvaiWordPressSource } from "./hsvai-knowledge.js";

const config = loadConfig();
const outputPath = resolve(
  process.argv[2] ?? process.env.HSVAI_EVENT_CATALOG_PATH ?? hsvaiEventCatalogPaths.runtime
);
const source = new HsvaiWordPressSource(fetch, { version: 1, events: [] });
const documents = await source.fetchDocuments();
const events = documents.filter((document) => document.kind === "event");
const existing = loadHsvaiEventCatalog(hsvaiEventCatalogPaths.baseline, outputPath);
const extractor = new OpenAiEventExtractionModel(config.model);
const catalog = await enrichHsvaiEventCatalog(events, existing, extractor.extract);

mkdirSync(dirname(outputPath), { recursive: true });
const temporaryPath = `${outputPath}.tmp`;
writeFileSync(
  temporaryPath,
  `${catalog.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  "utf8"
);
renameSync(temporaryPath, outputPath);

const authorizationHeaders = config.model.apiKey &&
  !(config.model.providerId === "ollama" && config.model.apiKey === "ollama")
  ? { Authorization: `Bearer ${config.model.apiKey}` }
  : {};
const embedding = config.model.embedding
  ? new EmbeddingClient(
      config.model.embedding.baseUrl,
      config.model.embedding.modelId,
      authorizationHeaders
    )
  : undefined;
const syncClient = new DgraphClient(config.dgraphUrl, fetch, config.hsvaiDgraphSyncAuth);
const queryClient = new DgraphClient(config.dgraphUrl, fetch, config.hsvaiDgraphQueryAuth);
const knowledge = new HsvaiKnowledge(
  syncClient,
  new HsvaiWordPressSource(fetch, catalog),
  embedding
    ? {
        embed: embedding.embed,
        embedMany: embedding.embedMany,
        embeddingVersion: () => embedding.embeddingModel(),
        queryClient
      }
    : { queryClient }
);
const result = await knowledge.initializeAndSync();
const speakers = catalog.events.reduce((count, event) => count + event.speakers.length, 0);

process.stdout.write(
  `Synchronized ${result.documents} HSVAI documents with ${catalog.events.length} events and ${speakers} speakers (${result.changed ? "changed" : "unchanged"}).\n`
);
