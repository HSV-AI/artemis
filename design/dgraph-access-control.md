# Dgraph access control and namespaces

## Status

Implemented.

## Problem

Conversation memory is private user data while the HSVAI corpus is public shared
evidence. Arbitrary model-authored DQL must not create a path from the public
query tool into private memories, and application credentials must not rely on
an unauthenticated database.

## Scope

This protocol owns Dgraph ACL activation, namespace allocation, service-account
permissions, JWT authentication, startup ordering, and the migration boundary
between legacy shared data and isolated public data. It does not change Discord
authorization, conversation scope keys, source ingestion semantics, or SQLite.

## Observable behavior

Artemis still exposes the same memory and hybrid-search behavior, but startup now
requires authenticated Dgraph. It additionally exposes arbitrary read-only HSVAI
DQL. Authentication or bootstrap failure prevents Discord login rather than
falling back to an unauthenticated or shared graph.

## Contracts and data flow

### Topology and trust boundaries

One `dgraph/standalone:v25.4.0` service stores two logically isolated databases:

| Namespace | Data | Runtime account | Permission |
| --- | --- | --- | --- |
| `0` | Conversation memory | `DGRAPH_USER` | `dgraph.all=7` |
| `HSVAI_DGRAPH_NAMESPACE` | Public HSVAI corpus | `HSVAI_DGRAPH_SYNC_USER` | `dgraph.all=7` |
| `HSVAI_DGRAPH_NAMESPACE` | Public HSVAI corpus | `HSVAI_DGRAPH_QUERY_USER` | `dgraph.all=4` |

ACL is enabled with a 32-byte local secret mounted at
`/run/secrets/dgraph-acl`. Namespace identity comes from Dgraph's signed access
JWT, not from a query argument. Dgraph therefore rejects cross-namespace reads
before evaluating DQL. The galaxy and namespace `groot` credentials are used by
the one-shot bootstrap service. Compose explicitly removes those guardian
passwords from the Artemis container environment.

## Bootstrap contract

`dgraph-bootstrap` runs after Dgraph is healthy and before Artemis starts. It:

1. Logs into namespace `0`, rotating the initial `groot/password` credential on
   first startup.
2. Idempotently creates the memory service user and group with permission `7`.
3. Creates the configured HSVAI namespace when absent. The allocated ID must
   equal `HSVAI_DGRAPH_NAMESPACE`; a mismatch fails instead of silently binding
   credentials to the wrong tenant.
4. Idempotently creates separate HSVAI synchronization and query accounts with
   permissions `7` and `4` respectively.
5. Verifies every service credential by logging in to its intended namespace.

Subsequent starts reuse the namespace and reset service-account passwords to the
configured values. If the namespace guardian password no longer matches, the
galaxy guardian resets it explicitly.

## Client contract

Each `DgraphClient` logs in through `/admin`, caches the returned access JWT until
30 seconds before expiry, and shares an in-flight login across concurrent calls.
A `401` clears the token, logs in again, and retries exactly once. Requests carry
`X-Dgraph-AccessToken`; passwords and JWTs are never logged.

All query calls use `/query?ro=true`. Schema alteration, mutation, and upsert use
only their dedicated methods. `HsvaiKnowledge` uses the sync client for schema
and corpus replacement and the read-only query client for hybrid retrieval and
model-authored DQL.

## Configuration

The following secrets are required in `.env` or an operator secret mechanism:

- `DGRAPH_GROOT_PASSWORD`, `DGRAPH_USER`, and `DGRAPH_PASSWORD` for namespace 0.
- `HSVAI_DGRAPH_GROOT_PASSWORD` for namespace administration.
- `HSVAI_DGRAPH_SYNC_USER` and `HSVAI_DGRAPH_SYNC_PASSWORD` for ingestion.
- `HSVAI_DGRAPH_QUERY_USER` and `HSVAI_DGRAPH_QUERY_PASSWORD` for reads.

Memory uses namespace `0`; `HSVAI_DGRAPH_NAMESPACE` defaults to `1`.
`DGRAPH_INITIAL_GROOT_PASSWORD` defaults to Dgraph's first-start value
`password` and is used only when the configured galaxy password cannot log in.
The ACL signing secret is the ignored local file `dgraph-acl-secret`.

## Persistence

Both namespaces share the existing `dgraph-data` volume and Dgraph Raft group,
but predicates, types, UIDs, ACL users, and data are namespace-local. The ACL
signing secret and account passwords live outside the volume and repository.
Changing the signing secret invalidates outstanding JWTs without moving data.

## Migration

An existing unauthenticated deployment retains all data in namespace `0` when
ACL is enabled. The new namespace starts empty, so normal HSVAI startup performs
a complete source synchronization there. Operators must verify document, chunk,
entity, and revision counts in the HSVAI namespace before deleting legacy nodes
marked by `hsvai.node_kind` from namespace `0`. Memory nodes are never moved.

## Security and privacy

The model receives neither credentials nor JWTs. It can submit DQL only through
the query tool, whose client is authenticated to the public namespace as a
permission-4 account and whose HTTP path is always `/query?ro=true`. The memory
and sync credentials are held by application-owned code paths and are never
accepted as tool parameters. Base Compose publishes no Dgraph host port.

## Failure handling

- Missing credentials or invalid namespace IDs fail configuration loading.
- ACL login, namespace allocation, account setup, or permission failures prevent
  Artemis startup.
- The query account cannot alter schema or mutate data even if model output
  reaches another Dgraph endpoint accidentally.
- Dgraph remains unexposed to host ports in base Compose.

## Verification

- `test/dgraph-bootstrap.test.ts` covers password rotation, idempotent account
  setup, namespace creation and reuse, permission assignment, and ID mismatch.
- `test/dgraph-memory.test.ts` covers JWT caching, authenticated headers,
  read-only query routing, and one-time `401` retry.
- `test/hsvai-knowledge.test.ts` verifies the query client remains separate from
  the synchronization client.
- `npm run guardrail` remains the completion gate.

## References

- [Graph memory](memory.md)
- [HSVAI GraphRAG](hsvai-graphrag.md)
- [Baseline design](baseline.md)
- [Clean-room rebuild guide](rebuild-guide.md)
