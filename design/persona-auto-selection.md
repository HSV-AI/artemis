# Persona auto-selection by author display name

## Status

Implemented.

## Problem

Artemis selects a single persona profile per deployment through `PERSONA_PROFILE`,
applied uniformly to every conversation. Community members asked for the assistant
to adopt the `artemis` persona automatically when a Discord user's display name
identifies them as Artemis, without requiring operators to reconfigure the
deployment or fork the persona machinery. The match must be strict about the
leading prefix so a distinct persona such as `Wartemis` does not accidentally
trigger Artemis.

## Scope

This protocol owns:

- a pure selection function that maps an author display name to a persona profile
- case-insensitive matching on the leading prefix `artemis`, anchored to the start of the trimmed name
- passing the incoming author display name from the Discord adapter through the conversation service into the PI gateway
- deterministic per-generation persona resolution and resource-loader cache keying by conversation kind and selected persona id

It does not change Discord authorization, tool registration, provider selection,
persistence shape, response delivery, or the default behavior outside the
selected persona's identity and style. The deployment-configured
`PERSONA_PROFILE` remains the fallback for every name that does not start with
`artemis`.

## Observable behavior

When an incoming Discord message arrives, Artemis resolves the author's display
name (guild member display name, global display name, or username, in that
order) and forwards it to the PI gateway alongside the existing author id. If
the trimmed name starts with the case-insensitive prefix `artemis`, the
generation uses the bundled `artemis` persona profile, regardless of the
deployment-configured `PERSONA_PROFILE`. Otherwise the deployment-configured
profile is used exactly as before. The match is anchored to the start of the
name, so `Artemis`, `Artemis Rose`, `artemis`, and `ARTEMIS` trigger the Artemis
persona, while `Wartemis`, `xArtemis`, and `the artemis` do not. Empty, blank,
or missing display names never match and fall back to the configured default
persona. Slash commands do not invoke the model and are unaffected.

A deployment that already selects `PERSONA_PROFILE=artemis` sees no visible
change: every name resolves to the Artemis persona. A deployment that selects
`wartermis` keeps the Wartermis persona for non-matching names, including
`Wartemis`, while a message authored by a user whose name starts with `artemis`
switches that single generation to the Artemis persona.

## Configuration

No new environment variables are introduced. `PERSONA_PROFILE` continues to
select the fallback persona profile exactly as documented in
[persona profiles](persona-profile.md). The leading prefix that triggers
auto-selection is the application-defined constant `ARTEMIS_NAME_PREFIX`
(`artemis`) in `src/persona-profiles.ts`; it is not operator-configurable.

## Contracts and data flow

```text
Discord message -> author display name ----------------------------------+
conversation kind + author id + source message id + prompt ---------------+|
ARTEMIS_NAME_PREFIX match? -> artemis profile | configured default profile -+-> PI system prompt
```

### Selection function

`selectPersonaByAuthorName(authorName, defaultProfile)` in
`src/persona-profiles.ts` trims the supplied name, lowercases it, and returns
the bundled `artemis` profile when the result starts with
`ARTEMIS_NAME_PREFIX`. Any other input — including empty, blank, `undefined`,
or a name that merely contains the prefix — returns `defaultProfile`
unchanged. The function is pure and deterministic from its two arguments.

### Author display name forwarding

`ConversationService.handleMessage` forwards `message.authorName` to
`PiGateway.generate` as the new `authorName` field on `PiGenerationInput`. The
Discord adapter already resolves the author display name when building an
`InboundMessage`; no Discord resolution logic moves. The PI gateway calls
`selectPersonaByAuthorName(input.authorName, this.config.persona)` for each
generation and composes the resulting profile into the system prompt through
`buildSystemPrompt`.

### Resource-loader cache

The PI gateway caches one `DefaultResourceLoader` per conversation kind and
selected persona id, keyed `${conversationKind}:${persona.id}`. The corpus
revision continues to invalidate the cache. Because the persona is resolved per
generation, two messages of the same kind with different personas build and
cache distinct loaders; repeated generations with the same persona reuse the
cached loader. `setBotDisplayName` continues to clear the cache so the next
generation rebuilds the prompt with the resolved name.

## Persistence

Persona records remain in process memory and are not written to SQLite. The
selected persona id is not stored per conversation; the persona is re-resolved
from the author display name on every generation, so a stored conversation
adopts the persona implied by the author of its next message after a restart.
No schema change is required.

## Security and privacy

The author display name is Discord-provided, user-controlled content. It is
already logged with every incoming message and already included in the prompt
sent to the model as author metadata. Auto-selection reads the name in process
memory and does not log, persist, or transmit it beyond what the existing
message pipeline already does. The selected persona instructions are reviewed
application source, so no user-controlled text is injected into the system
prompt.

## Failure handling

- A blank or missing author display name never matches the prefix and falls
  back to the configured default persona.
- A name that contains but does not start with `artemis` (for example
  `Wartemis`, `xArtemis`) falls back to the default persona.
- A deployment with `PERSONA_PROFILE=artemis` is unaffected: every name either
  matches or falls back to the same Artemis profile.
- An unknown configured `PERSONA_PROFILE` continues to fail startup before any
  message is processed.

## Verification

- `test/persona-profiles.test.ts` covers prefix matching, case-insensitivity,
  whitespace trimming, empty/blank/`undefined` names, non-matching names
  including `Wartemis`, and preservation of each configured default profile.
- `test/conversation-service.test.ts` proves the author display name is
  forwarded to the PI gateway on every accepted generation.
- `test/pi-gateway.test.ts` proves the gateway selects the Artemis persona for
  a matching author name over a generic default, keeps the default for a
  non-matching name, and caches resource loaders per conversation kind and
  selected persona id.
- `npm run guardrail` remains the completion gate.

## References

- [Persona profiles](persona-profile.md)
- [Baseline design](baseline.md)
- [Clean-room rebuild guide](rebuild-guide.md)
- [Design document index](README.md)