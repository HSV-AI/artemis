# Scheduler execution engine

## Status

Implemented.

Source: [HSV-AI/artemis issue #53](https://github.com/HSV-AI/artemis/issues/53);
invalid-response correction retries from
[issue #65](https://github.com/HSV-AI/artemis/issues/65); immediate on-demand
execution via `run_scheduled_task` follows
[issue #67](https://github.com/HSV-AI/artemis/issues/67); firing of the
optional cron schedule surface follows
[issue #73](https://github.com/HSV-AI/artemis/issues/73); the claim-and-
reconcile lifecycle replacing consume-before-gate follows
[issue #75](https://github.com/HSV-AI/artemis/issues/75); persisting the
engine's derived next occurrence on the record at claim time follows
[issue #74](https://github.com/HSV-AI/artemis/issues/74); decoupling the
on-demand path into a default preview (plain review turn, consumes and posts
nothing) with an explicit `consume_next=true` fire follows
[issue #76](https://github.com/HSV-AI/artemis/issues/76).

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

- the scheduler execution engine that polls stored jobs, atomically claims due
  occurrences in storage (claim-and-reconcile), and submits every claimed job
  through the fire-time authorization gate
  (`ConversationService.runScheduledPrompt`)
- the immediate on-demand execution path
  (`SchedulerRunner.runScheduledTaskPreview` as the default preview and
  `SchedulerRunner.runScheduledTaskNow` as the explicit fire, both through the
  inline gate of `ConversationService.runScheduledPromptInline` and the
  preview gate of `runScheduledPromptPreviewInline` respectively) behind the
  `run_scheduled_task` tool, including the recursion guard that keeps the
  tool out of scheduler-fired generations
- the scheduler-fired prompt framing and its strict JSON response contract
- response validation (`message` posts, `silent` stays silent) before any posting,
  with correction prompts re-asking the agent when a reply is invalid
- the Discord delivery path for scheduler output (`sendToConversation`)
- the execution-store operations that cross conversations inside the process
  boundary (`listActiveScheduledPrompts`, `claimScheduledPrompt`,
  `releaseScheduledPromptClaim`, `markScheduledPromptFired`,
  `completeScheduledPrompt`)
- the `scheduled_prompts` schema extensions for execution: migration 9's
  `last_run_at` and `completed` status, migration 10's `cron` schedule type,
  migration 11's `claimed_until` claim-deadline column, and migration 12's
  `next_run` persisted-occurrence column, written at every claim

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
or claiming, so a job's occurrence is never spent on a client that cannot yet resolve
its target channel — the ready handshake guarantees the client's guild and channel
caches are populated. Each poll lists every active job across conversations; for each
job it computes the occurrence the job is
due for, from the job's `last_run_at` (or `created_at` when it has never fired), and
fires the job when that occurrence is at or before the current time.

Firing is **claim-and-reconcile**, never consume-before-run. First the engine
claims the due occurrence atomically in storage
(`claimScheduledPrompt`): a single conditional UPDATE that succeeds only when the
job is `active` and its claim is absent or its `claimed_until` deadline has
passed. Only a claimed job runs the gate, so two pollers — or two overlapping
processes — can never both execute the same due occurrence, and the claim doubles
as accidental multi-instance insurance that previously only the in-process
`polling` boolean provided. A claim left behind by a crashed process simply
expires at its deadline (`SCHEDULER_CLAIM_TIMEOUT_MS`, ten minutes), making the
job reclaimable on a later tick instead of permanently lost.

The engine then submits the claimed job to the fire-time authorization gate,
`ConversationService.runScheduledPrompt`: the gate re-applies the interactive
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
silently. Delivery stays at-most-once in the normal path: an attempt posts once, and
only after a validated post (or a `silent` completion) is the claim settled. A denied,
failed, invalid, or undeliverable run releases its claim and fires again on a later
tick, so transient breakage can no longer permanently destroy a one-time job (the
pre-claim-and-reconcile engine consumed occurrences before the gate, which marked
denied one-time jobs `completed` forever). The known tradeoff: a run that crashes
after posting but before reconciling leaves its claim set, and once the claim expires
the job fires again — the crash-recovery edge is at-least-once, a deliberate exchange
so no crashed run is ever permanently lost.

Settling a recurring job also persists the engine's own next occurrence —
resolved from the re-armed basis (`last_run_at` plus one millisecond) through
the same DST-correct zone resolution — on the record's `next_run` column, so
the model-facing listing shows the occurrence the engine will actually honor
next (including a job that is due but not yet polled, whose stored snapshot
still names the pending occurrence instead of a fresh guess after now).
`next_run` is a display snapshot only: due detection always recomputes from
`last_run_at`/`created_at`, and the snapshot is rewritten at every claim so
daylight saving transitions stay correct. One-time jobs clear the snapshot
when they complete, and cancel, resume, and schedule updates maintain it
alongside their own writes (see [Scheduler tools](scheduler-tools.md)).

### On-demand execution (`run_scheduled_task`)

An interactive turn can also run a stored job immediately, in one of two
modes. The `run_scheduled_task` tool (issue #51's tool surface, wired in
[issue #67](https://github.com/HSV-AI/artemis/issues/67)) takes the job's
`id` plus an optional `consume_next` parameter (default `false`), locates the
record among its own conversation's history, and — for an `active` record —
hands it to the engine's immediate-run executor for the requested mode. Both
executors are wired into the PI gateway as the same lazily resolved
`ScheduledTaskRunner` (the engine is built after the gateway). Only `active`
records can run in either mode; the tool refuses canceled (pointing at
`update_scheduled_prompt`, which re-arms a canceled record through a new
schedule) and completed (retired history) records, and unknown or foreign ids
answer as not found, before either executor is invoked.

The **default is the preview** (`SchedulerRunner.runScheduledTaskPreview`):
the stored prompt runs as a plain preview turn through the fire-time gate and
the occurrence is never consumed or posted. Concretely:

1. Nothing is claimed or reconciled. The occurrence stays pending: a one-time
   task remains active and will fire at its scheduled time; a recurring
   task's next occurrence is unchanged. A preview therefore never interferes
   with lifecycle bookkeeping, and a crashed preview cannot block a due fire.
2. The gate runs as `ConversationService.runScheduledPromptPreviewInline`: the
   same scope allow-lists and live membership re-check as every scheduled
   run, followed by one plain generation of the stored prompt verbatim in the
   target conversation's durable session — no `buildSchedulerPrompt` framing,
   no strict JSON contract, no correction retries — flagged `scheduledRun` so
   the run tool is unavailable inside it (a preview cannot recurse) and
   persisted like any exchange (one user row attributed to the scheduling
   user, one assistant row). Like the fire path's inline variant, no queue
   wait: the tool executes inside the live turn that already holds the
   conversation's queue slot.
3. The response text is returned to the tool as a `previewed` result and
   echoed to the caller; nothing is delivered to any channel. The gate's
   events record the run with `trigger: on-demand` and `mode: preview`
   (`scheduled_prompt_succeeded`, or `scheduled_prompt_failed` when
   generation fails and `scheduled_prompt_rejected` when the gate denies), so
   preview runs are distinguishable in the audit trail without ever posting.

The explicit **fire** (`consume_next=true`) is the reversible default's
inverse: it mirrors a due-occurrence fire exactly, which is what makes a
preview request safe — nothing irreversible happens unless the user asks for
it.

1. The occurrence is claimed first with the identical `claim` path — so an
   on-demand fire and a pending due occurrence (or another instance's fire)
   can never double-run the same job. A record someone else holds a live
   claim on answers `not-run` without doing any work.
2. The gate runs as `ConversationService.runScheduledPromptInline`: the same
   scope allow-lists, the same live membership re-check, and the same
   generation and persistence in the target conversation's durable session —
   but without entering the per-conversation `KeyedSerialQueue`. The tool
   executes inside the live turn that already holds that queue slot for the
   same conversation (scope-checking guarantees the record's key is the
   current conversation), so re-queueing would deadlock the turn. The inline
   run is therefore serialized only by the live turn that carries it.
3. The response is validated and delivered by the engine's shared `deliver`
   path: `message` content posts through `sendToConversation`, `silent`
   posts nothing, invalid JSON posts nothing and records
   `scheduled_prompt_invalid_response`. The claim is then reconciled exactly
   like a scheduled fire: posted and silent outcomes settle the job (a
   one-time task completes and will not fire again; a recurring schedule
   re-arms at its next occurrence), while denied, failed, invalid, and
   undeliverable outcomes release the claim — the task remains scheduled and
   fires again on a later tick, and the tool says so instead of claiming the
   occurrence was consumed.

Every scheduler event carries a `trigger` field (`scheduled` for engine
fires, `on-demand` for tool runs) so operators can distinguish the two paths
in the audit log. The
run tool is only registered for interactive turns and only when the
composition wired the executors; scheduler-fired generations are flagged
`scheduledRun` on `PiGenerationInput` (preview generations included, set by
the conversation service) and the PI gateway omits `run_scheduled_task` from
them (with its own cached system prompt registry), so a fired task can never
trigger further runs — neither on-demand mode is reachable from scheduler-
fired turns, so scheduled execution never recurses.

## Contracts and data flow

The engine is application-internal and can traverse conversation keys — a power the
model-facing tools never have. Authorization, however, always routes through the
same gate as interactive traffic:

```text
discordReady() gate (Discord gateway ready handshake) ---------------> defer whole ticks while not ready
repository.listActiveScheduledPrompts() (engine process boundary) ----> due jobs
dueOccurrence(job, now) from schedule + lastRunAt ?? createdAt -------> due check (stored next_run is display-only)
repository.claimScheduledPrompt(id, deadline, now) (atomic) ----------> claim occurrence (one winner)
ConversationService.runScheduledPrompt(job) --------------------------> authorization gate
  checkScheduledPromptScope (pure allow-lists + attribution) ---------> scope decision
  ChannelMembershipChecker against live Discord state ----------------> membership decision
  KeyedSerialQueue on the conversation key ---------------------------> serialized turn
  PiGateway.generate( framing + stored prompt, scheduledRun=true ) ---> agent result (persisted, no run tool)
  gate-side reply validation + correction prompts -------------------> up to 3 tries in the durable session
parseScheduledResponse(agent text) ------------------------------------> message | silent | invalid (engine re-validates before posting)
DiscordGateway.sendToConversation(identity, content) ------------------> Discord post
claim reconcile: markScheduledPromptFired(id, fired, next) -----------> settled (posted | silent | unroutable);
                                       completeScheduledPrompt --------> next_run snapshot stored (recurring),
                                                                        cleared (one-time)
claim reconcile: releaseScheduledPromptClaim --------------------------> released (denied | failed | invalid | undelivered)

run_scheduled_task(id, consume_next=true) (interactive turn) ----------> conversation-scoped lookup (active only)
SchedulerRunner.runScheduledTaskNow(record) ---------------------------> claim + inline gate + shared deliver + reconcile
ConversationService.runScheduledPromptInline(record) ------------------> same gates, no queue wait (caller holds the slot)
run_scheduled_task(id) (preview default; consumes/posts nothing) -------> conversation-scoped lookup (active only)
SchedulerRunner.runScheduledTaskPreview(record) ------------------------> no claim + preview gate + response returned unposted
ConversationService.runScheduledPromptPreviewInline(record) ------------> same gates, plain prompt (no JSON contract), no queue wait
ScheduledTaskRunner (composition-wired lazy handle) -------------------> engine executor for the tool
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
and spring-forward transitions. This applies to every recurring shape: preset
jobs (`daily`, `weekly`, `monthly`) resolve their wall-clock time, and cron
jobs (`type: "cron"`) resolve the stored 5-field expression against the
calendar in the schedule's timezone with standard cron
day-of-month/day-of-week OR semantics through the same resolution helpers the
presets use. `last_run_at` is set to just after the fire instant so the same occurrence can
never become due twice, and the same re-armed basis resolves the occurrence
stored as the record's `next_run` snapshot. Occurrences missed while the
process was down deliberately collapse into a single late run; the engine never
backfills each missed occurrence. A recurring job whose run failed keeps its
occurrence due and retries on later ticks until a run succeeds (the missed
occurrence is still collapsed, so retries target the single most recent due
instant, and a one-time job likewise repeats until it fires).

## Configuration

No new settings. The engine polls every `SCHEDULER_POLL_INTERVAL_MS` = 30,000
milliseconds and claims due occurrences for
`SCHEDULER_CLAIM_TIMEOUT_MS` = 600,000 milliseconds (ten minutes) — long enough
to cover a full three-attempt generation with corrections and tool calls, short
enough that a crashed claim becomes reclaimable on a later tick. Both are fixed
constants: the claim only arbitrates races between overlapping engine
instances, and no deployment has needed to tune it. The engine is
wired unconditionally by the application composition next to the
Discord gateway; it posts through the Discord gateway's channel resolution and stops
with the rest of the application on shutdown. The composition also hands the
engine to the PI gateway as a lazily resolved `ScheduledTaskRunner`, which is
what makes the `run_scheduled_task` tool registerable; injected scheduler
stubs without the executor simply leave the tool unregistered.

## Persistence

Migration 9 extends `scheduled_prompts` for the execution engine by rebuilding the
table in one transaction (SQLite cannot alter a CHECK constraint):

- `last_run_at`: nullable UTC timestamp, set just after each successful fire (a
  one-millisecond forward offset guards the at-or-after boundary semantics) and
  updated for every recurring run; the engine derives the next occurrence from
  `last_run_at` once it exists, so wall-clock resolution stays DST-correct.
- `status` gains `completed` alongside `active` and `cancelled`: a settled one-time
  job
  is retained for audit but never appears in active lists and never fires again.
- Migration 8's `scheduled_by_user_id` attribution is carried over verbatim; every
  existing row is preserved.
- The existing per-recurrence shape CHECK constraints are preserved verbatim.

Migration 10 extends the same table with the optional strict cron schedule
surface (`cron_expression` plus the `cron` schedule type, locked by the
row-shape CHECK constraint), rebuilt in one transaction with every existing row
preserved verbatim; cron jobs fire through the same due-occurrence path.

Migration 11 replaces the engine's consume-before-run lifecycle with
claim-and-reconcile by adding `claimed_until`: a nullable UTC timestamp with no
CHECK-constraint change, so a plain `ALTER TABLE ... ADD COLUMN` applies
additively and preserves every existing row verbatim (unlike the migration 9
and 10 rebuilds). Rows written before migration 11 claim like unclaimed rows.
`claimed_until` is engine-internal bookkeeping only: it never appears on the
model-facing record surface or in scheduler tool listings, and resume clears it
alongside the cancel flag and fire marker so a re-armed record is immediately
claimable.

Migration 12 persists the engine's derived next occurrence on the record by
adding `next_run`: a nullable UTC timestamp with no CHECK-constraint change,
applied like migration 11 as a plain additive `ALTER TABLE` that preserves
every existing row verbatim. The engine writes it at every settle of a
recurring job (the occurrence resolved from the re-armed basis) and clears it
when a one-time job completes; creation, resume, and schedule updates write it
through the tool's own resolution (see [Scheduler
tools](scheduler-tools.md)). Pre-migration rows carry NULL until their next
claim, and listings fall back to recomputation for the legacy shape. The
snapshot is display data only — due detection always resolves from
`last_run_at` (or `created_at`) — so at-most-once semantics and DST-correct
wall-clock resolution are unchanged; the snapshot is simply rewritten at each
claim, keeping it truthful across transitions.

A fresh empty database bootstraps to the current schema in one transaction. A
verified migration-11 database receives migration 12's next-run column
incrementally on its next startup; a
verified migration-10 database receives migration 11's claim column
incrementally on its next startup and then the next-run column; a
verified migration-9 database receives the rebuild incrementally on its next startup and then
the cron columns, the claim column, and the next-run column; a verified
migration-5 database receives 6, 7, 8, 9, 10, 11, and 12 in order; a verified
migration-7 database is first attributed by migration 8 (legacy rows backfilled
to an unattributed scheduler, which the gate refuses to run), then rebuilt by
migration 9 and extended by migrations 10 through 12. Cancelled jobs stay cancelled with
their rows intact; the engine never touches them. Stored cron jobs fire
exactly like the preset recurring shapes: they appear in active listings,
re-arm via `last_run_at` with the snapshot rewritten, and never complete after
a fire.

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
neither generate nor post. The on-demand path inherits all of this: the tool's
lookup is scoped to the harness-injected conversation key (a foreign id is not
found, not run), the gate re-authorizes the stored scheduling user's live
membership before previewing or firing, and a run can never widen its
permissions beyond its own conversation. The default preview is lifecycle-
neutral by construction (no claim, no consumption, no posting), so a review
request can never spend a one-time job; only the explicit `consume_next=true`
fire consumes the occurrence. The `run_scheduled_task` tool is registered only for interactive
generations and only when the composition wired the executor; scheduler-fired
generations are flagged `scheduledRun` and never see the tool, so a fired task
cannot trigger further runs and on-demand execution cannot recurse. Response
validation bounds what reaches Discord: only
JSON-conforming message content from the fire-time agent turn is posted, and
everything else is logged for operators instead. Scheduler runs carry the stored
scheduling-user attribution (with `scheduled:<job id>:<run id>` source message ids)
so memory facts derived from a schedule remain bound to the verified human who
scheduled them. Delivery is best-effort and at-most-once in the normal path: a
validated response posts once, settled jobs never re-fire, and failed or
undeliverable posts are logged with the conversation key and job id and never
sent anywhere else — a released claim re-runs the whole occurrence, which makes
the deliberate retry surface explicit (see Failure handling) rather than a
silent delivery-path retry. The atomic claim means an on-demand run and a
due-occurrence fire of the same job can never double-run.

## Failure handling

The claim-and-reconcile reconcile rule is deliberate: **only a validated success
(a posted `message` or a completed `silent`) settles a claim** — one-time jobs
complete, recurring jobs re-arm via `last_run_at`. Everything else releases the
claim so the job fires again on a later tick. This fixes finding 1 (a denied or
failed one-time run is no longer marked `completed` and destroyed) and removes
the permanently-lost job class, at two documented costs: a job whose runs fail
persistently retries every poll (a retry storm until an operator cancels or
prunes it — every attempt is recorded in the durable scheduler events, denial
retries are cheap because the gate rejects before any generation, and there is
no automatic retry cap or backoff today), and a run that crashes after its post
but before its reconcile double-fires once the claim expires (at-least-once
recovery, never a lost job). Known permanent denials and permanent delivery
failures therefore storm at a bounded, logged rate instead of disappearing
silently; if that becomes operationally expensive, a retry cap or backoff is a
future extension behind this same contract.

- Authorization rejection (non-allowlisted channel, unauthorized DM user, revoked
  membership, missing or empty scheduling user, unparseable stored scope): the gate
  records `scheduled_prompt_rejected` (with the run's `trigger`) and returns null;
  nothing is generated or posted; the claim is released so the job can fire again
  when the blocking condition is fixed (the user rejoins the guild, the channel is
  allowlisted, or the record is cancelled by an operator).
- Generation failure (provider, harness, or empty output): the gate records
  `scheduled_prompt_failed` and returns null; the engine posts nothing; the claim
  is released. Empty output is a generation failure, not a correction
  trigger; a correction turn that produces empty output fails the run the same way
  (already-issued corrections stay persisted for the audit history).
- Invalid agent JSON (including missing, unknown, or empty-message types, and any
  surrounding prose beyond one code fence): the gate persists the invalid reply,
  logs `scheduled_prompt_correction_issued` at warn level (with the attempt number
  and a bounded preview), and issues a correction prompt — up to two corrections
  after the original attempt. On exhaustion (three invalid tries) the gate returns
  the final result untouched; the engine logs `scheduled_prompt_invalid_response`
  (error) with a bounded response preview plus a durable event; nothing is posted;
  the claim is released so the job can retry on a later tick.
- Delivery failure (channel fetch rejection, an unresolved channel, a non-sendable
  channel, or an SDK send error): `scheduler_channel_unavailable`,
  `scheduler_channel_unresolved`, or `discord_channel_not_sendable` logging from the
  gateway with the conversation key and channel id — an unresolved fetch (discord.js
  resolves to null instead of rejecting when the channel's guild is not cached, e.g.
  before the ready handshake) is logged as its own failure, never mislabeled as a
  not-sendable channel; surfaced by the engine as a `scheduled_prompt_failed` event
  and, on the on-demand path, as an `undelivered` outcome the tool reports. The claim
  is released, so the occurrence re-runs later instead of disappearing.
- Unroutable stored conversation key (unparseable scope at delivery time): logged as
  `scheduled_prompt_unroutable` and reported as `unroutable` on the on-demand path.
  This is structural damage no retry can fix, so the claim is settled — the
  occurrence is consumed without a post (one-time jobs complete, recurring jobs
  re-arm) to prevent an unfixable retry loop.
- On-demand run requested for an unknown, foreign, canceled, or completed record:
  the tool refuses with a descriptive error before either executor is invoked;
  nothing is claimed, generated, or consumed. A stale record slipping to a
  non-active status between lookup and run is refused by the executor itself
  (`scheduled_task_run_refused_inactive`) and reported as `not-run` — the fire
  executor then never claims the refused record, and the preview executor
  never claims at all, so its refusal leaves storage state untouched.
- On-demand preview whose gate denies the run or whose generation fails:
  reported as `not-run` with an answer stating nothing was run, posted, or
  consumed and the occurrence stays pending; the gate's rejection or failure
  event carries `trigger: on-demand` and `mode: preview`. A preview whose
  gate throws is logged and recorded by the preview executor the same way,
  with no claim to release and nothing to reconcile.
- On-demand fire (consume_next=true) while another engine holds a live claim
  on the same job: the claim
  fails and the executor answers `not-run` without doing any work.
- Discord not ready (gateway still connecting — login alone is not ready): the tick
  is deferred with `scheduler_deferred_not_ready` debug logging; jobs are neither
  listed nor claimed and the next tick fires them once the handshake completes.
- Unresolvable stored schedule: the job is skipped silently by due detection rather
  than failing the tick.
- Storage failure while claiming (`scheduled_prompt_state_failed`): the job stays
  due and is retried on a later tick; nothing is posted.
- Storage failure while releasing a claim (`scheduled_prompt_state_failed`): logged
  only; the run's outcome stands and the stale claim expires at its deadline, so
  the job self-heals.
- Storage failure while settling a claim (recording the fire or completion):
  `scheduled_prompt_state_failed` is logged; the posted message stands, and once
  the claim expires the occurrence fires again — the documented at-least-once
  crash edge, never a wedged job.
- Poll-level persistence or listing failure (`scheduler_poll_failed`): logged; the
  next tick retries.
- Ticks that arrive while a poll is still running are skipped; long model calls
  delay later jobs to a subsequent tick rather than running them concurrently.

## Verification

- `test/scheduler-runner.test.ts` covers JSON validation (message, silent, fences,
  and every invalid shape), the fired-prompt framing, the three-attempt
  `SCHEDULER_RESPONSE_MAX_ATTEMPTS` bound and the correction framing (both valid
  shapes, the required `content` field, JSON-only output), due-occurrence resolution
  from creation and `last_run_at` for every schedule shape including cron
  (weekday windows, re-arm from `last_run_at` to the next weekday occurrence),
  DST-correct weekly re-arms, missed-occurrence collapse, due detection
  ignoring the stored next-run snapshot, claiming-before-gate
  ordering with the fixed `SCHEDULER_CLAIM_TIMEOUT_MS` deadline, the finding-1
  regression (a denied or failed gate leaves a one-time job claimable — not
  `completed` — and it fires again on a later tick, then settles exactly once on
  success), recurring re-arm on success without double-fires (persisting the
  engine's derived next occurrence as the record's snapshot on daily, cron,
  and on-demand paths alike; one-time completions carry no next-run argument;
  an end-to-end fire against a real repository lists the persisted snapshot),
  release-on-failure
  for denied, invalid-response, and delivery-failure outcomes (with the retry
  visible on the next tick), self-healing release and settle storage failures,
  message posting, silent
  completion, posting through `sendToConversation` with the parsed identity,
  unroutable keys (settled, not released), two concurrent pollers sharing a real
  SQLite store firing one due job exactly once, a fired job whose claim was left
  behind by a crashed run becoming reclaimable after its deadline, the start/stop
  interval lifecycle with in-flight tick skipping, deferral of whole ticks until the
  Discord readiness gate passes (nothing listed or claimed pre-ready, then the full
  chain claim → fire → valid JSON → posted once ready), unchanged firing when no gate is
  wired, and the on-demand executors: `runScheduledTaskNow` (claim-then-gate
  ordering with the identical reconcile semantics, posted/silent/
  invalid-response/unroutable/undelivered/not-run outcomes with their events and logs,
  inactive-record refusal, claim-contention refusal, storage-failure and gate-throw
  handling without
  rejecting, and the engine's queued fire path staying on `runScheduledPrompt`)
  and `runScheduledTaskPreview` (no claim, no consumption, no posting, no
  dispatcher call; a `previewed` result carrying the gate's plain response,
  `not-run` on denial / failure / gate-throw with no lifecycle mutation, and an
  inactive-record refusal without calling the preview gate).
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
  `scheduled_prompt_failed` while the invalid attempt stays persisted. The inline
  variant (`runScheduledPromptInline`) applies the same gates without queueing,
  completes while an interactive turn holds the conversation queue, flags its
  generation `scheduledRun`, and events carry the `trigger` (`scheduled` for
  engine fires, `on-demand` for tool runs). The preview variant
  (`runScheduledPromptPreviewInline`) applies the same gate without queueing,
  generates the stored prompt verbatim with `scheduledRun: true` (no JSON
  framing, no correction retries), persists the turn attributed to the
  scheduling user, refuses members the gate revokes without generating,
  proceeds logged-unverified on unreachable checks, and records
  `scheduled_prompt_succeeded` with `mode: preview` or
  `scheduled_prompt_failed` on generation failures without posting anything.
- `test/repository.test.ts` covers the execution-store operations (cross-conversation
  listing, atomic claiming — one winner per due job, expired-claim reclaim,
  active-only eligibility, release returning a job to the claimable pool,
  claim persistence across reopen, resume clearing a stale claim, re-arm
  persistence across reopen, completion), the fresh-bootstrap schema
  including `last_run_at`, `scheduled_by_user_id`, `cron_expression`,
  `claimed_until`, and `next_run` across migrations 1 through 12, the
  incremental migration-6-through-12 path, the additive migration-8 attribution
  upgrade, the migration-9 rebuild that preserves jobs and history from a
  migration-8 database, the migration-10 rebuild that adds the cron columns
  while preserving every job, the additive migration-11 claim column that
  upgrades a migration-10 database without a rebuild, the additive
  migration-12 next-run column that upgrades a migration-11 database without
  a rebuild, and deterministic
  creation-order listing (a
  `rowid` tiebreak keeps same-millisecond
  records in insertion order).
- `test/discord-gateway.test.ts` covers `sendToConversation`: suppression flags,
  per-channel embed allowlists, long-content splitting, non-sendable channels, and
  unresolvable channels.
- `test/application.test.ts` covers the scheduler's start/stop lifecycle within the
  application composition and the default wiring of the readiness gate: the
  composed engine defers polling until the Discord gateway reports ready and
  resumes once it does. `test/pi-gateway.test.ts` covers the on-demand wiring:
  `run_scheduled_task` registers only when a `ScheduledTaskRunner` resolves, its
  execution delegates by mode — the default call to the preview executor and a
  `consume_next=true` call to the fire executor — scheduler-fired generations
  (`scheduledRun`) omit the tool and cache their own reduced prompt registry, and
  the management tools stay registered when no executor is wired.
- `test/scheduler-tools.test.ts` covers `run_scheduled_task`'s outcome reporting
  across both modes: the default call previews (echoing the response with
  explicit nothing-posted and left-pending notes for one-time and recurring
  schedules, invoking only the preview executor), while `consume_next=true`
  fires under the claim-and-reconcile lifecycle — posted and silent runs keep
  the completion note (one-time completed, recurring schedule continues),
  invalid-response, undelivered, and not-run answers state that the task was not
  consumed, its claim was released, and it remains scheduled to fire again; the
  unroutable outcome reports an unresolvable stored key and states the
  occurrence was consumed; and unknown, foreign, canceled, and completed ids
  are refused before either executor runs.
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