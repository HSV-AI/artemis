# Scheduler execution engine

## Status

Implemented.

Source: [HSV-AI/artemis issue #53](https://github.com/HSV-AI/artemis/issues/53); invalid-response
correction retries from [issue #65](https://github.com/HSV-AI/artemis/issues/65).

## Problem

The scheduler tools ([issue #51](scheduler-tools.md)) let the model create, list, and
cancel durable prompt schedules, but nothing ever fired a stored job. Artemis needed
an execution engine that polls stored schedules, runs each due prompt through the
full Artemis agent inside the target DM or Channel Group's own session, validates the
agent's response as JSON before anyone sees it, and posts the result — or says
nothing on purpose. Without strict validation, untrusted agent output would flow
straight into a channel; without a correction path, a model that answers in prose
instead of the required JSON would waste the whole run; without durable fire
bookkeeping, restarts would re-fire or miss runs. And without reusing the fire-time
authorization gate from
[issue #52](scheduler-tools.md), a fired job would bypass the allow-list and
membership checks the interactive pipeline enforces.

## Scope

This protocol owns:

- the scheduler execution engine that polls stored jobs, consumes due occurrences,
  and submits every job through the fire-time authorization gate
  (`ConversationService.runScheduledPrompt`)
- the scheduler-fired prompt framing and its strict JSON response contract
- response validation (`message` posts, `silent` stays silent) before any posting,
  with correction prompts re-asking the agent when a reply is invalid
- the Discord delivery path for scheduler output (`sendToConversation`)
- the execution-store operations that cross conversations inside the process
  boundary (`listActiveScheduledPrompts`, `markScheduledPromptFired`,
  `completeScheduledPrompt`)
- the `scheduled_prompts` schema extension (migration 9): `last_run_at` and the
  `completed` status

It does not redefine the scheduler tools' parameters, validation, storage rules, or
the authorization they enforce at fire time ([Scheduler
tools](scheduler-tools.md) owns those), nor the PI harness or Discord adapter
behaviors beyond the new delivery method.

## Observable behavior

When Artemis starts (after Discord reports ready), the execution engine begins
polling the scheduled-prompt store on a fixed 30-second interval, with one immediate
poll to catch up on work missed while the process was down. Firing is gated on the
Discord gateway's ready handshake, not on a completed `login()`: ticks that arrive
before the handshake (or while it has not yet happened) are deferred without listing
or consuming, so a job's occurrence is never spent on a client that cannot yet resolve
its target channel — the ready handshake guarantees the client's guild and channel
caches are populated. Each poll lists every active job across conversations; for each
job it computes the occurrence the job is
due for, from the job's `last_run_at` (or `created_at` when it has never fired), and
fires the job when that occurrence is at or before the current time.

Firing consumes the occurrence first (one-time jobs are marked `completed`,
recurring jobs are re-armed via `last_run_at`) so a crash mid-turn can never
double-post. The engine then submits the consumed job to the fire-time authorization
gate, `ConversationService.runScheduledPrompt`: the gate re-applies the interactive
pipeline's authorization to the stored, harness-derived scope, re-checks live
membership where feasible, and — for allowed runs — generates inside the target DM
or Channel Group's durable native PI session with the full agent (every registered
custom tool, the conversation's regular system prompt) inside the same
per-conversation queue that serializes ordinary Discord messages. A scheduled turn
can never race a live user turn on the same session. The stored prompt reaches the
agent as the task; the gate wraps it in the engine's response-contract framing:

- the agent's entire final reply must be exactly one JSON object;
- `{ "type": "message", "content": "…" }` posts `content` to the target channel;
- `{ "type": "silent" }` completes the run and posts nothing.

The fire-time gate validates every generation attempt against this contract before
returning. One enclosing markdown code fence is tolerated (models emit ` ```json `
fences habitually); anything else — prose, partial JSON, arrays, null, unknown or
missing types, empty message content — is invalid. While the reply is invalid and
tries remain, the gate issues a **correction prompt** to the agent inside the same
durable session, so the model can see its own invalid reply and fix it. The
correction restates every valid option: exactly one JSON object, either
`{ "type": "message", "content": "…" }` (with a required non-empty string
`content`) or `{ "type": "silent" }` (no `content`), with no fences or commentary.
The agent gets at most **three tries** per fired occurrence — the original framed
turn plus at most two corrections; each attempt's assistant reply is persisted for
full history fidelity. A valid `silent` ends the run silently at any attempt, in the
normal and correction cases alike. After the third invalid try the gate returns the
final result untouched; the engine re-validates it, refuses to post anything that
fails, and finishes the run with no post — broken JSON never reaches a channel.

A valid `message` response is posted to the target channel through the same outbound
Discord path as ordinary answers (link-embed suppression, Discord-safe splitting at
2,000 characters) and pinned to the conversation; a valid `silent` response ends
silently. Delivery is at-most-once: the occurrence was already consumed, so a failed
delivery drops that run rather than retrying.

## Contracts and data flow

The engine is application-internal and can traverse conversation keys — a power the
model-facing tools never have. Authorization, however, always routes through the
same gate as interactive traffic:

```text
discordReady() gate (Discord gateway ready handshake) ---------------> defer whole ticks while not ready
repository.listActiveScheduledPrompts() (engine process boundary) ----> due jobs
dueOccurrence(job, now) from schedule + lastRunAt ?? createdAt -------> due check
markScheduledPromptFired / completeScheduledPrompt -------------------> consume occurrence
ConversationService.runScheduledPrompt(job) --------------------------> authorization gate
  checkScheduledPromptScope (pure allow-lists + attribution) ---------> scope decision
  ChannelMembershipChecker against live Discord state ----------------> membership decision
  KeyedSerialQueue on the conversation key ---------------------------> serialized turn
  PiGateway.generate( framing + stored prompt ) ----------------------> agent result (persisted)
  gate-side reply validation + correction prompts -------------------> up to 3 tries in the durable session
parseScheduledResponse(agent text) ------------------------------------> message | silent | invalid (engine re-validates before posting)
DiscordGateway.sendToConversation(identity, content) ------------------> Discord post
```

The gate binds every generation identity from harness-side state: the conversation
key parsed from the stored job, the conversation kind derived from that key, the
conversation's active session, and provenance `authorId` set to the job's stored
scheduling user with source message id `scheduled:<job id>:<run id>`. Nothing about
the target channel or the author is taken from model-controlled parameters. The
agent keeps its full system prompt (including the Available Tools registry and
Capability Gap Protocol) and full custom-tool access; only the user turn differs
from a normal Discord turn.

A recurring job's due occurrence is always resolved at evaluation time from the
stored wall-clock definition, so daylight saving time stays correct across fall-back
and spring-forward transitions. `last_run_at` is set to just after the fire instant
so the same occurrence can never become due twice. Occurrences missed while the
process was down deliberately collapse into a single late run; the engine never
backfills each missed occurrence.

## Configuration

No new settings. The engine polls every `SCHEDULER_POLL_INTERVAL_MS` = 30,000
milliseconds and is wired unconditionally by the application composition next to the
Discord gateway; it posts through the Discord gateway's channel resolution and stops
with the rest of the application on shutdown.

## Persistence

Migration 9 extends `scheduled_prompts` for the execution engine by rebuilding the
table in one transaction (SQLite cannot alter a CHECK constraint):

- `last_run_at`: nullable UTC timestamp, set just after each fire (a one-millisecond
  forward offset guards the at-or-after boundary semantics) and updated for every
  recurring run; the engine derives the next occurrence from `last_run_at` once it
  exists, so wall-clock resolution stays DST-correct.
- `status` gains `completed` alongside `active` and `cancelled`: a fired one-time job
  is retained for audit but never appears in active lists and never fires again.
- Migration 8's `scheduled_by_user_id` attribution is carried over verbatim; every
  existing row is preserved.
- The existing per-recurrence shape CHECK constraints are preserved verbatim.

A fresh empty database bootstraps to migration 9 in one transaction. A verified
migration-8 database receives the rebuild incrementally on its next startup; a
verified migration-5 database receives 6, 7, 8, and 9 in order; a verified
migration-7 database is first attributed by migration 8 (legacy rows backfilled
to an unattributed scheduler, which the gate refuses to run), then rebuilt by
migration 9. Cancelled jobs stay cancelled with
their rows intact; the engine never touches them.

A scheduler-fired run reuses the conversation's active durable session (creating
one when the conversation has none, for example after `/clear-session` or before the
first message). The gate persists the turn like any other exchange: one user row
carrying the raw stored prompt attributed to the scheduling user, and — after each
generation attempt — one assistant row containing that attempt's full reply plus
reasoning, diagnostics, and model. Correction retries add one user row per
correction (the correction framing, attributed to the scheduling user with a
`scheduled:<job id>:<run id>:correction-<n>` source message id) and one assistant
row per follow-up attempt, so history keeps full fidelity with what the model
actually received. Only parsed `message` content is posted
to Discord, so the channel sees only validated text.

## Security and privacy

The engine runs inside the process boundary and may read every conversation's jobs;
no model-facing surface gained any new identity parameter. The target channel is the
job's own `conversation_key` and nothing else; a stored prompt can never redirect a
run at another channel or user. No job generates before passing the fire-time
authorization gate — the same scope allow-lists and live membership re-check the
interactive pipeline applies — so a job whose scheduling user has lost access can
neither generate nor post. Response validation bounds what reaches Discord: only
JSON-conforming message content from the fire-time agent turn is posted, and
everything else is logged for operators instead. Scheduler runs carry the stored
scheduling-user attribution (with `scheduled:<job id>:<run id>` source message ids)
so memory facts derived from a schedule remain bound to the verified human who
scheduled them. Delivery is best-effort and at-most-once: failed or undeliverable
posts are logged with the conversation key and job id, never retried automatically,
and never sent anywhere else.

## Failure handling

- Authorization rejection (non-allowlisted channel, unauthorized DM user, revoked
  membership, missing or empty scheduling user, unparseable stored scope): the gate
  records `scheduled_prompt_rejected` and returns null; nothing is generated or
  posted; the occurrence is consumed so a permanently rejected job cannot
  retry-storm.
- Generation failure (provider, harness, or empty output): the gate records
  `scheduled_prompt_failed` and returns null; the engine posts nothing; the
  occurrence is consumed. Empty output is a generation failure, not a correction
  trigger; a correction turn that produces empty output fails the run the same way
  (already-issued corrections stay persisted for the audit history).
- Invalid agent JSON (including missing, unknown, or empty-message types, and any
  surrounding prose beyond one code fence): the gate persists the invalid reply,
  logs `scheduled_prompt_correction_issued` at warn level (with the attempt number
  and a bounded preview), and issues a correction prompt — up to two corrections
  after the original attempt. On exhaustion (three invalid tries) the gate returns
  the final result untouched; the engine logs `scheduled_prompt_invalid_response`
  (error) with a bounded response preview plus a durable event; nothing is posted;
  the occurrence is consumed.
- Delivery failure (channel fetch rejection, an unresolved channel, a non-sendable
  channel, or an SDK send error): `scheduler_channel_unavailable`,
  `scheduler_channel_unresolved`, or `discord_channel_not_sendable` logging from the
  gateway with the conversation key and channel id — an unresolved fetch (discord.js
  resolves to null instead of rejecting when the channel's guild is not cached, e.g.
  before the ready handshake) is logged as its own failure, never mislabeled as a
  not-sendable channel; surfaced by the engine as a `scheduled_prompt_failed` event.
  The occurrence is consumed.
- Discord not ready (gateway still connecting — login alone is not ready): the tick
  is deferred with `scheduler_deferred_not_ready` debug logging; jobs are neither
  listed nor consumed and the next tick fires them once the handshake completes.
- Unresolvable stored schedule: the job is skipped silently by due detection rather
  than failing the tick.
- Storage failure while consuming an occurrence (`scheduled_prompt_state_failed`):
  the job stays due and is retried on a later tick; nothing is posted.
- Poll-level persistence or listing failure (`scheduler_poll_failed`): logged; the
  next tick retries.
- Ticks that arrive while a poll is still running are skipped; long model calls
  delay later jobs to a subsequent tick rather than running them concurrently.

## Verification

- `test/scheduler-runner.test.ts` covers JSON validation (message, silent, fences,
  and every invalid shape), the fired-prompt framing, the three-attempt
  `SCHEDULER_RESPONSE_MAX_ATTEMPTS` bound and the correction framing (both valid
  shapes, the required `content` field, JSON-only output), due-occurrence resolution
  from creation and `last_run_at`, DST-correct weekly re-arms, missed-occurrence
  collapse, consumption before execution (at-most-once), message posting, silent
  completion, posting through `sendToConversation` with the parsed identity, the
  invalid-response and delivery-failure paths (the engine submits the job once and
  never retries it itself), unroutable keys, the start/stop
  interval lifecycle with in-flight tick skipping, deferral of whole ticks until the
  Discord readiness gate passes (nothing listed or consumed pre-ready, then the full
  chain fire → valid JSON → posted once ready), and unchanged firing when no gate is
  wired.
- `test/discord-gateway.test.ts` covers `sendToConversation`: suppression flags,
  per-channel embed allowlists, long-content splitting, non-sendable channels,
  unresolvable channels, a null channel resolution logged as
  `scheduler_channel_unresolved` (distinct from not-sendable), and readiness
  reporting via `isDiscordReady` from the ready handshake.
- `test/conversation-service.test.ts` covers the fire-time gate: scheduled runs
  resolve the conversation session and kind from the stored key, present the stored
  prompt inside the framing that carries the strict JSON contract, persist
  scheduler-attributed history and events, skip revoked members, enforce the
  channel and DM allow-lists before any membership lookup, refuse unparseable
  scopes and unattributed jobs, proceed logged-unverified on unreachable checks,
  serialize behind interactive traffic on the same conversation key, and record
  failures without posting. The correction-retry suite covers: one correction
  prompt issued on invalid JSON with the valid second attempt returned in the same
  durable session and scope; a valid `silent` accepted in the correction case; no
  correction when the first reply is already valid; exhaustion after three invalid
  tries (exactly two corrections, `responseAttempts: 3`, final result returned
  untouched for the engine to refuse); empty output remaining a generation failure
  without a correction; and a thrown correction retry returning null with
  `scheduled_prompt_failed` while the invalid attempt stays persisted.
- `test/repository.test.ts` covers the execution-store operations (cross-conversation
  listing, re-arm persistence across reopen, completion), the fresh-bootstrap schema
  including `last_run_at` and `scheduled_by_user_id`, the incremental
  migration-6-through-9 path, the additive migration-8 attribution upgrade, the
  migration-9 rebuild that preserves jobs and history from a migration-8 database,
  and deterministic creation-order listing (a `rowid` tiebreak keeps same-millisecond
  records in insertion order).
- `test/discord-gateway.test.ts` covers `sendToConversation`: suppression flags,
  per-channel embed allowlists, long-content splitting, non-sendable channels, and
  unresolvable channels.
- `test/application.test.ts` covers the scheduler's start/stop lifecycle within the
  application composition and the default wiring of the readiness gate: the
  composed engine defers polling until the Discord gateway reports ready and
  resumes once it does.
- `npm run guardrail` remains the completion gate.

## References

- [Design document index](README.md)
- [Baseline design](baseline.md)
- [Clean-room rebuild guide](rebuild-guide.md)
- [Scheduler tools](scheduler-tools.md) — stores the jobs this engine fires and
  defines the fire-time authorization gate every run passes through.
- [Channel timezone tools](timezone-tools.md) — shared UTC and wall-clock handling.
- [Discord link-embed suppression](discord-link-embeds.md) — applied to scheduler
  posts like every outbound message.
- [Native PI session persistence](pi-session-persistence.md) — the durable session
  the fired turn joins.