# Artemis design documents

This directory is the authoritative design record for Artemis. Start with the baseline, then read the focused protocol or feature documents relevant to the change.

## Core documents

- [Baseline design](baseline.md) — high-level product behavior, architecture, and current implementation summary.
- [Clean-room rebuild guide](rebuild-guide.md) — compatibility contract for reproducing Artemis without reading its source.

## Protocol and feature documents

- [Design documentation protocol](documentation-protocol.md) — required design-review workflow, document ownership, subdocument criteria, and enforcement.
- [Discord link-embed suppression](discord-link-embeds.md) — application-layer suppression of link-preview cards on every outbound Discord message, with global and per-channel override.
- [Configurable model provider](model-provider.md) — local model configuration, PI provider registration, startup validation, provider-independent web fetch, and Compose topology.
- [Model self-introspection](model-self-introspection.md) — the `model_info` tool that reports the live registered provider and model from actual runtime state.
- [Channel timezone tools](timezone-tools.md) — per-DM/Channel-Group IANA timezone setting and current-datetime tools bound to the harness-injected conversation key, with all times stored as UTC.
- [Scheduler tools](scheduler-tools.md) — the `schedule_prompt`, `list_scheduled_prompts`, `cancel_scheduled_prompt`, `prune_scheduled_prompt`, `resume_scheduled_prompt`, `update_scheduled_prompt`, and `run_scheduled_task` tools for once/daily/weekly/monthly prompt schedules, stored durably in UTC, bound to the harness-injected conversation key and scheduling user, gated by live-Discord membership checks at creation and at fire time, scoped to run in their channel with that channel's permissions, with an audit-history listing, soft-delete cancelling, hard-delete pruning, recovery of canceled events, in-place edits of an ongoing job's prompt text or schedule, and immediate on-demand execution of an ongoing job through the same executor as a scheduled fire.
- [Scheduler execution engine](scheduler-execution.md) — the fire-time engine that routes due prompts through the scheduler authorization gate into the full agent in the target conversation's session, validates the strict JSON response, posts it, or stays silent; also owns the immediate on-demand run path behind `run_scheduled_task`, which reuses the identical consume/gate/validate/deliver framework and is unreachable from scheduler-fired turns (no recursion).
- [Persona profiles](persona-profile.md) — optional deployment-owned identity and style instructions composed with Artemis's fixed system rules.
- [Graph memory](memory.md) — explicit, conversation-scoped PI memory tools backed by persistent Dgraph facts.
- [Dgraph access control and namespaces](dgraph-access-control.md) — ACL bootstrap, namespace isolation, service accounts, JWT clients, and migration boundaries.
- [HSVAI GraphRAG](hsvai-graphrag.md) — source-grounded retrieval over Huntsville AI transcripts and calendar events.
- [HSVAI event catalog](hsvai-event-catalog.md) — reviewed, source-matched event themes and people.
- [Native PI session persistence](pi-session-persistence.md) — ordered SQLite storage for native PI entries, restart recovery, clear-session lifecycle, and the post-cutover minimum supported database state.

Every Markdown document in this directory must appear in this index. Every protocol or major-feature document must also be summarized and linked from the baseline.
