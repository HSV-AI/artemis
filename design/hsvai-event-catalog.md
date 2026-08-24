# HSVAI Event Catalog

## Status

Implemented.

## Problem

The HSVAI event API has prose but no stable theme or speaker list. Inferring
those properties per conversation is inconsistent and not traversable with DQL.

## Scope

The catalog owns one source-grounded theme, named presenters and facilitators as
speakers, its checked-in seed, runtime overlay, invalidation, model extraction,
and refresh command. WordPress remains authoritative for event identity, title,
URL, dates, venue, and source text.

## Observable Behavior

Hybrid retrieval and DQL expose source-matched themes and speakers. Changed events
remain queryable as pending without stale enrichment. Only the explicit
`npm run catalog:hsvai-events` operator task calls the model.

## Contracts And Data Flow

### Catalog Format

`data/hsvai-event-catalog.jsonl` is the reviewed bootstrap catalog shipped in the
application image. `/data/hsvai-event-catalog.jsonl` is the writable runtime
overlay on the existing Artemis data volume. `HSVAI_EVENT_CATALOG_PATH` may
select a different overlay path.

Each JSONL record contains source identity, modification time, SHA-256 source
hash, one `research`, `building`, or `community` theme, and speakers. Legacy
version-1 `facilitators` load as speakers but are not written. People retain a
canonical graph name and source evidence; reviewed corrections use
`provenance: operator` and need no placeholder evidence.

Runtime records add or replace events by source ID and hash; an equal-hash
reviewed baseline wins over generated data. Only current hashes apply. Missing or
stale records project `pending` without theme or people; matches project `complete`,
`hsvai.theme`, and `hsvai.speakers`. A reviewed speakerless event is complete with
an empty array and creates no person entity.

## Extraction And Refresh

Catalog refresh is an explicit operator task, never startup work, request work,
or a background schedule. Run `npm run catalog:hsvai-events` in the configured
Artemis environment. The task:

1. Fetches and normalizes all current HSVAI events.
2. Retains entries whose source hash still matches.
3. Applies deterministic theme and person patterns to changed events.
4. Sends ambiguous records to the configured model.
5. Rejects incomplete, duplicate, malformed, unexpected, or source-unsupported
   output; names must occur verbatim and evidence is copied from source text.
6. Atomically replaces the runtime overlay.
7. Runs the normal HSVAI synchronization so Dgraph receives the reviewed result.

The prompt treats records as untrusted, permits only the three themes, excludes
authors, attendees, and mentions, and does not resolve first-person references.
The task uses Artemis's provider configuration without an Ollama-specific path.

Operators choose the cadence, stop Artemis before the task, and restart after
success so queries cannot observe replacement and BM25 is rebuilt before service.

The task updates the overlay by default. After `npm run build`, maintainers may
target `data/hsvai-event-catalog.jsonl` to regenerate the checked-in baseline;
generated changes require review before commit.

## Dgraph Projection

Event documents index `hsvai.theme` and `hsvai.people_status`; `hsvai.speakers`
links the stable person entities mentioned by event chunks. Graph expansion and
DQL can therefore connect events and transcripts without parsing prose. Startup
drops the retired `hsvai.facilitators` predicate before synchronization.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `HSVAI_EVENT_CATALOG_PATH` | `/data/hsvai-event-catalog.jsonl` | Writable runtime overlay loaded after the checked-in baseline. |
| Configured model provider | Existing Artemis model configuration | OpenAI-compatible endpoint, model, credentials, and optional embeddings used by the operator task. |

## Persistence

The baseline is immutable image content. The data-volume overlay uses temporary
file plus atomic rename. Dgraph is the queryable, source-canonicalized projection.

## Failure Handling

- A missing or invalid checked-in baseline fails Artemis construction.
- An existing invalid runtime overlay fails instead of silently falling back to
  the baseline.
- Source changes invalidate only the affected catalog record and expose that
  event as pending until an operator refresh succeeds.
- Source, model, catalog-write, embedding, or Dgraph failures fail the operator
  task. No partial overlay rename occurs.
- The overlay is written before Dgraph synchronization. If synchronization
  fails, the valid overlay remains available for the next startup or task retry.

## Security And Privacy

The catalog contains public evidence, not Discord data. It never persists model
credentials; records are untrusted model input and names must occur in source.
Only the authenticated HSVAI sync account mutates the public namespace.

## Verification

- `test/hsvai-event-catalog.test.ts` covers extraction, hashes, changed events,
  model requests, source canonicalization, and unsupported names.
- `test/hsvai-knowledge.test.ts` covers complete and pending graph projection.
- `test/pi-gateway.test.ts` covers baseline loading during gateway construction.
- `npm run guardrail` remains the completion gate.

## References

- [HSVAI GraphRAG](hsvai-graphrag.md)
- [Configurable model provider](model-provider.md)
- [Dgraph access control and namespaces](dgraph-access-control.md)
- [Clean-room rebuild guide](rebuild-guide.md)
