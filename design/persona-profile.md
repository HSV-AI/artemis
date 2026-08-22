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
- optional persona instructions loaded from an operator-owned local file
- startup validation for named and file-based selection
- deterministic composition of the selected instructions with the fixed system prompt

It does not change Discord authorization, tools, provider selection,
persistence, response delivery, or the default Artemis behavior.

## Observable behavior

The default `artemis` profile behaves exactly as before. Selecting `wartermis`
omits the built-in Artemis identity and gives every DM and guild generation the
bundled Wartermis identity and style instructions. A file override behaves the
same way with operator-provided instructions. Slash commands do not invoke the
model and are unaffected. Profile changes become visible after restart.

## Configuration

`PERSONA_PROFILE` selects a bundled profile by case-insensitive ID and defaults to
`artemis`. Supported IDs are `artemis` and `wartermis`; any other value fails
startup. Each profile is a record with `id`, `name`, and `instructions` fields.

`PERSONA_PATH` is an optional runtime path to a UTF-8 text or Markdown file. A
selected file is trimmed, must contain nonblank text, and becomes a profile record
with ID `override`. It takes precedence over `PERSONA_PROFILE`. Changing either
setting or file contents requires an application restart because PI resource
loaders are cached for the life of the process.

## Contracts and data flow

```text
PERSONA_PROFILE -> named profile registry --+
                                             +-> selected profile record
PERSONA_PATH ----> startup file loader ------+          |
conversation kind + registered tools ------------------+-> composed PI system prompt
```

### Prompt composition

The application builds each system prompt in this order:

1. Built-in Artemis identity for the `artemis` profile, or a generic assistant
   identity when the selected profile has nonblank instructions.
2. Fixed Discord speaker-handling rules.
3. Optional `## Persona Profile` section containing the selected profile's
   instructions after surrounding whitespace is trimmed.
4. Guild-only Discord channel limits when the conversation is a guild context.
5. Fixed Capability Gap Protocol and the generated Available Tools registry.

The profile replaces only the built-in Artemis identity and supplements rather
than replaces application-owned behavioral instructions.
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

Persona files are trusted operator configuration, not user-provided content.
Operators must not point `PERSONA_PATH` at a user-writable file. The complete
profile is sent to the configured model on every generation, so it must not
contain credentials or other secrets.

## Failure handling

- An unknown named profile fails startup and lists the supported IDs.
- An unreadable selected file fails startup and reports `PERSONA_PATH` plus the
  filesystem error without exposing file contents.
- An empty or whitespace-only selected file fails startup.
- Omitting both settings selects `artemis` and preserves the built-in prompt.

## Verification

- `test/config.test.ts` covers defaults, named selection, override precedence,
  trimming, unknown profiles, unreadable files, and blank files.
- `test/pi-gateway.test.ts` proves profile composition preserves the fixed base,
  channel-limit, and capability sections.
- `npm run guardrail` remains the completion gate.

## References

- [Baseline design](baseline.md)
- [Clean-room rebuild guide](rebuild-guide.md)
- [Design document index](README.md)
