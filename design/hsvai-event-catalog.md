# HSVAI Event Catalog

## Status

Implemented.

## Problem

The HSVAI event API has prose but no stable theme or speaker list. Inferring
those properties per conversation is inconsistent and not traversable with DQL.

## Scope

The catalog owns one source-grounded theme, named presenters and facilitators as
speakers, its checked-in records, and source invalidation. WordPress remains
authoritative for event identity, title, URL, dates, venue, and source text.

## Observable Behavior

Graph retrieval and DQL expose source-matched themes and speakers. Changed events
remain queryable as pending without stale enrichment.

## Contracts And Data Flow

### Catalog Format

`data/hsvai-event-catalog.jsonl` is the reviewed catalog shipped in the
application image.

Each JSONL record contains source identity, modification time, SHA-256 source
hash, one `research`, `building`, or `community` theme, and speakers. People
retain a canonical graph name and source evidence; reviewed corrections use
`provenance: operator` and need no placeholder evidence.

Only current hashes apply. Missing or stale records project `pending` without
theme or people; matches project `complete`, `hsvai.theme`, and
`hsvai.speakers`. A reviewed speakerless event is complete with an empty array
and creates no person entity.

## Maintenance

Catalog changes are ordinary reviewed Git changes. Maintainers update records
when source events change and verify that names and evidence remain grounded in
the current public event text.

## Dgraph Projection

Event documents index `hsvai.theme` and `hsvai.people_status`; `hsvai.speakers`
links the stable person entities mentioned by event chunks. Graph expansion and
DQL can therefore connect events and transcripts without parsing prose.

## Configuration

The catalog path is fixed at `data/hsvai-event-catalog.jsonl`; there is no
runtime catalog or model-extraction setting.

## Persistence

The catalog is immutable image content. Dgraph is its queryable,
source-canonicalized projection.

## Failure Handling

- A missing or invalid checked-in baseline fails Artemis construction.
- Source changes invalidate only the affected catalog record and expose that
  event as pending until the checked-in catalog is updated.

## Security And Privacy

The catalog contains public evidence, not Discord data. Names must occur in
source. Only the authenticated HSVAI sync account mutates the public namespace.

## Verification

- `test/hsvai-event-catalog.test.ts` covers loading, hashes, invalidation, and
  malformed records.
- `test/hsvai-knowledge.test.ts` covers complete and pending graph projection.
- `test/pi-gateway.test.ts` covers baseline loading during gateway construction.
- `npm run guardrail` remains the completion gate.

## References

- [HSVAI GraphRAG](hsvai-graphrag.md)
- [Configurable model provider](model-provider.md)
- [Dgraph access control and namespaces](dgraph-access-control.md)
- [Clean-room rebuild guide](rebuild-guide.md)
