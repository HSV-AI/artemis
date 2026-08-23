# Persona profiles

## Status

Implemented.

## Problem

Artemis previously defined one identity and tone in application code. Operators
could ask for a different style in a Discord message, but that request competed
with the fixed system identity and did not reliably persist across conversations.
Maintaining separate bot variants should not require source forks or replacement
of the shared Discord, tool, and capability rules.

## Scope

This protocol owns:

- a typed profile record containing an ID, a fallback display name, and model instructions
- named `artemis` and `wartermis` profiles bundled with the application
- one dedicated source file for each bundled profile
- startup validation for named selection
- deterministic composition of the selected instructions with the fixed system prompt
- runtime resolution of the bot's Discord display name from the connected Discord client, which overrides the profile's fallback name for self-introduction

It does not change Discord authorization, tools, provider selection,
persistence, response delivery, or the default Artemis behavior.

## Observable behavior

The default `artemis` profile behaves exactly as before. Selecting `wartermis`
gives every DM and guild generation the bundled Wartermis identity and style
instructions. Slash commands do not invoke the model and are unaffected.
Profile changes become visible after rebuilding and restarting Artemis.

The bot's display name is resolved from Discord at startup: the connected
client's global display name when set, otherwise its username. That name is
injected into every system prompt as the authoritative name the model uses
when introducing itself, so asking the bot its name returns the
Discord-configured name rather than a name hardcoded in the profile. The
`artemis` profile instructions no longer hardcode the name `Artemis`; the
profile `name` field is only the fallback used when Discord has not yet
provided a name (for example, before the client becomes ready).

## Configuration

`PERSONA_PROFILE` selects a bundled profile by case-insensitive ID and defaults to
`artemis`. Supported IDs are `artemis` and `wartermis`; any other value fails
startup. Each profile is a record with `id`, `name`, and complete `instructions`
fields in its own file under `src/personas/`. `persona-profiles.ts` only owns the
registry and selection logic; it does not contain profile instructions. The
profile `name` is a fallback display name; the live display name is read from
Discord at startup and is not configured through environment variables.

## Contracts and data flow

```text
PERSONA_PROFILE -> named profile registry -> selected profile record --+
Discord client ready -> bot display name (globalName ?? username) ------+|
conversation kind + registered tools ---------------------------------+-> composed PI system prompt
```

### Prompt composition

The application builds each system prompt in this order:

1. An identity block stating the bot's resolved display name and instructing the model to introduce itself with that name when asked.
2. Complete identity instructions from the selected profile.
3. Fixed Discord speaker-handling rules.
4. Guild-only Discord channel limits when the conversation is a guild context.
5. Fixed Capability Gap Protocol and the generated Available Tools registry.

The profile owns style while application-owned behavioral instructions and the
Discord-resolved display name remain fixed for every profile. The system prompt
no longer hardcodes the Discord name; it references the runtime-resolved name.
The resulting prompt remains deterministic from the conversation kind, profile
record, registered tool metadata, and the resolved display name. Both DM and
guild conversations receive the same selected persona and the same resolved name.

### Display name resolution

When the Discord client emits `ClientReady`, the Discord adapter resolves the
bot's display name from `client.user` (global display name when set, otherwise
username) and forwards it to the PI gateway via `setBotDisplayName`. The
gateway stores the name, clears its cached per-kind resource loaders, and
injects the name into the next system prompt. If the Discord user is
unavailable, no name is forwarded and `buildSystemPrompt` falls back to the
selected profile's `name` field as a sensible default.

## Persistence

Persona records are not written to SQLite and require no schema change. The
selected profile ID is included in the `artemis_starting` log; instructions are
held in process memory and applied when PI reconstructs a session.
After a restart, existing conversations therefore use the profile selected by
the new process without changing their stored message history.

## Security and privacy

Persona files are reviewed application source, not runtime or user-provided
content. The complete selected profile is sent to the configured model on every
generation, so profiles must not contain credentials or other secrets.

## Failure handling

- An unknown named profile fails startup and lists the supported IDs.
- Omitting `PERSONA_PROFILE` selects `artemis`.
- If the Discord client never reports a display name, the system prompt falls
  back to the selected profile's `name` field as the default self-introduction name.

## Verification

- `test/config.test.ts` covers defaults, named selection, normalization, and
  unknown profiles.
- `test/pi-gateway.test.ts` proves profile composition preserves the fixed base,
  channel-limit, and capability sections, injects the Discord-resolved display
  name, falls back to the profile name, and rebuilds the cached prompt after
  `setBotDisplayName`.
- `test/discord-gateway.test.ts` proves the adapter resolves the display name on
  `ClientReady`, prefers the global display name, falls back to the username, and
  reports nothing when the Discord user is unavailable.
- `test/application.test.ts` proves the application wires the Discord display
  name into the PI gateway on ready.
- `npm run guardrail` remains the completion gate.

## References

- [Baseline design](baseline.md)
- [Clean-room rebuild guide](rebuild-guide.md)
- [Design document index](README.md)
