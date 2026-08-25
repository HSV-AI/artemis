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
- named `generic`, `artemis`, and `wartermis` profiles bundled with the application
- one dedicated source file for each bundled profile
- startup validation for named selection
- deterministic composition of the selected instructions with the fixed system prompt
- runtime resolution of the bot's Discord display name from the connected Discord client, used as the self-introduction name for the default `generic` profile

It does not change Discord authorization, tools, provider selection,
persistence, response delivery, or the default behavior outside the selected
persona's identity and style.

## Observable behavior

The default `generic` profile defines no fixed identity name. The bot's display
name is resolved from Discord at startup and used for self-introduction, so
asking the bot its name returns the Discord-configured name (for example KIPP)
rather than a name hardcoded in a profile. Selecting `artemis` restores the
original Artemis identity: the `artemis` profile owns its name and instructs
the model to introduce itself as Artemis regardless of the Discord display name.
Selecting `wartermis` gives every DM and guild generation the bundled Wartermis
identity, name, and style instructions. Slash commands do not invoke the model
and are unaffected. Profile changes become visible after rebuilding and
restarting Artemis.

## Configuration

`PERSONA_PROFILE` selects a bundled profile by case-insensitive ID and defaults to
`generic`. Supported IDs are `generic`, `artemis`, and `wartermis`; any other
value fails startup. Each profile is a record with `id`, `name`, and complete
`instructions` fields in its own file under `src/personas/`.
`persona-profiles.ts` only owns the registry and selection logic; it does not
contain profile instructions. The default `generic` profile's `name` is
intentionally blank so the live display name is read from Discord at startup;
a named profile's `name` is authoritative and is not overridden by the Discord
display name. The live display name is not configured through environment
variables; `DEFAULT_BOT_DISPLAY_NAME` (`Artemis`) is the application-defined
sensible fallback when neither a profile name nor a Discord display name is
available.

## Contracts and data flow

```text
PERSONA_PROFILE -> named profile registry -> selected profile record --+
Discord client ready -> bot display name (globalName ?? username) ------+|
conversation kind + registered tools ---------------------------------+-> composed PI system prompt
```

### Prompt composition

The application builds each system prompt in this order:

1. An identity block stating the bot's resolved name and instructing the model to introduce itself with that name when asked.
2. Complete identity instructions from the selected profile.
3. Fixed Discord speaker-handling rules.
4. Guild-only Discord channel limits when the conversation is a guild context.
5. Fixed Capability Gap Protocol and the generated Available Tools registry.

The profile owns style while application-owned behavioral instructions remain
fixed for every profile. Name resolution prefers a named profile's own `name`
(`artemis`, `wartermis`); when the selected profile defines no name (the
default `generic` profile), the runtime-resolved Discord display name is used;
when neither is available, `DEFAULT_BOT_DISPLAY_NAME` (`Artemis`) is the
sensible fallback. The system prompt never hardcodes the Discord name. The
resulting prompt remains deterministic from the conversation kind, profile
record, registered tool metadata, and the resolved display name. Both DM and
guild conversations receive the same selected persona and the same resolved name.

### Display name resolution

When the Discord client emits `ClientReady`, the Discord adapter resolves the
bot's display name from `client.user` (global display name when set, otherwise
username) and forwards it to the PI gateway via `setBotDisplayName`. The
gateway stores the name, clears its cached per-kind resource loaders, and
injects the name into the next system prompt built for a profile that does not
own its own name (the default `generic` profile). A named profile (`artemis`,
`wartermis`) keeps its own name and is unaffected by the Discord display name.
If the Discord user is unavailable, no name is forwarded and
`buildSystemPrompt` resolves the name from the selected profile's `name` field,
or `DEFAULT_BOT_DISPLAY_NAME` when that is also blank.

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
- Omitting `PERSONA_PROFILE` selects `generic`.
- If the selected profile defines a name (`artemis`, `wartermis`), that name is
  used for self-introduction regardless of the Discord display name.
- If the selected profile defines no name (`generic`) and the Discord client
  never reports a display name, the system prompt falls back to
  `DEFAULT_BOT_DISPLAY_NAME` (`Artemis`) as the default self-introduction name.

## Verification

- `test/config.test.ts` covers defaults, named selection, normalization, and
  unknown profiles.
- `test/pi-gateway.test.ts` proves profile composition preserves the fixed base,
  channel-limit, and capability sections, that a named persona wins over the
  Discord display name, that the generic profile injects the Discord-resolved
  display name, that the generic profile falls back to `DEFAULT_BOT_DISPLAY_NAME`
  when no Discord name is present, and that the cached prompt rebuilds after
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
