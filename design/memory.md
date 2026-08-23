# Graph memory

## Status

Implemented.

## Problem

Artemis needs durable facts that survive PI session clears and process restarts
without mixing data between Discord conversations. Users must remain in control
of what is remembered, corrected, or forgotten.

## Scope

This protocol owns the Dgraph schema, conversation scope, provenance, PI tools,
startup validation, retention semantics, and Compose service. It does not change
Discord authorization, SQLite chat history, persona selection, or model-provider
selection.

## Observable behavior

Every Artemis profile receives these tools:

| Tool | Behavior |
| --- | --- |
| `memory_remember` | Insert one current fact. |
| `memory_recall` | List current facts in the conversation scope. |
| `memory_supersede` | End one active fact and insert its correction atomically. |
| `memory_forget` | Stop believing one active fact without deleting it. |
| `memory_believed_at` | List facts believed at an ISO-8601 instant. |
| `memory_audit` | List current and ended facts with supersession links. |

Model-facing guidelines permit writes only when the current Discord user
explicitly asks to remember, correct, or forget something. Recall results are
marked as user data and must not be treated as instructions or authorization.

## Contracts and data flow

Artemis binds every operation to the triggering conversation key; the model
cannot supply or override it:

- Direct message: `dm:<channel-id>`.
- Guild channel: `guild:<guild-id>:channel:<channel-id>`.
- Guild thread: the parent guild channel's key.

Writes also bind the triggering Discord author ID and message ID. Memory survives
`/clear-session` because that command closes only the SQLite/PI session while the
stable Discord conversation key remains unchanged.

## Configuration

`DGRAPH_URL` is an HTTP(S) Dgraph Alpha endpoint and defaults to
`http://dgraph:8080`. Base Compose runs `dgraph/standalone:v25.4.0`, waits for
`/health`, and persists `/dgraph` in the `dgraph-data` volume. Artemis applies the
additive DQL schema after model health validation and before Discord login.

## Persistence

Dgraph stores `Fact` nodes containing the statement, optional subject, scope,
Discord provenance, valid time, system time, optional end reason, and optional
supersession edge. Correction and forgetting stamp ended facts rather than
deleting them. Current recall excludes ended facts; audit includes them. Every
read and write is constrained to one conversation scope.

## Security and privacy

Memory facts are user data and have no automatic expiration. Forgetting is a
logical tombstone, not physical erasure. Base Compose does not publish Dgraph to
a host port, and Artemis does not send credentials to Dgraph. Tool guidance
prohibits storing credentials or secrets.

## Failure handling

- Invalid `DGRAPH_URL` fails configuration loading.
- Schema initialization failure prevents Discord login.
- Invalid, inactive, or cross-scope fact UIDs fail without changing data.
- Query and mutation failures follow the normal generation-failure path and
  produce no Discord reply.

## Verification

- `test/dgraph-memory.test.ts` covers schema, reads, writes, tombstones, scope,
  and failure handling.
- `test/memory-tools.test.ts` covers tool behavior and bound provenance.
- `test/conversation-service.test.ts` covers immutable Discord identity.
- `test/pi-gateway.test.ts` covers registration and startup initialization.
- `npm run guardrail` is the completion gate.

## References

- [Baseline design](baseline.md)
- [Clean-room rebuild guide](rebuild-guide.md)
- [Design document index](README.md)
