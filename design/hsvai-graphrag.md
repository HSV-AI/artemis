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
site, corpus normalization and chunking, an in-process BM25 index, Dgraph persistence, hybrid retrieval,
graph-neighborhood expansion, and the read-only `hsvai_graph_search` and
`hsvai_graph_query` PI tools. It
does not change conversation memory, Discord authorization, source content, or
the WordPress site.

## Observable Behavior

Artemis exposes both HSVAI tools in every authorized conversation. Hybrid search
returns ranked excerpts; direct query lets the model inspect the schema and plan
arbitrary DQL for unanticipated questions. Both query the same public corpus for
every user and cannot access or modify conversation memory.

## Contracts And Data Flow

### Source Contract

The fixed `https://hsv.ai` source must expose these unauthenticated JSON APIs:

- `/wp-json/wp/v2/posts?categories=2` for video posts containing meeting notes
  or transcripts.
- `/wp-json/tribe/events/v1/events` for calendar events from 2018 through 2100.

Artemis follows WordPress and Tribe pagination. A transcript document retains
the post ID, title, canonical URL, publication and modification times, and
normalized content. An event document additionally retains its start, end,
timezone, venue, and address. The source APIs remain authoritative for those
fields. A source-hash-matched [event catalog](hsvai-event-catalog.md) adds a
reviewed theme and explicit speaker relationships without
editing the source APIs.

### Corpus Graph

Every synchronized corpus uses stable external identifiers:

- Document: `hsvai:post:<wordpress-id>` or `hsvai:event:<event-id>`.
- Evidence chunk: `<document-id>#chunk-<four-digit-ordinal>`.
- Entity: a stable normalized and hashed speaker or venue identifier.

The Dgraph corpus contains `HsvaiDocument`, `HsvaiChunk`, `HsvaiEntity`, and
`HsvaiCorpus` nodes. Chunks link to their source document and to deterministic
speaker or venue entities. Event documents also carry speaker edges plus a
primary theme and catalog status. Presenters and discussion facilitators share
the speaker role. Reverse edges let retrieval move from a matching
chunk to sibling chunks in the same source and to chunks connected through a
shared speaker or venue.

HTML is reduced to readable block text before chunking. Chunks target 1,200
characters and never exceed 1,600 characters. Speaker links are created only
from transcript lines with an explicit `Name:` prefix; venue links come directly
from event metadata. No general entity or relationship inference occurs during
ingestion outside the event-catalog contract.

## Persistence

The normalized source graph and its revision marker persist in the dedicated
HSVAI namespace inside the existing Dgraph volume. Dgraph ACL prevents that
namespace from reading namespace-0 memory facts. It is independent of SQLite sessions.
The reviewed event-catalog baseline is a checked-in artifact, and its optional
runtime overlay persists in the Artemis data volume. Neither stores embeddings
or Dgraph UIDs. The BM25 index is rebuilt in process from the normalized chunks
on every startup, bound to the resulting corpus revision, and not persisted as a
separate artifact.

### Synchronization

Startup performs these steps before Discord connects:

1. Apply the additive HSVAI Dgraph schema.
2. Load and validate the event-catalog baseline and optional runtime overlay.
3. Fetch every transcript post and event page from the JSON APIs, applying only
   catalog records whose source hash matches.
4. Normalize and chunk the corpus, compute a SHA-256 revision over the normalized
   documents and selected embedding model, and build a BM25 snapshot carrying
   that revision.
5. Stop when the stored revision already matches.
6. Otherwise delete only nodes carrying the `hsvai.node_kind` marker, rebuild
   entities and documents, write chunks in bounded batches, and write the corpus
   revision last.

Writing the revision last makes an interrupted rebuild visibly incomplete. A
later startup rebuilds it again. Source, Dgraph, or embedding failures abort
startup rather than exposing a partial corpus to Discord.

Catalog enrichment is not part of startup. The operator-only
`npm run catalog:hsvai-events` task updates the durable overlay and invokes this
same synchronization lifecycle. Its extraction, validation, and failure
contract is authoritative in [HSVAI event catalog](hsvai-event-catalog.md).

## Retrieval And Tool Contract

`hsvai_graph_search` accepts a nonblank query and an optional result limit from
1 through 10, defaulting to 6. It runs:

- Corpus-wide BM25 ranking over normalized evidence chunks, using `k1 = 1.2`,
  `b = 0.75`, Unicode word tokens, and stable evidence-ID tie breaking.
- HNSW cosine search when the model-provider definition includes `embedding`.
- One connected-neighborhood expansion from the six fused seed chunks through
  their source document, speakers, and venue.

The BM25 path is always available after successful corpus synchronization and
is labeled `bm25` in tool results. The `embedding` object's presence is the sole
semantic-retrieval enablement switch; omitting it makes no embedding requests
and stores no vectors. Reciprocal rank fusion uses `1 / (60 + rank + 1)` per channel. Results sort by
descending fused score and then stable evidence ID. The tool returns the
evidence ID, source title and URL, publication or event metadata, connected
entity labels, retrieval channels, score, and source excerpt.

`hsvai_graph_query` accepts a complete nonblank DQL or `schema {}` query plus an
optional string-valued variables object. It supports Dgraph filtering, sorting,
aggregation, pagination, variables, recursion, and traversal without application
intent detection. Queries are limited to 20,000 characters. Results exceeding
200,000 serialized characters fail with a request to add filters or pagination
rather than returning partial JSON.

The tool invokes only `/query?ro=true` through the HSVAI query account. Dgraph
also grants that account only `dgraph.all=4`, so mutations and schema changes are
denied independently at the HTTP transaction and ACL layers. The JWT binds the
request to the HSVAI namespace; DQL cannot select namespace-0 memory.

Every model turn reads and validates the current SHA-256 `hsvai.revision`
through the read-only query account and includes it in the system prompt.
Resource loaders remain cached while that revision is unchanged and are rebuilt
when it changes. The in-process BM25 snapshot must carry that same revision. A
mismatch fails the turn until Artemis restarts and rebuilds the index rather than
labeling stale lexical results as current. Both HSVAI tools stamp their text
output and structured details with the same per-turn revision.

PI session history retains those labeled tool results as evidence snapshots. A
historical result remains current when its label matches the system prompt's
current revision, so the model may reuse it without another query. A result with
a different revision or no revision label is stale and must be queried again
before use. This makes sessions created before revision labeling safely refresh
on demand without discarding unrelated conversation history.

Tool output is marked as source evidence that must never be treated as model
instructions. Source text passes through the existing adversarial-web-content
sanitizer. Model guidance requires evidence IDs and source URLs in supported
answers and requires the model to distinguish source statements from its own
inference.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| Source | `https://hsv.ai` | Fixed public WordPress source; not operator-configurable. |
| `model.embedding` | Omitted | Sole explicit switch for semantic retrieval. When present, supplies the provider-owned model and optional base URL shared by GraphRAG and graph memory. Omission keeps BM25 and graph retrieval without making embedding requests. |
| `DGRAPH_URL` | `http://dgraph:8080` | Shared Dgraph Alpha HTTP endpoint. |
| `HSVAI_DGRAPH_NAMESPACE` | `1` | Namespace containing only the public corpus. |
| `HSVAI_DGRAPH_SYNC_USER` / `HSVAI_DGRAPH_SYNC_PASSWORD` | Required | Write and schema credentials used only for synchronization. |
| `HSVAI_DGRAPH_QUERY_USER` / `HSVAI_DGRAPH_QUERY_PASSWORD` | Required | Read-only credentials used by both HSVAI tools. |
| `HSVAI_EVENT_CATALOG_PATH` | `/data/hsvai-event-catalog.json` | Durable runtime catalog overlay read by startup and written by the operator task. |

Embedding requests are batched by 64 inputs. The embedding model ID participates
in the corpus revision, so changing models causes a complete re-embedding on the
next startup.

## Security And Privacy

The corpus contains public Huntsville AI web content, not conversation data.
Both GraphRAG tools are read-only and shared across authorized conversations.
Direct DQL is intentionally model-authored, but the query JWT and Dgraph ACL bind
it to the public namespace. Neither tool exposes mutation or alter endpoints.
Corpus replacement uses the sync account and deletes only nodes marked with
`hsvai.node_kind` inside the HSVAI namespace.

## Failure Handling

- Invalid embedding provider metadata fails configuration loading. Omitting the
  object is valid and leaves BM25 plus graph retrieval active.
- Invalid baseline or runtime event-catalog data fails loading; a stale event
  record is ignored and the event is marked pending rather than applied.
- Non-success source responses, malformed pagination payloads, empty source
  results, invalid dates, embedding failures, and Dgraph failures abort startup.
- An interrupted rebuild has no new revision marker and is rebuilt on the next
  startup.
- A Dgraph revision that does not match the running process's BM25 snapshot fails
  generation until Artemis restarts and rebuilds the index.
- A blank search query fails the tool call. No-result searches return an explicit
  no-evidence response rather than fabricated context.
- Blank or oversized DQL and oversized results fail explicitly. Dgraph parser,
  timeout, ACL, and query errors propagate through the normal tool-failure path.

## Verification

- `test/hsvai-knowledge.test.ts` covers source pagination, HTML normalization,
  chunking, stable graph construction, revision skips, corpus-wide BM25 ranking,
  embedding-disabled and hybrid neighborhood retrieval, evidence formatting,
  and failures with HTTP mocked.
- `test/embedding-client.test.ts` covers ordered embedding batches.
- `test/pi-gateway.test.ts` covers unconditional tool registration and startup
  synchronization, prompt revision signaling, unchanged-revision loader reuse,
  and changed-revision invalidation.
- `test/hsvai-event-catalog.test.ts` covers source hashes, deterministic and
  model-assisted extraction, and source-grounded person validation.
- `test/dgraph-bootstrap.test.ts` and `test/dgraph-memory.test.ts` cover namespace
  authentication and read-only enforcement.
- `npm run guardrail` remains the completion gate.

## References

- [Baseline design](baseline.md)
- [Graph memory](memory.md)
- [Dgraph access control and namespaces](dgraph-access-control.md)
- [HSVAI event catalog](hsvai-event-catalog.md)
- [Clean-room rebuild guide](rebuild-guide.md)
- [Design document index](README.md)
