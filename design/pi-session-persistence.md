# Native PI session persistence

## Status

Implemented.

## Problem

Artemis originally stored a normalized Discord transcript in SQLite but created a new in-memory PI `SessionManager` for every generation. It replayed prior user and assistant text into that manager, which preserved basic conversation continuity while discarding PI-native tool calls, tool results, compactions, tree relationships, model changes, custom entries, and exact historical usage.

A one-time cutover (PR #32, issue #31) converted every existing logical session to native PI entries and recorded schema migration 5. That cutover has rolled out to every deployed Artemis database. This document describes the post-cutover steady state; the migration-only conversion code is no longer present in the application.

## Scope

This protocol owns the durable relationship between an Artemis logical session and its native PI session entries, including restart recovery, `/clear-session`, entry ordering, the minimum supported database state, and the additional sensitive data retained in native entries.

It does not change Discord authorization, conversation-key derivation, current-message or thread-snapshot formatting, model-provider selection, tool authorization, outbound delivery, or the operator-facing normalized `messages` history.

## Observable behavior

An active Artemis logical session is also one durable PI session. A later turn or process restart restores PI's native entries for that logical session before prompting, so prior tool results, compactions, model state, tree relationships, and exact usage remain available to PI. Disposing the live agent object releases runtime resources without deleting the SQLite entries.

Basic user and assistant history remains available in the normalized `messages` table for Discord deduplication, author attribution, auditing, and operator inspection. That table is never replayed into PI and is not the canonical model context. No runtime code reads normalized messages to construct PI context.

`/clear-session` closes the active Artemis session. Its normalized messages and native PI entries remain archived. The next accepted message creates a different logical session with an empty native PI context.

## Contracts and data flow

Startup performs model-provider validation after the database is open and migrations have run. A normal turn follows this flow:

```text
Discord message -> conversation coordinator -> active logical session ID
                                              |
                                              v
                                   SQLite native PI entries
                                              |
                                              v
                                   PI SessionManager adapter
                                              |
                                              v
                                      one PI prompt
                                              |
                         native user/tool/assistant/compaction entries
                                              |
                                              v
                                   ordered SQLite appends
```

The installed PI SDK accepts its concrete `SessionManager` but does not expose a storage-provider interface. Artemis therefore keeps a narrow adapter at that boundary. It uses PI's exported native entry types and context-building functions while directing header creation, ordered loads, appends, and format migrations through the SQLite session store. The compatibility cast is isolated to this adapter and must be removed in favor of an SDK storage port when one becomes available.

Artemis pins the PI AI and coding-agent packages to the exact compatibility-tested version. The adapter implements an explicit `Pick<SessionManager, ...>` contract for every PI method used by the create-session, prompt, extension, compaction, and tree-editing paths. PI's file-session lifecycle methods are deliberately outside that contract because SQLite owns persistence. A real-SDK smoke test creates an agent session and completes a prompt through the adapter with a faux model-provider boundary. Any PI upgrade must update the exact versions, compile this contract, and pass that smoke test before publication.

Every PI session begins with one native session header. Every later native entry retains PI's JSON representation, entry type, entry ID, parent ID, timestamp, and payload. Opening a session performs one ordered SQLite read and builds PI's in-memory indexes directly; it does not convert or append `StoredMessage[]`. No normalized-message-to-native-PI conversion function or zero-usage compatibility construction remains in the codebase.

### Minimum supported database state

The minimum supported database state is a fully migrated database with schema migrations 1 through 5 applied. Migrations 4 and 5 are preserved as historical database facts: migration 4 introduced the `pi_sessions` and `pi_session_entries` tables, and migration 5 marked the one-time cutover complete. They are not re-run as incremental steps.

A fresh empty database bootstraps to the current schema in one transaction: it creates every table (`conversations`, `sessions`, `messages`, `events`, `application_logs`, `incoming_messages`, `pi_sessions`, `pi_session_entries`) and records migrations 1 through 5. A verified migration-5 database opens without modification or conversion work.

An existing database whose `schema_migrations` table has rows but lacks migration 5 is a pre-cutover database that Artemis no longer supports. Startup rejects it with an actionable operator error before Discord connects and writes nothing to it. Artemis does not silently mark such a database migrated, replay its normalized transcript into native PI entries, or discard its history; the operator must restore it from a verified migration-5 backup or start fresh.

## Performance considerations

Each generation currently restores the selected logical session with one indexed, ordered SQLite query and parses every native entry for that session. The work is isolated from other sessions but grows linearly with the selected session's retained entry count. Artemis does not retain live PI managers across turns because a process-local cache would add eviction, concurrency, and clear-session lifecycle requirements. Issue [#35](https://github.com/HSV-AI/artemis/issues/35) tracks measurements and requires evidence before introducing such a cache.

## Configuration

This protocol introduces no configuration. Native entries use the existing `SQLITE_PATH` database and persistent data volume.

## Persistence

`pi_sessions` has one row per logical `sessions` row. It stores the next append ordinal and timestamps. Its foreign key cascades when an operator deliberately deletes the owning logical session.

`pi_session_entries` stores one raw native PI JSON object per row with a zero-based ordinal, optional native entry ID and parent ID, entry type, and validated JSON text. The `(session_id, ordinal)` primary key preserves JSONL order, while `(session_id, entry_id)` is unique. Parent lookup is indexed.

Creating a PI session, appending one native entry, replacing entries after a PI format migration, and updating the next ordinal are transactional. A load rejects a missing ordinal rather than silently presenting truncated context. The session header ID must match the Artemis logical session ID.

The normalized `messages` table remains intentionally separate because it represents the Discord deduplication, attribution, audit, and operator-history contract; it is not retained as a model-context compatibility fallback. `pi_session_entries` is the sole harness context, and neither representation is reconstructed from the other during normal operation.

## Security and privacy

Native PI entries may contain tool arguments, tool results, fetched external content, model reasoning, diagnostics, and usage metadata that are absent from the normalized transcript. The SQLite database must be treated as sensitive user and integration data. Native entries follow the existing indefinite retention lifecycle and remain until an operator deletes their logical session or the data volume.

Application code must not deliberately insert configured credentials into either representation. Provider or tool payloads may nevertheless contain sensitive request context, so routine logs must not emit raw native entries.

## Failure handling

- A schema bootstrap failure on a fresh database rolls back and aborts startup before Discord connects.
- An existing database missing migration 5 is rejected with an actionable operator error before Discord connects; no partial writes are made, no normalized transcript is replayed, and no history is discarded.
- Invalid JSON, a mismatched session header, or an incomplete ordinal sequence fails generation; Artemis records the normalized generation failure and sends nothing to Discord.
- A native-entry append is written to SQLite before the adapter advances its in-memory leaf. If the write fails, the live context is not advanced and the normal generation-failure path applies.
- Accepted Discord source messages remain in the normalized transcript when generation fails, matching the existing failure contract.
- A successful provider response whose later normalized assistant insert fails remains present in the native PI session; operators must treat the native session as the model-context authority.

## Verification

- Repository tests cover the fresh-database bootstrap (migrations 1 through 5 and all current tables), the steady-state reopen of a verified migration-5 database without modification, and the rejection of an existing pre-migration database missing migration 5 with no partial writes.
- Session-manager tests cover exact usage, tool results, compaction metadata, parent relationships, labels, branches, restart recovery, append failure, archived clear-session state, PI format-version entry migration, and corrupted ordinal sequence rejection.
- Gateway and coordinator tests prove normal generation no longer accepts or replays `history` and continues to dispose the live PI session, and that startup health no longer performs a cutover.
- The SDK-compatibility test uses the real pinned PI SDK with its faux provider to create an agent session, complete a prompt, append native entries through SQLite, dispose the agent, and restore the resulting context. It does not mock `createAgentSession`.
- `npm run check:design` and `npm run guardrail` remain the completion gates.

## References

- [Baseline design](baseline.md)
- [Configurable model provider](model-provider.md)
- [Clean-room rebuild guide](rebuild-guide.md)
- [Design document index](README.md)
- [Issue #31](https://github.com/HSV-AI/artemis/issues/31)
- [Issue #39](https://github.com/HSV-AI/artemis/issues/39)
- [Performance follow-up #35](https://github.com/HSV-AI/artemis/issues/35)