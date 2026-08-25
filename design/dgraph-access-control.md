# Dgraph access control and namespaces

## Status

Implemented.

## Problem

Conversation memory is private while the HSVAI corpus is public. Authenticated
Dgraph must prevent model-authored public DQL from reaching private memories.

## Scope

This protocol owns Dgraph ACL, namespaces, service accounts, JWTs, startup order,
and migration from shared to isolated data. It does not change Discord
authorization, conversation scopes, ingestion semantics, or SQLite.

## Observable behavior

Startup requires authenticated Dgraph and exposes arbitrary read-only HSVAI DQL
alongside existing memory and graph search. Authentication or bootstrap failure
prevents Discord login; there is no unauthenticated fallback.

## Contracts and data flow

### Topology and trust boundaries

One `dgraph/standalone:v25.4.0` service stores two logically isolated databases:

| Namespace | Data | Runtime account | Permission |
| --- | --- | --- | --- |
| `0` | Conversation memory | `DGRAPH_USER` | `dgraph.all=7` |
| `HSVAI_DGRAPH_NAMESPACE` | Public HSVAI corpus | `HSVAI_DGRAPH_SYNC_USER` | `dgraph.all=7` |
| `HSVAI_DGRAPH_NAMESPACE` | Public HSVAI corpus | `HSVAI_DGRAPH_QUERY_USER` | `dgraph.all=4` |

ACL uses a 32-byte local secret mounted at `/run/secrets/dgraph-acl`. Signed JWTs
bind namespace identity, so Dgraph rejects cross-namespace reads before evaluating
DQL. Only the one-shot bootstrap receives galaxy and namespace guardian passwords.

## Bootstrap contract

`dgraph-bootstrap` runs after Dgraph is healthy and before Artemis starts. It:

1. Logs into namespace `0` and rotates the initial `groot/password` on first startup.
2. Idempotently creates the memory service user and group with permission `7`.
3. Creates the configured HSVAI namespace when absent and rejects an allocated ID
   that differs from `HSVAI_DGRAPH_NAMESPACE`.
4. Idempotently creates separate HSVAI sync and query accounts with permissions
   `7` and `4`.
5. Verifies every service credential by logging in to its intended namespace.

Subsequent starts reuse the namespace, reset service passwords to configured
values, and use the galaxy guardian to reset a mismatched namespace guardian.

## Client contract

Each `DgraphClient` logs in through `/admin`, caches its JWT until 30 seconds
before expiry, and shares concurrent login work. A `401` clears the token and
retries once. Requests carry `X-Dgraph-AccessToken`; credentials are never logged.

Queries use `/query?ro=true`; alter, mutation, and upsert use dedicated methods.
`HsvaiKnowledge` separates its sync client from its retrieval and DQL query client.

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

Both namespaces share the `dgraph-data` volume and Raft group, but their schemas,
UIDs, ACL users, and data are local. Secrets remain outside the volume and
repository; changing the signing secret invalidates JWTs without moving data.

## Migration

Enabling ACL leaves existing data in namespace `0`. HSVAI startup fills the new
empty namespace. Operators verify its document, chunk, entity, and revision
counts before deleting legacy `hsvai.node_kind` nodes from namespace `0`; memory
nodes are never moved.

## Security and privacy

The model receives no credentials. Its DQL tool uses only `/query?ro=true` with a
permission-4 public-namespace account. Application code owns memory and sync
credentials; tools cannot accept them. Base Compose publishes no Dgraph host port.

## Failure handling

- Missing credentials or invalid namespace IDs fail configuration loading.
- ACL login, namespace allocation, account setup, or permission failures prevent
  Artemis startup.
- The query account cannot alter schema or mutate data even if model output
  reaches another Dgraph endpoint accidentally.
- Dgraph remains unexposed to host ports in base Compose.

## Verification

- Bootstrap password rotation, idempotency, namespace creation, and permissions
  require a Compose smoke check; the executable is excluded from unit coverage.
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
