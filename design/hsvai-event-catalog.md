# HSVAI Event Catalog

## Status

Implemented.

## Problem

The public HSVAI event API provides event prose but does not expose a stable,
structured theme or speaker list. Inferring those properties
during each conversation is slow, inconsistent, and difficult to traverse with
DQL.

## Scope

The event catalog owns source-grounded extraction of one primary theme and
explicitly named presenters or discussion facilitators for HSVAI calendar events. Both
are represented as speakers. It owns the
checked-in seed, durable runtime overlay, source-change detection, configured
model extraction protocol, and operator refresh command. The WordPress APIs
remain authoritative for event identity, title, URL, dates, venue, and source
text.

## Observable Behavior

Artemis exposes catalog-matched event themes and speakers through
hybrid retrieval and direct DQL. Events whose source has changed remain
queryable, but their catalog status is pending and stale enrichment is omitted.
Normal startup performs no event-enrichment model calls. Operators explicitly
refresh changed events with `npm run catalog:hsvai-events`.

## Contracts And Data Flow

### Catalog Format

`data/hsvai-event-catalog.json` is the reviewed bootstrap catalog shipped in the
application image. `/data/hsvai-event-catalog.json` is the writable runtime
overlay on the existing Artemis data volume. `HSVAI_EVENT_CATALOG_PATH` may
select a different overlay path.

Both files contain version `1` and one record per event. Each record retains the
source ID, title, URL, modification time, SHA-256 source hash, one theme, and a
speaker array. Themes are exactly `research`, `building`, or `community`.
Discussion facilitators use the same speaker representation. Legacy version-1
`facilitators` arrays remain readable and are merged into speakers when loaded,
but new catalog output does not write them. Each person includes their canonical
graph name. Model and deterministic entries also retain source evidence.
Reviewed corrections use `provenance: operator` and do not require placeholder
evidence text when the event page omits the presenter.

Runtime records add new events and replace stale baseline records when their
source hash differs. A reviewed baseline record wins over generated runtime data
for the same source ID and hash, so operator corrections are not hidden by an
older overlay. A record is applied only when its source hash matches the current
normalized event. New or changed events without a matching record are synchronized with
`hsvai.people_status = pending`, no people edges, and no theme. Matching records
use `complete` and populate `hsvai.theme` and `hsvai.speakers`. Reviewed events
with no designated speaker use `complete` with an empty speaker array, so absence
does not create a shared person entity or graph relationship.

## Extraction And Refresh

Catalog refresh is an explicit operator task, never startup work, request work,
or a background schedule. Run `npm run catalog:hsvai-events` in the configured
Artemis environment. The task:

1. Fetches and normalizes all current HSVAI events.
2. Retains entries whose source hash still matches.
3. Applies deterministic theme and explicit-person patterns to new or changed
   events.
4. Sends the pending source records to the deployment's configured
   OpenAI-compatible model for ambiguous classification and people extraction.
5. Rejects missing, duplicate, unexpected, malformed, or source-unsupported
   model output. Every model-produced name must occur verbatim in that event's
   source text; evidence is copied from the source rather than accepted from the
   model.
6. Atomically replaces the runtime overlay.
7. Runs the normal HSVAI synchronization so Dgraph receives the reviewed result.

The model prompt treats event records as untrusted data, permits only the three
themes, excludes paper authors, attendees, and merely mentioned people, and
forbids resolving first-person references. The task uses the same provider,
model, API key, and optional embedding configuration as Artemis. It has no
Ollama-specific alternate path.

Operators choose the cadence outside the application. Stop the serving Artemis
process before running the task, then restart it after synchronization succeeds.
This prevents interactive queries from observing the multi-mutation corpus
replacement and rebuilds the process-local BM25 snapshot before service resumes.

By default the task updates the durable overlay. A maintainer working from source
may run `npm run build` first, then
`npm run catalog:hsvai-events -- data/hsvai-event-catalog.json` to regenerate the
checked-in baseline through the same configured model without changing code.
That generated baseline must be reviewed before commit.

## Dgraph Projection

Event documents store indexed `hsvai.theme` and `hsvai.people_status`
predicates. `hsvai.speakers` is a first-class UID edge
to the same stable person entities used by graph retrieval. Event chunks mention
those entities so hybrid neighborhood expansion can connect events and
transcripts through a person. Direct DQL can traverse the event edge without
parsing source prose. The former `hsvai.facilitators` edge is no
longer written. Startup drops that retired predicate before synchronizing so
schema metadata and orphaned UID edges from earlier versions do not survive.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `HSVAI_EVENT_CATALOG_PATH` | `/data/hsvai-event-catalog.json` | Writable runtime overlay loaded after the checked-in baseline. |
| Configured model provider | Existing Artemis model configuration | OpenAI-compatible endpoint, model, credentials, and optional embeddings used by the operator task. |

## Persistence

The baseline is immutable image content. The runtime overlay persists on the
existing Artemis data volume and is replaced through a temporary file plus an
atomic rename. Dgraph remains the queryable projection and contains no catalog
credentials or model output that was not canonicalized against source text.

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

The catalog contains public event metadata and source evidence, not Discord
conversation data. Model credentials come from normal runtime configuration and
are never persisted in the catalog. Source records are untrusted model input,
and model names are constrained to verbatim source text. Only the authenticated
HSVAI sync account mutates the public Dgraph namespace.

## Verification

- `test/hsvai-event-catalog.test.ts` uses synthetic events to cover deterministic
  extraction, source hashes, changed-event selection, configured model requests,
  source canonicalization, and unsupported names.
- `test/hsvai-knowledge.test.ts` uses synthetic people and venues to cover
  complete and pending projection plus Dgraph role edges.
- `test/pi-gateway.test.ts` covers baseline loading during gateway construction.
- `npm run guardrail` remains the completion gate.

## References

- [HSVAI GraphRAG](hsvai-graphrag.md)
- [Configurable model provider](model-provider.md)
- [Dgraph access control and namespaces](dgraph-access-control.md)
- [Clean-room rebuild guide](rebuild-guide.md)
