# Model self-introspection

## Status

Implemented.

## Problem

Artemis had no way to introspect its own runtime model configuration. The
model's identity existed only in environment configuration and PI provider
registration, so the model could not answer questions like "what model are you
running?", could not help verify a deployment's provider selection, and could
only guess or hallucinate when asked about itself.

## Scope

This protocol owns:

- the `model_info` PI custom tool
- the runtime snapshot resolution that backs the tool
- the deterministic text rendering of that snapshot, including unknown states

It does not change provider or model selection, model registration, reasoning
effort handling, Discord authorization, persistence, or any other tool
contract.

## Observable behavior

Artemis registers a `model_info` tool for every profile in every conversation.
It takes no inputs: the call is pure self-introspection. Executing it returns
the provider and model Artemis is actually running on, followed by supporting
runtime details:

```text
Provider: <provider display name or unknown> (id: <provider id or unknown>)
Model: <model id or unknown>
API: <harness API name or unknown>
Endpoint: <provider base URL or unknown>
Reasoning: enabled (configured effort: <effort>) | enabled | disabled | unknown
Context window: <token count or unknown>
Max output tokens: <token count or unknown>
```

The tool's prompt registry snippet tells Artemis to trust this result instead
of guessing its own model identity, so "what model are you running?" is
answered from real runtime configuration rather than memory.

## Contracts and data flow

The snapshot is resolved at execution time from the live PI state, never from
hardcoded values:

```text
ModelRuntime.getProvider(providerId) -> provider name, base URL
ModelRuntime.getModel(providerId, modelId) -> model id, API, reasoning flag,
                                             context window, max tokens
configured reasoningEffort ---------------> configured effort segment
```

The configured provider id selects both lookups. When the model lookup fails to
find the configured model in the registered runtime, the whole snapshot is
unresolvable. Individual fields that the runtime cannot supply render as the
literal `unknown`. The reasoning effort comes from configuration because the
registered model does not carry the selected effort. Formatting is a pure
function of the snapshot: whitespace-only strings, missing fields, and
non-positive token limits all render as `unknown`.

## Configuration

No new settings. The tool reflects the model provider configuration defined by
[Configurable model provider](model-provider.md) as it was registered at
startup. Changing the provider or model therefore changes what the tool reports
only after a configuration update and restart.

## Persistence

No new persistence. Tool calls and results are stored like every other PI tool
interaction through the native session entries described by
[Native PI session persistence](pi-session-persistence.md).

## Security and privacy

The tool exposes only operational metadata that already lives in non-secret
configuration: provider identity, model identity, endpoint URL, context and
token limits, and reasoning settings. The model API key is deliberately
excluded from the snapshot and can never appear in tool output. The values
originate from validated local configuration, involve no network access, and
are not external data, so no untrusted-content sanitization applies.

## Failure handling

- Snapshot unresolvable (runtime not initialized or configured model not
  registered): the tool returns "Model runtime information is currently
  unavailable." instead of failing the turn or inventing values.
- Snapshot resolution throwing an unexpected error: treated the same as
  unresolvable and reported as unavailable; the error never propagates into the
  generation-failure path for this informational tool.
- Unregistered model lookups are additionally visible through the existing
  startup health check and generation-time model validation.

## Verification

- `test/model-info-tool.test.ts` covers registration without parameters,
  deterministic full rendering, per-field unknowns, effort-less enabled
  reasoning, unresolvable snapshots, and resolver failures.
- `test/pi-gateway.test.ts` proves the tool reflects the live registered
  runtime provider and model (not the configured echo), appears in the
  Available Tools prompt registry, and its snapshot collapses to unavailable
  when the registered model is absent.
- `npm run guardrail` remains the completion gate.

## References

- [Design document index](README.md)
- [Baseline design](baseline.md)
- [Clean-room rebuild guide](rebuild-guide.md)
- [Configurable model provider](model-provider.md)