# Configurable model provider

## Status

Implemented.

## Problem

Artemis previously registered one hardcoded Ollama provider, named its runtime
configuration after Ollama, started Ollama in Compose, and routed `web_fetch`
through an Ollama-only experimental endpoint. The PI completion boundary was
already OpenAI-compatible, but those surrounding assumptions prevented a
deployment from selecting another provider without code changes.

## Scope

This protocol owns:

- model-provider metadata loaded from a local JSON file
- optional model reasoning effort selected by that provider definition
- model API-key injection from the environment
- dynamic PI provider and model registration
- startup model discovery through the configured `/models` endpoint
- provider-independent direct HTTP implementation of the PI `web_fetch` tool
- deployment ownership of concrete alternate-provider values and topology

It does not change Discord channel or user authorization, conversation identity,
SQLite persistence, GitHub tool authorization, prompts, or response delivery.

## Observable behavior

Artemis still validates its model dependency before connecting to Discord. With
no model file selected, it preserves the existing `OLLAMA_BASE_URL`,
`OLLAMA_MODEL`, and `OLLAMA_API_KEY` behavior. When `MODEL_CONFIG_PATH` is set,
it instead checks that configured OpenAI-compatible base URL, registers the
configured provider and model with PI, and uses the same provider metadata when
rebuilding stored assistant messages. Changing provider or model requires a
config update and restart, not an application-code branch.

`web_fetch` remains an explicitly registered PI custom tool. It issues a direct
HTTP GET instead of calling the model provider. HTML responses are reduced to a
title, readable text, and resolved links; other text responses are passed
through directly. Content is bounded to 100,000 characters, labeled as
untrusted, sanitized, and limited to ten displayed links before PI sees it.

The Discord channel policy is unchanged. A private guild channel works by
granting the bot Discord access and listing that channel ID in
`DISCORD_ALLOWED_CHANNEL_ID`; any channel member may invoke Artemis by direct
mention, managed bot-role mention, or reply to Artemis.

## Contracts and data flow

`MODEL_CONFIG_PATH` selects a JSON object that defines `providerId`,
`providerName`, `baseUrl`, `modelId`, `reasoning`, `contextWindow`, `maxTokens`,
and `supportsDeveloperRole`. Those fields are required; the loader supplies no
alternate-provider identity, endpoint, or model defaults. It validates strings,
the HTTP(S) base URL, booleans, and positive integer limits. A provider that
supports configurable reasoning effort may also select `reasoningEffort` from
`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Its presence enables
PI reasoning-effort compatibility; omission means Artemis sends no explicit
reasoning-effort parameter. Artemis passes a selected effort when creating every
PI session and registers the selected extended `xhigh` or `max` level for custom
models. The legacy Ollama workflow explicitly selects `medium`.
`MODEL_API_KEY` remains outside the JSON file and is attached to model discovery
and completion requests. An empty API key sends no authorization header. In the
legacy Ollama workflow, the default `OLLAMA_API_KEY=ollama` value remains a
compatibility placeholder and does not enable authorization; any other nonblank
Ollama key is sent as a bearer token.

The runtime flow is:

```text
model.config.json -> config loader -> PI ModelRuntime provider registration
MODEL_API_KEY ----^                         |
                                             -> OpenAI-compatible /v1 endpoint

PI custom tool -> web_fetch -> target HTTP(S) URL -> sanitize -> PI
```

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `MODEL_CONFIG_PATH` | None | Optional local JSON provider definition. Omission preserves the `OLLAMA_*` workflow. |
| `MODEL_API_KEY` | `local` | Bearer value supplied only to the configured model endpoint. Blank disables the header. |

Base `compose.yaml` starts Ollama, the model pull job, Dgraph, and Artemis.
Dgraph supports the independent Wartermis memory protocol and does not affect
provider selection. Concrete alternate-provider configuration and Compose
overrides belong to deployment repositories rather than upstream Artemis.

## Persistence

No schema changes are required. Sessions continue to store the configured model
ID, and assistant messages retain the actual response model reported by PI.
Existing SQLite data is reconstructed under the currently configured provider.

## Security and privacy

The model API key remains in `.env` or an operator secret mechanism and is never
written to the model JSON example. The key is sent only to model discovery and
completion, never to `web_fetch` targets.

`web_fetch` permits HTTP and HTTPS URLs and follows redirects. It therefore has
network reachability equal to the Artemis process. Operators must apply runtime
egress controls when internal addresses should not be reachable. Fetched data
is bounded, stripped of script and style bodies for HTML, labeled as external,
and sanitized before entering model context.

## Failure handling

- A selected but missing, unreadable, malformed, or invalid model config fails startup with the
  config path and invalid field, without logging the API key.
- A failed `/models` request prevents Discord login.
- A missing configured PI model fails generation and follows the existing silent
  Discord failure path.
- A non-successful `web_fetch` response raises a tool error containing status and
  bounded upstream text; the conversation follows the normal generation-failure
  path.

## Verification

- `test/config.test.ts` covers defaults, JSON loading, reasoning effort, overrides, and validation.
- `test/pi-gateway.test.ts` covers dynamic provider registration, authentication,
  configured reasoning effort, model lookup, reconstructed history, and health failure.
- `test/web-fetch-tool.test.ts` covers direct HTTP, HTML extraction, link limits,
  sanitization, plain text, invalid schemes, and upstream errors.
- `test/application.test.ts` proves provider validation precedes Discord startup.
- `npm run guardrail` remains the completion gate.

## References

- [Baseline design](baseline.md)
- [Clean-room rebuild guide](rebuild-guide.md)
- [Design document index](README.md)
