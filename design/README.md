# Artemis design documents

This directory is the authoritative design record for Artemis. Read the focused protocol or feature documents relevant to the change.

## Core documents

- [Baseline design](baseline.md) — historical record of the original implemented design.
- [Clean-room rebuild guide](rebuild-guide.md) — historical clean-room contract for reconstructing that original design.

## Protocol and feature documents

- [Design documentation protocol](documentation-protocol.md) — required design-review workflow, document ownership, subdocument criteria, and enforcement.
- [Discord link-embed suppression](discord-link-embeds.md) — application-layer suppression of link-preview cards on every outbound Discord message, with global and per-channel override.
- [Configurable model provider](model-provider.md) — local model configuration, PI provider registration, startup validation, provider-independent web fetch, and Compose topology.
- [Persona profiles](persona-profile.md) — optional deployment-owned identity and style instructions composed with Artemis's fixed system rules.
- [Graph memory](memory.md) — explicit, conversation-scoped PI memory tools backed by persistent Dgraph facts.
- [Dgraph access control and namespaces](dgraph-access-control.md) — ACL bootstrap, namespace isolation, service accounts, JWT clients, and migration boundaries.
- [HSVAI GraphRAG](hsvai-graphrag.md) — source-grounded retrieval over Huntsville AI transcripts and calendar events.
- [HSVAI event catalog](hsvai-event-catalog.md) — reviewed seed, durable runtime overlay, source-matched event themes and people, and operator-only model enrichment.
- [Native PI session persistence](pi-session-persistence.md) — ordered SQLite storage for native PI entries, restart recovery, clear-session lifecycle, and the one-time database cutover.

Every Markdown document in this directory must appear in this index.
