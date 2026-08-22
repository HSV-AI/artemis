# Design documentation protocol

## Status

Active.

## Problem

Application checks can pass while prose silently drifts from implemented behavior. Coding agents need an explicit design-review step, a clear ownership model for details, and structural checks that make missing or orphaned documents visible.

## Scope

This protocol applies to every application, configuration, persistence, prompt, tool, integration, security, privacy, and deployment change in Artemis.

A protocol or feature is major when it introduces or materially changes any of the following:

- A user-visible command, workflow, or conversation rule.
- A model-facing protocol or system-prompt contract.
- A tool, provider, or external integration.
- An authorization, security, or privacy boundary.
- A database table, migration, retention rule, or lifecycle.
- A service or deployment-topology boundary.
- Cross-module behavior with its own inputs, outputs, failure policy, or acceptance criteria.

Small corrections to an existing feature update that feature's existing document. Internal refactors with no design impact require a recorded no-impact rationale in the pull request but do not require artificial prose changes.

## Observable behavior

Before implementation, the coding agent reads the design index, baseline, and relevant subdocuments and classifies the change's design impact. Before completion, it compares the final diff with the documented behavior and updates all affected documents in the same change.

Every new protocol or major feature has its own `design/<feature-or-protocol>.md` document. That document is linked from the design index and summarized with a link in the baseline. Compatibility changes also update the rebuild guide.

A change is incomplete when its design impact has not been reviewed, required documentation is absent, the design check fails, or the complete guardrail fails.

## Contracts and data flow

Documentation ownership is hierarchical:

| Document | Responsibility |
| --- | --- |
| `design/README.md` | Complete catalog and discovery entry point. |
| `design/baseline.md` | High-level current architecture and summaries linking to detailed documents. |
| `design/rebuild-guide.md` | Observable compatibility contract for a clean-room implementation. |
| `design/<feature-or-protocol>.md` | Authoritative detailed contract for one major feature or protocol. |

The required workflow is:

1. Read the index, baseline, and relevant subdocuments before changing behavior.
2. Classify the change as no design impact, an update to existing design, or a new protocol/major feature.
3. Create or update the authoritative subdocument alongside the implementation.
4. Update the baseline summary and rebuild contract when their scope is affected.
5. Select one design-impact outcome in the pull-request checklist and provide the document path or no-impact rationale.
6. Run `npm run check:design` and `npm run guardrail`.

Detailed behavior belongs in one authoritative subdocument. The baseline and rebuild guide summarize or express compatibility requirements and link to the detailed contract rather than copying it wholesale.

## Configuration

The protocol introduces no application runtime configuration. `npm run check:design` performs the structural validation and is included in `npm run guardrail`.

## Persistence

Design records are versioned as Markdown in Git. They do not use the Artemis SQLite database and must be changed, reviewed, and delivered with the implementation they describe.

## Security and privacy

Design documents describe security and privacy boundaries without containing live credentials, private user content, production database contents, or raw provider payloads. A new or changed authorization, logging, retention, secret-handling, or external-data rule always has design impact.

## Failure handling

When design impact is uncertain, treat the change as design-affecting and document the decision. If a required document cannot be updated or a structural check fails, report the task as incomplete instead of using a waiver hidden in code or commit text.

Structural automation cannot prove that prose is semantically correct. Reviewers and coding agents remain responsible for comparing claims with source, tests, configuration, and deployment artifacts.

## Verification

`npm run check:design` verifies that:

- Every Markdown file under `design/` is linked from `design/README.md`.
- Every indexed local document exists.
- Every local Markdown link within `design/` resolves.
- Every protocol or major-feature subdocument is linked from `design/baseline.md`.
- Every protocol or major-feature subdocument contains the required contract sections.

The pull-request checklist records the semantic design-impact review. The complete `npm run guardrail` remains the completion gate.

## References

- [Design document index](README.md)
- [Baseline design](baseline.md)
- [Clean-room rebuild guide](rebuild-guide.md)
- [Repository agent instructions](../AGENTS.md)
