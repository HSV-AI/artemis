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
- [Scheduler tools](scheduler-tools.md) — the `schedule_prompt`, `list_scheduled_prompts`, `cancel_scheduled_prompt`, `prune_scheduled_prompt`, `update_scheduled_prompt`, and `run_scheduled_task` tools for once/daily/weekly/monthly prompt schedules plus an optional strict 5-field cron schedule (mutually exclusive with the preset fields, validated at creation, resolved DST-correctly at evaluation time), stored durably in UTC, bound to the harness-injected conversation key and scheduling user, gated by live-Discord membership checks at creation and at fire time, scoped to run in their channel with that channel's permissions, with an audit-history listing, soft-delete cancelling, hard-delete pruning, in-place edits of an ongoing job's prompt text or schedule, re-arming of canceled records through `update_scheduled_prompt`, and immediate on-demand execution of an ongoing job: the default is a reversible preview (a plain gated turn that consumes no occurrence and posts nothing, returning the response for review), and an explicit `consume_next=true` fires the job through the same executor as a scheduled fire.
- [Scheduler execution engine](scheduler-execution.md) — the fire-time engine that claims due prompts (preset or cron schedules alike) atomically in storage, routes them through the scheduler authorization gate into the full agent in the target conversation's session, then reconciles the claim: validated JSON responses post, silent completes quietly, and denied or failed runs release the claim so the job can fire again; also owns the immediate on-demand run paths behind `run_scheduled_task` — the default preview (no claim, plain turn, consumes and posts nothing) and the explicit `consume_next=true` fire reusing the identical claim/gate/validate/reconcile framework — unreachable from scheduler-fired turns (no recursion).
- [Persona profiles](persona-profile.md) — optional deployment-owned identity and style instructions composed with Artemis's fixed system rules.
- [Graph memory](memory.md) — explicit, conversation-scoped PI memory tools backed by persistent Dgraph facts.
- [Dgraph access control and namespaces](dgraph-access-control.md) — ACL bootstrap, namespace isolation, service accounts, JWT clients, and migration boundaries.
- [HSVAI GraphRAG](hsvai-graphrag.md) — source-grounded retrieval over Huntsville AI transcripts and calendar events.
- [HSVAI event catalog](hsvai-event-catalog.md) — reviewed, source-matched event themes and people.
- [Native PI session persistence](pi-session-persistence.md) — ordered SQLite storage for native PI entries, restart recovery, clear-session lifecycle, and the post-cutover minimum supported database state.

Every Markdown document in this directory must appear in this index. Every protocol or major-feature document must also be summarized and linked from the baseline.
