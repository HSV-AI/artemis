# Channel timezone tools

## Status

Implemented.

Source: [HSV-AI/artemis issue #50](https://github.com/HSV-AI/artemis/issues/50).

## Problem

Artemis had no notion of a channel's local time. Every timestamp the model saw
or produced was resolved by guesswork, and future scheduler tooling needs a
defined timezone per DM or Channel Group so recurring jobs are unambiguous.
The model also had no way to answer "what time is it here?" without inventing
a date. Timezone state must be persisted per conversation, stored as UTC
internally, and validated against real IANA identifiers — while the channel
identity itself must never be model-controlled.

## Scope

This protocol owns:

- the `set_channel_timezone` and `get_current_datetime` PI custom tools
- the `ChannelTimezoneStore` interface and its SQLite implementation
  (`channel_timezones` table, schema migration 6)
- timezone-identifier validation and DST-correct local-time rendering helpers
- the trust boundary that binds both tools to the harness-injected
  conversation key

It does not define the scheduler itself, change memory or other tool
contracts, or introduce deployment configuration.

## Observable behavior

Artemis registers `set_channel_timezone` and `get_current_datetime` for every
conversation kind (DM and guild) whenever a channel settings store is
configured.

`set_channel_timezone` takes one required `timezone` string. On a valid IANA
identifier it stores that identifier for the current conversation and answers:

```text
Channel timezone set to America/Chicago (UTC-05:00, CDT). Current local time: 2026-08-29T09:15:00-05:00 (Sat).
```

On a blank or invalid identifier it returns an error naming the offending
value and suggesting the `<Area>/<City>` form, and writes nothing:

```text
Error: "Not/AZone" is not a valid IANA timezone identifier. Use an identifier like America/Chicago, Europe/Berlin, or UTC.
```

`get_current_datetime` takes one optional `timezone` string. Without it, the
tool uses the conversation's stored timezone and falls back to UTC when none
is stored (or the stored value no longer resolves). With an explicit timezone,
that value takes precedence without touching the stored setting. Every answer
reports the same instant three ways:

```text
UTC now: 2026-08-29T14:15:00.000Z
Timezone: America/Chicago (UTC-05:00, CDT)
Local now: 2026-08-29T09:15:00-05:00 (Sat)
```

The local timestamp is offset-qualified ISO-8601; the summary line carries the
numeric UTC offset and zone abbreviation resolved for that exact instant, so
daylight saving time is handled by the runtime rather than fixed rules. Blank
or invalid explicit timezones return the same style of error as
`set_channel_timezone` without a failed-generation turn.

## Contracts and data flow

The harness builds the tool context from the immutable Discord conversation
key — `dm:<channel-id>` or `guild:<guild-id>:channel:<channel-id>` — and
injects it into the tools at generation time:

```text
PiGenerationInput.conversationKey (harness) ----> tool context
tool params.timezone (model) ------------------> validation -> store/rendering
ChannelTimezoneStore.getChannelTimezone(key) --> default view timezone
store.setChannelTimezone(key, id) ------------> one row per conversation key
```

Tool parameters never influence which conversation is read or written; the
parameter surface contains only the timezone. Validation uses
`Intl.DateTimeFormat` with the candidate as `timeZone`, so the full runtime
IANA database (including aliases and case variants) is accepted and anything
the runtime rejects is refused. Rendering is a pure function of an instant and
a timezone via `formatZonedInstant`, which yields the offset-qualified local
timestamp, numeric offset, zone abbreviation, and abbreviated weekday.

Times are stored and compared as UTC everywhere. Local renderings are
presentation only. Setting a timezone never stores a time; `get_current_datetime`
never writes. An unknown or removed timezone identifier in storage degrades to
a UTC rendering instead of failing the turn.

## Configuration

No new settings. The tools register whenever the repository-backed
`ChannelTimezoneStore` is wired into the PI gateway, which the application
composition does unconditionally; the gateway omits the tools only when no
store is provided (for example in narrow unit tests).

## Persistence

A `channel_timezones` SQLite table (schema migration 6) stores one row per
conversation key:

- `conversation_key`: primary key; the stable `dm:`/`guild:` conversation key.
- `timezone`: the stored IANA identifier text.
- `created_at`, `updated_at`: UTC ISO-8601 timestamps.

Writes are transactional upserts keyed on `conversation_key`, so one
conversation holds exactly one timezone and re-setting it overwrites in place.
A fresh empty database creates the table during bootstrap (migrations 1
through 6); a verified migration-5 database receives the table through
incremental migration 6 without touching its history. Settings survive
restarts, container recreation, and `/clear-session`; there is no expiration.

## Security and privacy

The DM or Channel Group identity is passed by the harness from derived Discord
context, never supplied by the model. No tool parameter can influence which
channel is read or written, so the model can neither set nor read the timezone
of a conversation it is not actually in — the same trust boundary the memory
tools apply to conversation scope. Tool output contains the channel's own
timezone, current clock, and nothing else: no identifiers, credentials, or
user content. Validation rejects malformed input before any string is echoed.
No network access or external data is involved, so no untrusted-content
sanitization applies.

## Failure handling

- Missing or blank `timezone` argument: error text describing the expected
  IANA form; no mutation.
- Invalid IANA identifier (set or explicit get): error text naming the
  identifier; no mutation and no generation failure.
- Stored timezone no longer valid at read time: `get_current_datetime` falls
  back to UTC rather than erroring.
- Store failures surface as normal tool errors following the PI
  generation-failure path.

## Verification

- `test/timezone-tools.test.ts` covers identifier validation (accepts IANA
  identifiers, aliases, case variants; rejects unknown, blank, and
  control-bearing input), both tools' success and error renderings, DST and
  winter offsets, stored-vs-explicit-timezone precedence, the UTC fallbacks
  for missing and invalid stored values, the missing-argument error, and the
  trust-boundary tests that model-supplied `channel` or `conversationKey`
  parameters are ignored in favor of the injected key.
- `test/repository.test.ts` covers storage, overwrite, persistence across a
  repository reopen, the fresh-database bootstrap including migration 6, and
  the incremental migration-6 path for a verified migration-5 database.
- `test/pi-gateway.test.ts` proves both tools are registered for a generation
  call, bound to the harness-injected conversation key, advertised in the
  system-prompt tool registry, and omitted when no store is configured.
- `npm run guardrail` remains the completion gate.

## References

- [Design document index](README.md)
- [Baseline design](baseline.md)
- [Clean-room rebuild guide](rebuild-guide.md)
- [Graph memory](memory.md)