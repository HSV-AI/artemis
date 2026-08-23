# Graph memory

## Status

Implemented.

## Problem

Artemis needs durable facts that survive PI session clears and process restarts
without mixing data between Discord conversations. Users must remain in control
of what is remembered, corrected, or forgotten.

## Scope

This protocol owns the Dgraph schema, conversation scope, provenance, PI tools,
ranked retrieval, session snapshots, novelty control, startup validation,
retention semantics, and Compose service. It does not change Discord
authorization, SQLite chat history, persona selection, or model-provider
selection.

## Observable behavior

Every Artemis profile receives these tools:

| Tool | Behavior |
| --- | --- |
| `memory_remember` | Insert one novel current fact, optionally forcing a similar but nonduplicate fact. |
| `memory_search` | Rank current facts using full-text, optional semantic, session-graph, and recency channels. |
| `memory_recall` | List current facts in the conversation scope. |
| `memory_supersede` | End one active fact and insert its correction atomically. |
| `memory_forget` | Stop believing one active fact without deleting it. |
| `memory_believed_at` | List facts believed at an ISO-8601 instant. |
| `memory_audit` | List current and ended facts with supersession links. |
| `memory_entity` | List current facts linked to an entity in the conversation scope. |
| `memory_episode` | List facts recorded during the current PI session. |

Model-facing guidelines permit writes only when the current Discord user
explicitly asks to remember, correct, or forget something. Recall results are
marked as user data and must not be treated as instructions or authorization.

`memory_remember` checks active facts before writing. Token-set Jaccard thresholds
classify similarity at 0.6 and duplicates at 0.85. When embeddings are enabled,
cosine thresholds classify similarity at 0.88 and duplicates at 0.95. A duplicate
is always refused and names its existing UID. A similar fact is refused with a
supersession suggestion unless `force` is true. Refusals are ordinary tool output
so PI can respond or choose another explicit memory operation in the same turn.

When `MEMORY_INJECT=true`, Artemis renders at most 2,000 characters of current
facts into the system prompt on the first turn of each durable PI session. The
same resource loader and prompt bytes are reused for every later turn in that
session. The snapshot identifies itself as user data, remains unchanged after
writes, and directs PI to `memory_search` for newer or omitted facts. A new PI
session takes a new snapshot.

## Contracts and data flow

Artemis binds every operation to the triggering conversation key; the model
cannot supply or override it:

- Direct message: `dm:<channel-id>`.
- Guild channel: `guild:<guild-id>:channel:<channel-id>`.
- Guild thread: the parent guild channel's key.

Writes also bind the triggering Discord author ID and message ID. Memory survives
`/clear-session` because that command closes only the SQLite/PI session while the
stable Discord conversation key remains unchanged.

Every write links to an episode identified by the durable PI session ID. Optional
entity labels connect related facts. Episode traversal and entity reads remain
constrained to the active conversation scope.

All operations on one memory instance enter a serial queue in call-arrival order.
PI tool handlers construct their bound input synchronously and call the memory
operation before awaiting other work. Concurrent tool calls in one model turn
therefore observe earlier calls from that turn in issue order.

`memory_search` retrieves independent ordered candidate lists from Dgraph
full-text search, optional HNSW cosine search, one-hop entity traversal seeded by
the current episode, and the 20 newest active facts. Reciprocal rank fusion uses
`1 / (60 + rank + 1)` per channel, sorts by total score with UID as the stable
tie-breaker, and returns ten facts by default. Tool output includes channel names
and the fused score.

## Configuration

`DGRAPH_URL` is an HTTP(S) Dgraph Alpha endpoint and defaults to
`http://dgraph:8080`. Base Compose runs `dgraph/standalone:v25.4.0`, waits for
`/health`, and persists `/dgraph` in the `dgraph-data` volume. Artemis applies the
additive DQL schema after model health validation and before Discord login.

`MEMORY_EMBED_URL` is an optional OpenAI-compatible API base URL. A blank value,
the default, disables embeddings while retaining full-text, graph, and recency
retrieval plus token-overlap novelty checks. When configured, the client discovers
the first model from `/models`, calls `/embeddings`, and stores vectors in Dgraph.
Embedding calls run inside the serial operation queue. `MEMORY_INJECT` is a strict
boolean and defaults to `false`.

## Persistence

Dgraph stores `Fact` nodes containing the statement, optional embedding, optional
subject, scope, Discord provenance, valid time, system time, optional episode and
entity edges, optional end reason, and optional supersession edge. `Episode` nodes
are unique by session ID within a scope. `Entity` nodes use stable labels.
Correction and forgetting stamp ended facts rather than deleting them. Current
recall and ranked retrieval exclude ended facts; audit includes them. Every fact
read and write is constrained to one conversation scope.

## Security and privacy

Memory facts are user data and have no automatic expiration. Forgetting is a
logical tombstone, not physical erasure. Base Compose does not publish Dgraph to
a host port, and Artemis does not send credentials to Dgraph. Tool guidance
prohibits storing credentials or secrets. Entity tools and graph traversal do not
provide a cross-conversation read path.

## Failure handling

- Invalid `DGRAPH_URL` fails configuration loading.
- Invalid nonblank `MEMORY_EMBED_URL` or invalid `MEMORY_INJECT` fails configuration loading.
- Schema initialization failure prevents Discord login.
- Invalid, inactive, or cross-scope fact UIDs fail without changing data.
- Duplicate and unforced similar writes return a refusal without changing data.
- Embedding discovery or generation failures fail the invoking memory operation; there is no silent semantic fallback when an embedding endpoint is configured.
- Query and mutation failures follow the normal generation-failure path and
  produce no Discord reply.

## Verification

- `test/dgraph-memory.test.ts` covers schema, reads, writes, tombstones, scope,
  episodes, entities, operation ordering, novelty, ranking, and failure handling.
- `test/embedding-client.test.ts` covers model discovery, embedding requests, cosine similarity, and failures.
- `test/memory-tools.test.ts` covers ranked and lifecycle tools, refusal output, and bound provenance.
- `test/conversation-service.test.ts` covers immutable Discord identity.
- `test/pi-gateway.test.ts` covers registration, startup initialization, bounded snapshots, and session prompt stability.
- `npm run guardrail` is the completion gate.

## References

- [Baseline design](baseline.md)
- [Clean-room rebuild guide](rebuild-guide.md)
- [Design document index](README.md)
