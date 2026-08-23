# Artemis design documents

This directory is the authoritative design record for Artemis. Start with the baseline, then read the focused protocol or feature documents relevant to the change.

## Core documents

- [Baseline design](baseline.md) — high-level product behavior, architecture, and current implementation summary.
- [Clean-room rebuild guide](rebuild-guide.md) — compatibility contract for reproducing Artemis without reading its source.

## Protocol and feature documents

- [Design documentation protocol](documentation-protocol.md) — required design-review workflow, document ownership, subdocument criteria, and enforcement.
- [Discord link-embed suppression](discord-link-embeds.md) — application-layer suppression of link-preview cards on every outbound Discord message, with global and per-channel override.
- [Configurable model provider](model-provider.md) — local model configuration, PI provider registration, startup validation, provider-independent web fetch, and Compose topology.
- [Persona profiles](persona-profile.md) — optional deployment-owned identity and style instructions composed with Artemis's fixed system rules.
- [Graph memory](memory.md) — explicit, conversation-scoped PI memory tools backed by persistent Dgraph facts.

Every Markdown document in this directory must appear in this index. Every protocol or major-feature document must also be summarized and linked from the baseline.
