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

- a typed profile record containing an ID, display name, and model instructions
- named `artemis` and `wartermis` profiles bundled with the application
- one dedicated source file for each bundled profile
- startup validation for named selection
- deterministic composition of the selected instructions with the fixed system prompt

It does not change Discord authorization, tools, provider selection,
persistence, response delivery, or the default Artemis behavior.

## Observable behavior

The default `artemis` profile behaves exactly as before. Selecting `wartermis`
gives every DM and guild generation the bundled Wartermis identity and style
instructions. Slash commands do not invoke the model and are unaffected.
Profile changes become visible after rebuilding and restarting Artemis.

## Configuration

`PERSONA_PROFILE` selects a bundled profile by case-insensitive ID and defaults to
`artemis`. Supported IDs are `artemis` and `wartermis`; any other value fails
startup. Each profile is a record with `id`, `name`, and complete `instructions`
fields in its own file under `src/personas/`. `persona-profiles.ts` only owns the
registry and selection logic; it does not contain profile instructions.

## Contracts and data flow

```text
PERSONA_PROFILE -> named profile registry -> selected profile record --+
conversation kind + registered tools ----------------------------------+-> composed PI system prompt
```

### Prompt composition

The application builds each system prompt in this order:

1. Complete identity instructions from the selected profile.
2. Fixed Discord speaker-handling rules.
3. Guild-only Discord channel limits when the conversation is a guild context.
4. Fixed Capability Gap Protocol and the generated Available Tools registry.

The profile owns identity while application-owned behavioral instructions remain
fixed for every profile.
The resulting prompt remains deterministic from the conversation kind, profile
record, and registered tool metadata. Both DM and guild conversations receive the
same selected persona.

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

## Verification

- `test/config.test.ts` covers defaults, named selection, normalization, and
  unknown profiles.
- `test/pi-gateway.test.ts` proves profile composition preserves the fixed base,
  channel-limit, and capability sections.
- `npm run guardrail` remains the completion gate.

## References

- [Baseline design](baseline.md)
- [Clean-room rebuild guide](rebuild-guide.md)
- [Design document index](README.md)
