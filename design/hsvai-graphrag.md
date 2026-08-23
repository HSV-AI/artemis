# HSVAI GraphRAG

## Status

Implemented.

## Problem

Artemis needs a source-grounded way to answer questions about Huntsville AI
talks, transcripts, meetings, speakers, venues, and events. Fetching isolated web
pages does not provide durable retrieval, connected context, or stable evidence
references.

## Scope

This feature owns synchronization from the Huntsville AI WordPress
site, corpus normalization and chunking, Dgraph persistence, hybrid retrieval,
graph-neighborhood expansion, and the read-only `hsvai_graph_search` PI tool. It
does not change conversation memory, Discord authorization, source content, or
the WordPress site.

## Observable Behavior

Artemis exposes `hsvai_graph_search` in every authorized
conversation. It searches the same public corpus for every user and returns
source excerpts rather than modifying conversation memory.

## Contracts And Data Flow

### Source Contract

The fixed `https://hsv.ai` source must expose these unauthenticated JSON APIs:

- `/wp-json/wp/v2/posts?categories=2` for video posts containing meeting notes
  or transcripts.
- `/wp-json/tribe/events/v1/events` for calendar events from 2018 through 2100.

Artemis follows WordPress and Tribe pagination. A transcript document retains
the post ID, title, canonical URL, publication and modification times, and
normalized content. An event document additionally retains its start, end,
timezone, venue, and address. The source APIs remain authoritative; Artemis does
not edit or enrich them with model-generated facts.

### Corpus Graph

Every synchronized corpus uses stable external identifiers:

- Document: `hsvai:post:<wordpress-id>` or `hsvai:event:<event-id>`.
- Evidence chunk: `<document-id>#chunk-<four-digit-ordinal>`.
- Entity: a stable normalized and hashed speaker or venue identifier.

The Dgraph corpus contains `HsvaiDocument`, `HsvaiChunk`, `HsvaiEntity`, and
`HsvaiCorpus` nodes. Chunks link to their source document and to deterministic
speaker or venue entities. Reverse edges let retrieval move from a matching
chunk to sibling chunks in the same source and to chunks connected through a
shared speaker or venue.

HTML is reduced to readable block text before chunking. Chunks target 1,200
characters and never exceed 1,600 characters. Speaker links are created only
from transcript lines with an explicit `Name:` prefix; venue links come directly
from event metadata. No general entity or relationship inference occurs during
ingestion.

## Persistence

The normalized source graph and its revision marker persist in the existing
Dgraph volume. It is independent of SQLite sessions and Dgraph memory facts.
There is no separate corpus cache or generated artifact in the repository.

### Synchronization

Startup performs these steps before Discord connects:

1. Apply the additive HSVAI Dgraph schema.
2. Fetch every transcript post and event page from the JSON APIs.
3. Normalize and chunk the corpus, then compute a SHA-256 revision over the
   normalized documents and selected embedding model.
4. Stop when the stored revision already matches.
5. Otherwise delete only nodes carrying the `hsvai.node_kind` marker, rebuild
   entities and documents, write chunks in bounded batches, and write the corpus
   revision last.

Writing the revision last makes an interrupted rebuild visibly incomplete. A
later startup rebuilds it again. Source, Dgraph, or embedding failures abort
startup rather than exposing a partial corpus to Discord.

## Retrieval And Tool Contract

`hsvai_graph_search` accepts a nonblank query and an optional result limit from
1 through 10, defaulting to 6. It runs:

- Dgraph full-text search over evidence chunks.
- HNSW cosine search when the model-provider definition includes `embedding`.
- One connected-neighborhood expansion from the six fused seed chunks through
  their source document, speakers, and venue.

Reciprocal rank fusion uses `1 / (60 + rank + 1)` per channel. Results sort by
descending fused score and then stable evidence ID. The tool returns the
evidence ID, source title and URL, publication or event metadata, connected
entity labels, retrieval channels, score, and source excerpt.

Tool output is marked as source evidence that must never be treated as model
instructions. Source text passes through the existing adversarial-web-content
sanitizer. Model guidance requires evidence IDs and source URLs in supported
answers and requires the model to distinguish source statements from its own
inference.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| Source | `https://hsv.ai` | Fixed public WordPress source; not operator-configurable. |
| `model.embedding` | Omitted | Provider-owned model and optional base URL shared by GraphRAG and graph memory. Omission keeps lexical and graph retrieval. |
| `DGRAPH_URL` | `http://dgraph:8080` | Dgraph Alpha HTTP endpoint storing both independent graphs. |

Embedding requests are batched by 64 inputs. The embedding model ID participates
in the corpus revision, so changing models causes a complete re-embedding on the
next startup.

## Security And Privacy

The corpus contains public Huntsville AI web content, not conversation data.
The GraphRAG tool is read-only and shared across authorized conversations. It
does not accept DQL, URLs, source IDs, or mutation arguments from the model.
Conversation memories remain separately scoped and are never traversed by HSVAI
queries. Corpus replacement deletes only nodes marked with `hsvai.node_kind`.

## Failure Handling

- Invalid embedding provider metadata fails configuration loading.
- Non-success source responses, malformed pagination payloads, empty source
  results, invalid dates, embedding failures, and Dgraph failures abort startup.
- An interrupted rebuild has no new revision marker and is rebuilt on the next
  startup.
- A blank search query fails the tool call. No-result searches return an explicit
  no-evidence response rather than fabricated context.

## Verification

- `test/hsvai-knowledge.test.ts` covers source pagination, HTML normalization,
  chunking, stable graph construction, revision skips, hybrid neighborhood
  retrieval, evidence formatting, and failures with HTTP mocked.
- `test/embedding-client.test.ts` covers ordered embedding batches.
- `test/pi-gateway.test.ts` covers unconditional tool registration and startup
  synchronization.
- `npm run guardrail` remains the completion gate.

## References

- [Baseline design](baseline.md)
- [Graph memory](memory.md)
- [Clean-room rebuild guide](rebuild-guide.md)
- [Design document index](README.md)
