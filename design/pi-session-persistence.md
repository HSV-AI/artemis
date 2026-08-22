# Native PI session persistence

## Status

Implemented.

## Problem

Artemis originally stored a normalized Discord transcript in SQLite but created a new in-memory PI `SessionManager` for every generation. It replayed prior user and assistant text into that manager, which preserved basic conversation continuity while discarding PI-native tool calls, tool results, compactions, tree relationships, model changes, custom entries, and exact historical usage.

## Scope

This protocol owns the durable relationship between an Artemis logical session and its native PI session entries, including restart recovery, `/clear-session`, entry ordering, legacy import, persistence failures, and the additional sensitive data retained in native entries.

It does not change Discord authorization, conversation-key derivation, current-message or thread-snapshot formatting, model-provider selection, tool authorization, outbound delivery, or the operator-facing normalized `messages` history.

## Observable behavior

An active Artemis logical session is also one durable PI session. A later turn or process restart restores PI's native entries for that logical session before prompting, so prior tool results, compactions, model state, tree relationships, and exact usage remain available to PI. Disposing the live agent object releases runtime resources without deleting the SQLite entries.

Basic user and assistant history remains available in the normalized `messages` table for Discord deduplication, author attribution, auditing, and operator inspection. That table is not replayed into PI during normal generation and is not the canonical model context.

`/clear-session` closes the active Artemis session. Its normalized messages and native PI entries remain archived. The next accepted message creates a different logical session with an empty native PI context.

## Contracts and data flow

Startup performs model-provider validation and then runs the idempotent legacy import before Discord connects. A normal turn follows this flow:

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

Every PI session begins with one native session header. Every later native entry retains PI's JSON representation, entry type, entry ID, parent ID, timestamp, and payload. Opening a session performs one ordered SQLite read and builds PI's in-memory indexes directly; it does not convert or append `StoredMessage[]`.

### Legacy import

Migration 4 creates the native PI tables without fabricating information that the old transcript never captured. After provider validation and before Discord login, Artemis finds every logical session that has normalized messages but no native PI state and imports it once.

The import preserves the available user content, structured Discord speaker metadata, assistant text, reasoning, diagnostics, saved response model, and timestamps. It cannot recover historical tool entries, compactions, tree structure, or usage. Each imported session is therefore marked `legacy_import_incomplete` in `pi_sessions.history_completeness` and receives a native `artemis.legacy_import` custom entry listing the unavailable state. Imported assistant usage is zero only as an explicitly incomplete compatibility value; it must never be presented as complete historical accounting. A repeated startup skips sessions that already have a `pi_sessions` row.

## Performance considerations

Each generation currently restores the selected logical session with one indexed, ordered SQLite query and parses every native entry for that session. The work is isolated from other sessions but grows linearly with the selected session's retained entry count. Artemis does not retain live PI managers across turns because a process-local cache would add eviction, concurrency, and clear-session lifecycle requirements. Issue [#35](https://github.com/HSV-AI/artemis/issues/35) tracks measurements and requires evidence before introducing such a cache.

The one-time legacy import currently discovers all unimported logical sessions and materializes their normalized histories before writing native entries. That keeps the migration simple and idempotent for the current deployment scale, but it can increase startup memory for an unusually large legacy database. Issue #35 also tracks a bounded-batch importer if measurements show that eager migration is unsafe.

## Configuration

This protocol introduces no configuration. Native entries use the existing `SQLITE_PATH` database and persistent data volume.

## Persistence

`pi_sessions` has one row per logical `sessions` row. It stores the history-completeness marker, next append ordinal, and timestamps. Its foreign key cascades when an operator deliberately deletes the owning logical session.

`pi_session_entries` stores one raw native PI JSON object per row with a zero-based ordinal, optional native entry ID and parent ID, entry type, and validated JSON text. The `(session_id, ordinal)` primary key preserves JSONL order, while `(session_id, entry_id)` is unique. Parent lookup is indexed.

Creating a PI session, importing a legacy session, appending one native entry, replacing entries after a PI format migration, and updating the next ordinal are transactional. A load rejects a missing ordinal rather than silently presenting truncated context. The session header ID must match the Artemis logical session ID.

The normalized `messages` table remains intentionally separate. It represents the Discord/application audit contract; `pi_session_entries` represents the exact harness context. Neither is silently reconstructed from the other after the one-time legacy import.

## Security and privacy

Native PI entries may contain tool arguments, tool results, fetched external content, model reasoning, diagnostics, and usage metadata that are absent from the normalized transcript. The SQLite database must be treated as sensitive user and integration data. Native entries follow the existing indefinite retention lifecycle and remain until an operator deletes their logical session or the data volume.

Application code must not deliberately insert configured credentials into either representation. Provider or tool payloads may nevertheless contain sensitive request context, so routine logs must not emit raw native entries.

## Failure handling

- A schema migration or legacy-import failure aborts startup before Discord connects.
- Invalid JSON, a mismatched session header, or an incomplete ordinal sequence fails generation; Artemis records the normalized generation failure and sends nothing to Discord.
- A native-entry append is written to SQLite before the adapter advances its in-memory leaf. If the write fails, the live context is not advanced and the normal generation-failure path applies.
- Accepted Discord source messages remain in the normalized transcript when generation fails, matching the existing failure contract.
- A successful provider response whose later normalized assistant insert fails remains present in the native PI session; operators must treat the native session as the model-context authority.

## Verification

- Repository tests cover migration 4, ordered entry storage, transactional append/replace behavior, and completeness metadata.
- Session-manager tests cover exact usage, tool results, compaction metadata, parent relationships, labels, branches, restart recovery, append failure, and archived clear-session state.
- Legacy-import tests prove the import is idempotent, preserves structured speaker attribution, writes both incomplete markers, and does not claim historical usage is known.
- Gateway and coordinator tests prove normal generation no longer accepts or replays `history` and continues to dispose the live PI session.
- The SDK-compatibility test uses the real pinned PI SDK with its faux provider to create an agent session, complete a prompt, append native entries through SQLite, dispose the agent, and restore the resulting context. It does not mock `createAgentSession`.
- `npm run check:design` and `npm run guardrail` remain the completion gates.

## References

- [Baseline design](baseline.md)
- [Configurable model provider](model-provider.md)
- [Clean-room rebuild guide](rebuild-guide.md)
- [Design document index](README.md)
- [Issue #31](https://github.com/HSV-AI/artemis/issues/31)
- [Performance follow-up #35](https://github.com/HSV-AI/artemis/issues/35)
