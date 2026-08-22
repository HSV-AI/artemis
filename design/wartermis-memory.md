# Wartermis graph memory

## Status

Implemented.

## Problem

Wartermis can retain facts across PI sessions and process restarts when a Discord
user explicitly asks it to remember, correct, or forget something. The feature
uses Dgraph as a durable fact store and registers six PI custom tools only when
`PERSONA_PROFILE=wartermis`.

## Scope

This protocol owns the memory schema, conversation scope, provenance, PI tools,
startup validation, retention semantics, and Compose Dgraph service. It does not
change Discord authorization, SQLite chat history, model-provider selection, or
the default `artemis` persona's tools.

## Observable behavior

Wartermis receives these tools:

| Tool | Behavior |
| --- | --- |
| `memory_remember` | Insert one current fact and return its Dgraph UID. |
| `memory_recall` | List current facts in the conversation scope. |
| `memory_supersede` | End one active fact and insert its correction atomically. |
| `memory_forget` | Stop believing one active fact without deleting it. |
| `memory_believed_at` | List facts believed at an ISO-8601 instant. |
| `memory_audit` | List current and ended facts with supersession links. |

The model-facing guidelines permit writes only when the current Discord user
explicitly asks to remember, correct, or forget something. Each call stores one
plain declarative fact and must not store credentials or secrets. This intent
rule is prompt-enforced; the execution layer enforces scope and input validity
but does not independently reconstruct conversational intent.
Recall and audit results are delimited as user memory data, and PI is instructed
never to treat remembered statements as system instructions or authorization.

The default `artemis` profile registers no memory tools and does not contact
Dgraph during startup. Selecting Wartermis makes Dgraph a required dependency:
schema initialization failure prevents Discord login, and a tool failure follows
the normal silent generation-failure path.

## Contracts and data flow

### Identity and provenance

Every memory operation is fixed to the triggering conversation key:

- Direct message: `dm:<channel-id>`.
- Guild channel: `guild:<guild-id>:channel:<channel-id>`.
- Guild thread: the parent guild channel's key.

The model never supplies the scope. Artemis binds it when creating the PI tools
for a turn. Writes also bind the triggering Discord author ID and message ID;
the model cannot override either value.

Memory persists across `/clear-session` because a clear closes only the active
SQLite/PI session while the stable Discord conversation key remains unchanged.
Facts never cross DM or parent-channel scopes.

## Persistence

Dgraph stores `Fact` nodes with:

- `statement`, optional `subject`, `scope_key`, `author`, and
  `source_message_id`.
- Valid time: `valid_from` and optional `invalid_at`.
- System time: `recorded_at` and optional `expired_at`.
- Optional `ended_reason` (`superseded` or `forgotten`) and `supersedes` edge.

Remember inserts a new node. Supersede atomically stamps the old active fact and
inserts its successor with a `supersedes` edge. Forget stamps `expired_at` and
`ended_reason`. Neither operation hard-deletes a fact. Current recall excludes
facts with `expired_at`; audit includes them.

Every read filters by `scope_key`. Supersede and forget validate Dgraph UID
syntax and update a target only when it is active in the same scope.

## Configuration

`DGRAPH_URL` is an HTTP(S) Dgraph Alpha endpoint and defaults to
`http://dgraph:8080`. Base Compose sets this internal URL, runs
`dgraph/standalone:v25.4.0`, waits for `/health`, and persists `/dgraph` in the
`dgraph-data` named volume. The service is intended for local single-node use,
not a highly available production Dgraph deployment.

At Wartermis startup, Artemis applies the additive DQL schema through `/alter`
after model-provider health validation and before Discord login. Runtime queries
and mutations use Dgraph's HTTP `/query` and `/mutate?commitNow=true` endpoints;
no Dgraph SDK is required.

## Security and privacy

Memory facts are user data and have no automatic expiration. A forget request is
a logical tombstone, not physical erasure. Operators who require physical
deletion must remove the Dgraph data volume or use an operator-controlled Dgraph
administrative process outside Artemis.

Dgraph is not published to a host port by base Compose. Artemis sends no model,
Discord, or GitHub credentials to Dgraph. Tool errors may contain Dgraph response
text in sensitive operator logs and are never returned to Discord by the
conversation failure path.

## Failure handling

- An invalid `DGRAPH_URL` fails configuration loading.
- Dgraph schema initialization failure prevents Wartermis from connecting to
  Discord.
- An invalid or cross-scope fact UID fails the tool call without changing data.
- Any Dgraph query or mutation failure follows the normal PI generation-failure
  path: operators receive correlated diagnostics and Discord receives no reply.

## Verification

- `test/dgraph-memory.test.ts` covers HTTP requests, schema initialization,
  bitemporal writes, scoped reads, tombstones, validation, and failures.
- `test/memory-tools.test.ts` covers the six PI tools and bound provenance.
- `test/conversation-service.test.ts` covers propagation of immutable Discord
  scope, author, and message identity.
- `test/pi-gateway.test.ts` proves only Wartermis receives memory tools and
  validates Dgraph at startup.
- `npm run guardrail` remains the completion gate.

## References

- [Baseline design](baseline.md)
- [Persona profiles](persona-profile.md)
- [Clean-room rebuild guide](rebuild-guide.md)
- [Design document index](README.md)
