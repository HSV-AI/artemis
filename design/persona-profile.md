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

- optional persona text loaded from an operator-owned local file
- startup validation for the selected file
- deterministic composition of that text with the fixed system prompt
- deployment ownership of concrete bot identities and styles

It does not change Discord authorization, tools, provider selection,
persistence, response delivery, or the default Artemis behavior.

## Observable behavior

With no profile selected, Artemis behaves exactly as before. With a profile
selected, the built-in Artemis identity is omitted and every DM and guild
generation receives the same variant identity and style instructions. Slash
commands do not invoke the model and are unaffected. Profile changes become
visible after the application restarts.

## Configuration

`PERSONA_PATH` is an optional runtime path to a UTF-8 text or Markdown file. An
absent or blank setting selects no persona and preserves the existing prompt. A
selected file is trimmed and must contain nonblank text. Changing its contents
requires an application restart because PI resource loaders are cached for the
life of the process.

Upstream Artemis does not ship a concrete alternate persona. Deployment
repositories own profiles and mount them read-only through Compose or their
runtime configuration mechanism.

## Contracts and data flow

```text
PERSONA_PATH -> startup file loader -> trimmed persona text
                                            |
conversation kind + registered tools ------+-> composed PI system prompt
```

### Prompt composition

The application builds each system prompt in this order:

1. Built-in Artemis identity when no profile is selected, or a generic assistant
   identity when a variant is selected.
2. Fixed Discord speaker-handling rules.
3. Optional `## Persona Profile` section containing the selected file verbatim
   after surrounding whitespace is trimmed.
4. Guild-only Discord channel limits when the conversation is a guild context.
5. Fixed Capability Gap Protocol and the generated Available Tools registry.

The profile replaces only the built-in Artemis identity and supplements rather
than replaces application-owned behavioral instructions.
The resulting prompt remains deterministic from the conversation kind, persona
text, and registered tool metadata. Both DM and guild conversations receive the
same selected persona.

## Persistence

Persona text is not written to SQLite and requires no schema change. It is held
in process memory as configuration and applied when PI reconstructs a session.
After a restart, existing conversations therefore use the profile selected by
the new process without changing their stored message history.

## Security and privacy

Persona files are trusted operator configuration, not user-provided content.
Operators must not point `PERSONA_PATH` at a user-writable file. The complete
profile is sent to the configured model on every generation, so it must not
contain credentials or other secrets.

## Failure handling

- An unreadable selected file fails startup and reports `PERSONA_PATH` plus the
  filesystem error without exposing file contents.
- An empty or whitespace-only selected file fails startup.
- Omitting `PERSONA_PATH` preserves the built-in Artemis prompt.

## Verification

- `test/config.test.ts` covers omission, trimming, unreadable files, and blank
  files.
- `test/pi-gateway.test.ts` proves profile composition preserves the fixed base,
  channel-limit, and capability sections.
- `npm run guardrail` remains the completion gate.

## References

- [Baseline design](baseline.md)
- [Clean-room rebuild guide](rebuild-guide.md)
- [Design document index](README.md)
