# Artemis clean-room rebuild guide

## Purpose

This guide is sufficient for a coding agent to rebuild Artemis without reading the existing application source. It describes the behavior that must remain compatible and the implementation seams that may change.

The replacement may use a different programming language, Discord library, conversational harness, or OpenAI-compatible model client. Those choices are compatible only when the observable Discord behavior, conversation isolation, persistence, logging, failure handling, and local operating workflow in this guide remain intact.

Treat statements using **must** as compatibility requirements. Examples and technology suggestions are non-normative unless explicitly labeled otherwise.

## Compatibility boundary

The following behavior is fixed:

- Artemis connects to Discord, registers global `/ping`, `/uptime`, and `/clear-session` commands, receives direct messages, and receives messages from channels across any guild the bot has joined.
- `DISCORD_ALLOWED_CHANNEL_ID` and `DISCORD_ALLOWED_USER_ID` are comma-separated allowlists. Blank or absent lists are valid and match nothing. Values are trimmed and duplicates are removed.
- DMs are accepted only from users in the user allowlist. They do not require a mention or channel allowlist entry.
- Guild conversations are accepted from any user in an allowed channel when the triggering message directly mentions the Artemis bot user, mentions its Discord-managed bot role, or replies directly to an Artemis-authored message. The user allowlist does not apply to guild conversations.
- Guild threads inherit authorization and conversation identity from their parent channel. Each accepted thread reply submits the entire ordered thread, including the new message, as the current prompt.
- `/ping` in a DM requires an allowed user. `/ping` in a guild requires an allowed channel but does not require an allowed user or mention. An accepted ping responds with exactly `pong` and does not access conversation persistence or the model.
- `/uptime` uses the same authorization policy and reports elapsed time since the current process started without accessing conversation persistence or the model.
- `/clear-session` uses the same authorization policy. It closes the active logical session for the DM or parent guild channel, retains archived messages, and causes the next accepted message to start with empty model history.
- Every Discord message event is logged to the console and SQLite before filtering, including DMs, bot messages, unauthorized messages, unmentioned messages, and messages from disallowed channels.
- Accepted conversations retain their history in SQLite across restarts. There is no automatic retention or deletion.
- Model or harness failures are logged and persisted, but produce no Discord response.
- The model may use explicitly registered custom tools: `web_fetch`, six GitHub tools when a token is configured, nine conversation-scoped Dgraph memory tools, and the read-only `hsvai_graph_search` and `hsvai_graph_query` tools backed by the fixed Huntsville AI source. Events expose source-matched `research`, `building`, or `community` themes and first-class speaker edges from the reviewed event catalog; presenters and discussion facilitators share that role, and reviewed speakerless events may use the `No Speaker` sentinel. Stale events are marked pending. The query tool accepts arbitrary DQL but is bound by a Dgraph JWT to the public namespace and invokes only the read-only query endpoint. Each model turn receives the current corpus revision, and both HSVAI tools label results with that revision. Matching historical results remain reusable; unlabeled or mismatched results require a new query. External content is labeled and sanitized as untrusted data before reaching the model. No built-in coding tools are enabled. The system prompt advertises the actual registry and includes the Capability Gap Protocol for unavailable tools.
- Accepted normal messages show a typing indicator throughout generation. Guild and guild-thread answers reply to the triggering message; DM answers remain ordinary channel messages.
- Group/channel (guild) assistant responses are capped at `GROUP_CHANNEL_MULTI_MESSAGE_MAX` (currently 3) self-contained Discord messages per turn. DM responses are not length-restricted. The cap is conveyed to the model through the system prompt only for guild sessions, and prompt selection is deterministic from the conversation kind (`guild` vs `dm`).
- Base Compose retains Ollama as a separate service, the model-preparation job, persistent ACL-enabled Dgraph, a one-shot namespace bootstrap, and Artemis. An optional provider-specific Compose path may omit Ollama while retaining Dgraph and its bootstrap.
- Startup loads a checked-in HSVAI event-catalog baseline plus an optional durable runtime overlay but never calls the model for catalog enrichment. `npm run catalog:hsvai-events` is an explicit maintenance-window operator task that enriches new or changed events through the configured provider, atomically writes the overlay, and resynchronizes Dgraph.

The following may be replaced:

- Programming language and application framework.
- Discord SDK.
- Conversational harness, including replacing PI.
- OpenAI-compatible SDK or HTTP client.
- SQLite driver and migration library.
- Dependency injection, module layout, and internal type system.

## Reference architecture

```mermaid
flowchart LR
    Discord[Discord gateway] --> Normalize[Event normalizer]
    Normalize --> Audit[Audit logger]
    Audit --> Route{Command or message?}
    Route -->|slash command| Commands[Command authorization and dispatch]
    Route -->|message| Policy[Conversation policy]
    Policy --> Sessions[Conversation coordinator]
    Sessions --> Store[(SQLite)]
    Sessions --> Harness[Harness adapter]
    Harness --> Model[Model adapter]
    Harness --> WebFetch[web_fetch tool]
    Harness --> GitHubTools[Token-gated GitHub tools]
    Harness --> MemoryTools[Memory tools]
    Harness --> KnowledgeTools[HSVAI search and DQL]
    WebFetch --> Web[HTTP or HTTPS page]
    GitHubTools --> GitHubAPI[GitHub API]
    MemoryTools --> Dgraph[(Dgraph facts)]
    KnowledgeTools --> Dgraph
    Model --> Provider[Configured OpenAI-compatible endpoint]
    Commands -- clear-session only --> Store
    Commands --> Discord
    Sessions --> Discord
    Audit --> Console[Standard output]
    Audit --> Store
```

Keep the core policy independent from external SDK objects. Discord events should be normalized at the adapter boundary, and model-specific responses should be normalized at the harness boundary.

## Observable Discord behavior

### Decision table

| Input | Conditions | Result |
| --- | --- | --- |
| DM `/ping` | Author is allowed | Reply exactly `pong`. |
| DM `/ping` | Author is not allowed, including an empty allowlist | Do nothing. |
| Guild `/ping` | Channel or thread parent is allowed | Reply exactly `pong`, regardless of user allowlist. |
| Guild `/ping` | Channel or thread parent is not allowed | Do nothing. |
| DM or guild `/uptime` | Same authorization as `/ping` | Reply `I've been up <duration>.` without persistence or model access. |
| DM or guild `/clear-session` | Same authorization as `/ping` | Close the active session for that conversation and confirm the outcome; retain archived history. |
| Normal DM | Non-bot author is allowed and content is nonblank | Continue the DM conversation without requiring a mention. |
| Normal DM | Author is not allowed, author is a bot, or content is blank | Do nothing. |
| Normal guild message | Parent channel is allowed, author is not a bot, content is nonblank, and Artemis is directly mentioned or directly replied to | Continue that guild-channel conversation. |
| Normal guild message | Any required condition is false | Do nothing. |
| Model or harness failure | Message otherwise passed policy | Log and persist the failure; send nothing to Discord. |

“Do nothing” means no Discord response and no model invocation. A received-message audit record is still required because it is written before filtering.

### Mention rules

A guild message counts as mentioning Artemis only when either of these is present in the triggering message's parsed mention metadata:

- The bot user's Discord ID.
- A role whose Discord metadata identifies that role as managed by the bot user's ID.

The following must not count as a mention or qualifying reply:

- `@everyone` or `@here`.
- An unrelated user or role.
- Plain text containing the bot's name.
- A reply to a message whose author is not Artemis.

Do not detect mentions or replies with string matching alone. Use the Discord SDK's structured user and role mention data, including the replied-to user ID.

### Responses

Normal assistant output is sent in the same DM, channel, or thread that triggered generation. Guild and guild-thread chunks are Discord replies to the triggering message so the answered question is explicit. DM chunks remain ordinary channel messages.

After a normal message passes all authorization and duplicate checks, send a typing indicator immediately and refresh it every five seconds while generation is active, safely inside Discord's expiry window. Keep the heartbeat active until success or failure, then stop it. Ignored and duplicate messages must never show typing. A typing-indicator API failure is logged but does not prevent generation.

Discord limits message content to 2,000 characters. Split longer responses into ordered chunks, preferring a newline or space in the latter half of each chunk. Persist the assistant response as one logical message even when Discord receives multiple chunks.

The 2,000-character split is a transport concern. Separately, group/channel (guild) responses are capped at `GROUP_CHANNEL_MULTI_MESSAGE_MAX` (currently 3) discrete Discord messages per assistant turn. This is a model-facing instruction, not a post-hoc truncation: the system prompt told the model the cap and that each message must be a complete, self-contained thought with no sentence split across messages. Direct-message responses are not subject to any message-count or response-length instruction. The channel-limit instruction is presented to the model only for guild sessions; DM sessions must never see limit messaging. Selection is deterministic from the conversation kind, so the prompt a session receives is fixed by its conversation key rather than by runtime state. The harness must build its system prompt per conversation kind and must not concatenate a single static prompt across both kinds.

### Link-embed suppression

By default, every outbound Discord message Artemis sends — normal chat responses, chunked responses, and slash-command replies — must be sent with the `SuppressEmbeds` message flag so Discord does not render link-preview cards. Suppression is enforced by the Discord adapter when it builds the outgoing payload, never by the model, the harness, or the system prompt. `DISCORD_SUPPRESS_EMBEDS` defaults to `true`; setting it to `false` re-enables embeds globally. `DISCORD_EMBEDS_ALLOWED_CHANNEL_ID` is a comma-separated list of channel IDs where embeds are re-enabled even when global suppression is on; a guild thread resolves the override through its parent channel. The override is strictly re-enabling and never adds suppression when the global switch is off. See [Discord link-embed suppression](discord-link-embeds.md).

### Raw message audit

Before any normalization or filter, emit a structured `discord_message_received` event containing:

- Discord message ID.
- Guild ID or null for a DM.
- Channel ID.
- Thread ID when applicable.
- Author ID and display name.
- Whether the author is a bot.
- Raw message content.
- Discord creation time.

This event bypasses the configured log-level threshold. It must be written to standard output and, when the database is available, to the application log table. After normalization but before conversation filtering, also write one deduplicated `incoming_messages` row containing the fields above plus parent-channel identity and the normalized `mentions_bot` and `replies_to_bot` flags.

## Normalized contracts

Use equivalent records in the chosen language. Field names may differ internally, but adapters should preserve all values.

### Inbound message

```text
InboundMessage
  discord_message_id: string
  guild_id: string or absent
  channel_id: string
  parent_channel_id: string or absent
  thread_id: string or absent
  author_id: string
  author_name: string
  author_is_bot: boolean
  content: string
  created_at: ISO-8601 timestamp
  mentions_bot: boolean
  replies_to_bot: boolean
  load_entire_thread: optional async operation returning SourceMessage[]
```

### Source and stored messages

```text
SourceMessage
  discord_message_id: string
  thread_id: string or absent
  role: user or assistant
  author_id: string
  author_name: string
  content: string
  created_at: ISO-8601 timestamp

StoredMessage extends SourceMessage
  local_message_id: integer
  logical_session_id: string
  reasoning: string or absent
  diagnostics: structured value or absent
  model: string or absent
```

### Harness port

```text
health_check() -> success or error

generate(
  logical_session_id,
  stable_conversation_key,
  triggering_discord_message_id,
  triggering_discord_author_id,
  current_prompt
) -> {
  text,
  reasoning optional,
  diagnostics optional,
  model
}
```

The core application must depend only on this port. A harness error, aborted generation, missing final assistant message, or blank assistant text is a failed generation.

## Conversation identity and ordering

Conversation identity is stable and derived only from immutable Discord IDs:

- DM: `dm:<dm-channel-id>`
- Guild channel: `guild:<guild-id>:channel:<channel-id>`
- Guild thread: use the guild key for the thread's parent channel, not the thread ID.

Human-readable guild, channel, or user names are metadata and must never be used as identity keys.

Serialize generation per conversation key. Two messages in the same conversation must never race while reading history or writing a turn. Messages from different conversation keys may run concurrently.

Use the Discord message ID as an idempotency key. A redelivered event must not invoke the model twice or create a duplicate source-message record.

## Thread prompt contract

For an accepted message in a thread:

1. Fetch the starter message when available.
2. Fetch every thread message, paging until no pages remain.
3. Deduplicate by Discord message ID.
4. Ensure the triggering message is present even if Discord's fetch result omitted it.
5. Sort from oldest to newest using Discord creation time.
6. Persist previously unseen source messages.
7. Build the current prompt from the entire ordered snapshot.

Use this semantic prompt format, matching the current JSON model-context boundary. Prefix the JSON with `The following JSON contains the complete Discord thread. Respond to the newest message in context.`, followed by a blank line:

```json
{"discordThread":[{"id":"<Discord message ID>","author":{"id":"<Discord user ID>","name":"<display name>"},"role":"user","content":"<message text>","timestamp":"<ISO-8601 timestamp>"}]}
```

The array contains one object per message in oldest-to-newest order. Preserve message ID, author ID, author display name, role, content, and timestamp; normalize blank author IDs or names to `unknown`. A non-thread prompt uses the same object shape under a `discordMessage` key. In a guild thread, any user's new message may trigger generation when the parent channel is allowed and Artemis is directly mentioned or directly replied to.

## Model and harness behavior

### Harness-independent requirements

The model-facing implementation must:

- Use the configured model rather than hard-coding a conditional model choice.
- Apply a provider definition's explicit reasoning effort to every model request when configured.
- Restore the native harness state for the logical session directly from durable SQLite entries.
- Supply the current normal message as the new prompt, or the formatted thread snapshot for a thread message.
- Enable only `web_fetch`, the six GitHub custom tools when configured, the nine scoped memory tools, and the fixed-source `hsvai_graph_search` and `hsvai_graph_query` tools. Disable built-in read, write, edit, shell, filesystem-search, skills, prompt templates, repository context, and all other agentic extensions.
- Apply the complete identity instructions from the profile selected by `PERSONA_PROFILE`, which defaults to `artemis` and includes `wartermis` as a bundled alternative. Keep each profile in its own source file and compose the fixed Discord instruction after it. The instruction is conversation-kind-aware: guild sessions additionally include the Discord Channel Limits block (`GROUP_CHANNEL_MULTI_MESSAGE_MAX`, self-contained-thought rule); DM sessions never include it. It must also include the Capability Gap Protocol and an Available Tools section generated from the registered custom tools. Prompt construction must be a pure function of the conversation kind, selected profile, and tool registry.
- Under the Capability Gap Protocol, tell Artemis to acknowledge an unavailable capability, stop instead of exploring source or improvising code, and request the missing capability as an issue in `HSV-AI/artemis` through `github_create` when available.
- Return final assistant text separately from optional reasoning and diagnostics.
- Treat aborted, errored, absent, and blank final responses as failures.

### Replacing PI with another harness

Implement the harness port above and keep all harness objects outside the conversation coordinator.

Use a durable harness-session strategy. Store the harness's native ordered entries beside the logical session, restore them directly on every turn and restart, and verify the session ID belongs to the selected conversation. The normalized application transcript remains available for Discord deduplication and auditing but is not replayed as the model-context authority.

For PI compatibility, preserve the session header plus message, tool-result, model-change, thinking-level, compaction, branch-summary, custom, label, and session-info entry types with their native IDs, parent IDs, timestamps, payloads, and usage. If another harness uses a different native format, persist enough lossless state to reproduce the same tool, compaction, tree, and accounting behavior.

Do not let a harness silently add tools, workspace files, or global memory. Do not rely exclusively on a provider-side transcript, because local restart recovery and operator inspection require the SQLite history.

### `web_fetch` tool contract

The tool accepts one string field named `url`. Reject malformed URLs and every scheme except HTTP and HTTPS before making a network request.

Issue a direct HTTP `GET` to the validated target URL, follow redirects, and accept HTML, plain text, or JSON. Read at most 100,000 characters. For HTML, remove script and style bodies, derive a title, reduce markup to readable text, resolve links against the final URL, and deduplicate them. Return the title, labeled page content, total link count, and at most the first ten links. Do not send the model-provider API key to the target URL.

Expect a response containing a title, page content, and links. Return the title, labeled page content, total link count, and at most the first ten links to the model. Before returning page content:

- Wrap it in explicit begin/end markers identifying it as external data that must not be treated as instructions.
- Neutralize common model role delimiters, including ChatML, Llama, Markdown role headings, bracketed roles, and XML-style role/tool tags.
- Redact common instruction-override phrases and add a security notice when any content was changed.

This is a defense-in-depth transformation, not a claim that arbitrary web content is safe. Tool errors follow the generation-failure path and send nothing to Discord.

### GitHub tool contract

When `GITHUB_TOKEN` or `GITHUB_ALLOWED_REPOSITORY` is blank, register no GitHub tools. Otherwise register `github_search`, `github_list`, `github_fetch`, `github_create`, `github_update`, and `github_upload_image`. These cover repository, issue, pull-request, branch, code, commit, contents, comment, and image operations through the GitHub REST API. Before any request, case-insensitively match the target `owner/repository` against the configured comma-separated allowlist. Require explicit `owner` and `repo` arguments for repository-scoped operations. A search may omit them to run once per allowed repository and merge its bounded results; never issue a global search. Do not require a local git checkout. Sanitize and label GitHub read results as untrusted external data using the same defenses as `web_fetch`. The registered write-tool guidelines tell the model to mutate only when the current Discord user explicitly requests that specific change. The current execution layer validates parameters and repository scope but does not independently reconstruct conversational intent. Do not recreate CASE-specific issue watches.

### Memory tool contract

Artemis registers `memory_remember`, `memory_recall`, `memory_supersede`,
`memory_forget`, `memory_believed_at`, and `memory_audit` for every profile.
Bind every operation to the stable conversation key in application code; never
accept a model-supplied scope. Bind writes to the triggering Discord author and
message IDs. Writes occur only for an explicit current-user request and store no
secrets. Remember inserts one fact. Supersede atomically tombstones an active
same-scope fact and links its successor. Forget tombstones without hard deletion.
Recall returns only current facts; historical and audit reads retain ended facts.
Memory survives PI session clears because its identity is the conversation key.
See [Graph memory](memory.md) for the authoritative schema and failure contract.

### Using a language without a PI SDK

Prefer one of these approaches:

- Implement the harness port directly against the configured OpenAI-compatible endpoint.
- Use a native-language harness with equivalent history, reasoning, diagnostics, and tool-disable controls.
- Run PI in a small sidecar process behind a narrow local RPC API that implements the harness port.

The sidecar approach is appropriate when PI behavior is required but the main bot is written in a language without a compatible PI SDK. The sidecar must not own Discord policy or SQLite conversation identity.

### Model-provider adapter

The default workflow remains:

- Provider ID: `ollama`
- Base URL: `http://ollama:11434/v1`
- Model: `deepseek-v4-flash:0731-cloud`
- API key: `OLLAMA_API_KEY`, default `ollama`

When `MODEL_CONFIG_PATH` is selected, the operator-provided JSON provider
definition and `MODEL_API_KEY` replace those Ollama settings. Upstream Artemis
does not own any concrete alternate-provider values. The definition must select
one reasoning effort from `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or
`max` when its provider supports that parameter. Omission means the provider does
not support configurable reasoning effort. The default Ollama definition selects
`medium`.

Before connecting Discord, perform a bounded health check against the model service and initialize or validate the configured model. Send a bearer header only when the configured API key is nonblank.

## Persistence contract

SQLite is the durable system of record. Open it before connecting Discord, create its parent directory when needed, enable foreign keys, enable WAL mode, and apply versioned migrations.

Dgraph is the durable system of record for memory facts. Its named volume
survives process and Compose restarts. Apply the additive fact schema before
Discord login; fail startup if that operation fails.

The application image must contain the reviewed HSVAI event-catalog baseline.
Load an optional overlay from `/data/hsvai-event-catalog.json`, or
`HSVAI_EVENT_CATALOG_PATH` when set. Overlay records replace baseline records by
source ID, but apply only when their source hash matches the normalized event.
Malformed catalog data fails loudly; stale records produce pending event
metadata rather than stale graph edges.

The minimal logical schema is:

### `schema_migrations`

- Integer migration version, primary key.
- Applied timestamp.

### `conversations`

- Unique internal ID.
- Unique conversation key.
- Kind: `dm` or `guild`.
- Optional guild ID.
- Channel ID; for threads this is the parent channel ID.
- Created and updated timestamps.

### `sessions`

- Unique logical session ID.
- Conversation foreign key.
- Configured model.
- Status: `active` or `closed`.
- Created and updated timestamps.
- At most one active session per conversation.
- Optional harness session reference or serialized state when the selected harness requires it.

The current implementation uses the logical session ID as the native PI session ID. `/clear-session` changes the active row to `closed`; the next accepted message creates a new active row for the same conversation.

### `pi_sessions`

- Logical session ID as both primary key and foreign key to `sessions`, with cascade deletion.
- Next ordered-entry ordinal.
- Created and updated timestamps.

### `pi_session_entries`

- Logical/native session foreign key.
- Zero-based ordinal, unique within the session.
- Optional native entry ID, unique within the session.
- Native entry type and optional parent ID.
- Raw validated native JSON payload.
- Primary key by session and ordinal; index by session and parent.

Opening a PI session reads its rows in ordinal order, validates the header ID and complete sequence, applies PI format migrations transactionally when required, and builds native context without appending normalized messages. Native entry appends commit before the in-memory leaf advances.

Migration 4 adds these tables. At startup, after model validation and before Discord login, perform a one-time cutover for every logical session without a `pi_sessions` row, including empty sessions. Preserve every available message's speaker metadata, content, reasoning, diagnostics, model, and timestamp, using zero historical assistant usage because the old schema did not store it. Insert all converted sessions and schema migration 5 in one transaction; roll back and abort startup unless every logical session has native PI state. Once migration 5 exists, do not rescan or replay the normalized transcript and do not retain a compatibility mode, completeness column, or synthetic migration entry.

### `messages`

- Monotonically increasing local message ID.
- Session foreign key.
- Globally unique nullable Discord message ID. Assistant messages have no Discord source ID.
- Optional thread ID.
- Role: `user` or `assistant`.
- Optional author ID and display name.
- Content.
- Optional reasoning, structured diagnostics, and model.
- Creation timestamp.
- Index by session and local message order.

### `events`

- Monotonically increasing event ID.
- Optional session ID, conversation key, and Discord message ID.
- Event type.
- Optional structured details.
- Creation timestamp.

### `application_logs`

- Monotonically increasing log ID.
- Level: `debug`, `info`, `warn`, or `error`.
- Event name.
- Structured details.
- Creation timestamp.
- Index by timestamp and ID.

### `incoming_messages`

- Monotonically increasing local message ID.
- Globally unique Discord message ID used to deduplicate redeliveries.
- Guild, channel, thread, and parent-channel IDs where applicable.
- Author ID and optional display name.
- Bot-author, bot-mention, and direct-reply-to-bot flags.
- Raw content, Discord creation timestamp, and local logging timestamp.
- Indexes by channel/local ID and Discord creation time/local ID.

Incoming-message and source-message insertion must ignore duplicate Discord message IDs. Conversation and session creation, batch source-message insertion, assistant insertion, native PI session creation/import/append/format replacement, and active-session closing should each be transactional. A failed generation retains newly accepted source messages and records `generation_failed`, but it must not create a normalized assistant message. Native PI entries already committed by the harness remain its model-context authority. A successful generation inserts one assistant record and records `generation_succeeded`. Every clear attempt records `session_cleared`, including whether an active session existed.

No table has time-based expiration. Operators retain all chat content, reasoning, diagnostics, events, and logs until they deliberately delete records or the data volume.

## Logging and failure rules

Emit one-line structured JSON logs to standard output. Persist the same entries to `application_logs` after the database is initialized.

If log persistence fails:

1. Keep the original console log.
2. Write a console-only `log_persistence_failed` error containing the original event name and the normalized error name and message.
3. Do not attempt to persist that secondary error, which would recurse.

Expected lifecycle events include startup, ready, stop, Discord disconnect, reconnect, resume, SDK warnings and errors, command-registration failure, message-handler failure, and generation success or failure.

Application code must not deliberately insert configured secrets into logs or SQLite. Errors are reduced to their name and message, but provider messages may still be sensitive and operator logs must be protected. No model or harness failure text is sent to Discord.

## Configuration contract

Load local environment configuration from `.env` or the process environment, optional provider metadata from `MODEL_CONFIG_PATH`, and a named profile from `PERSONA_PROFILE`. Trim scalar values and fail startup with an actionable field name when required or selected configuration is blank or invalid.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | Yes | None | Discord bot token. |
| `DISCORD_ALLOWED_CHANNEL_ID` | No | Empty list | Comma-separated parent channel IDs where guild activity is allowed. |
| `DISCORD_ALLOWED_USER_ID` | No | Empty list | Comma-separated user IDs allowed to converse in DMs. This setting does not govern guild messages. |
| `DISCORD_SUPPRESS_EMBEDS` | No | `true` | When `true`, Artemis sends every outbound Discord message with the `SuppressEmbeds` flag so link-preview cards are not rendered. When `false`, embeds render normally. Must be `true` or `false`. |
| `DISCORD_EMBEDS_ALLOWED_CHANNEL_ID` | No | Empty list | Comma-separated channel IDs where link embeds are re-enabled even when `DISCORD_SUPPRESS_EMBEDS` is `true`. Threads resolve through their parent channel. Blank re-enables embeds nowhere. |
| `OLLAMA_BASE_URL` | No | `http://ollama:11434/v1` | Existing default model endpoint. |
| `OLLAMA_MODEL` | No | `deepseek-v4-flash:0731-cloud` | Existing default selected model. |
| `OLLAMA_API_KEY` | No | `ollama` | Existing placeholder or bearer credential. |
| `MODEL_CONFIG_PATH` | No | Empty | Optional local JSON provider definition that replaces the Ollama settings. |
| `MODEL_API_KEY` | No | `local` | Bearer value for the selected provider definition; blank sends no authorization header. |
| `PERSONA_PROFILE` | No | `artemis` | Named profile ID: `artemis` or `wartermis`. |
| `GITHUB_TOKEN` | No | Empty | GitHub API token; blank disables all GitHub tools. |
| `GITHUB_ALLOWED_REPOSITORY` | No | `mbrooks/artemis,HSV-AI/artemis` in application code | Comma-separated GitHub repository allowlist; blank disables GitHub tools. The supplied `.env.example` explicitly sets only `HSV-AI/artemis`. |
| `DGRAPH_URL` | No | `http://dgraph:8080` | Dgraph Alpha HTTP endpoint required by memory. |
| `DGRAPH_INITIAL_GROOT_PASSWORD` | No | `password` | First-start galaxy password used only to rotate Dgraph's default. |
| `DGRAPH_GROOT_PASSWORD` | Yes | None | Galaxy guardian password used by the bootstrap service. |
| `DGRAPH_USER` / `DGRAPH_PASSWORD` | Yes | None | Namespace-0 memory service account with `dgraph.all=7`. |
| `HSVAI_DGRAPH_GROOT_PASSWORD` | Yes | None | Guardian password for the public HSVAI namespace. |
| `HSVAI_DGRAPH_SYNC_USER` / `HSVAI_DGRAPH_SYNC_PASSWORD` | Yes | None | Public-corpus schema and ingestion account with `dgraph.all=7`. |
| `HSVAI_DGRAPH_QUERY_USER` / `HSVAI_DGRAPH_QUERY_PASSWORD` | Yes | None | Public-corpus query account with `dgraph.all=4`. The query and sync usernames must differ. |
| `HSVAI_DGRAPH_NAMESPACE` | No | `1` | Positive namespace ID containing the public HSVAI corpus. |
| `HSVAI_EVENT_CATALOG_PATH` | No | `/data/hsvai-event-catalog.json` | Durable event-catalog overlay read at startup and written by the operator refresh task. |
| `MEMORY_INJECT` | No | `false` | Strict boolean enabling one bounded, byte-stable memory snapshot per durable PI session. |
| `SQLITE_PATH` | No | `/data/artemis.sqlite` | Durable database path. |
| `LOG_LEVEL` | No | `info` | Minimum routine level: `debug`, `info`, `warn`, or `error`. |

The received-message audit ignores `LOG_LEVEL`; all other logs obey it.

The optional provider JSON `embedding` object requires `modelId`; its optional
`baseUrl` defaults to the provider base URL. Its presence is the sole embedding
enablement switch, and it reuses `MODEL_API_KEY`. Omission disables semantic
vectors while preserving HSVAI BM25 and graph retrieval plus memory lexical,
graph, and recency retrieval. HSVAI
GraphRAG always synchronizes from the fixed `https://hsv.ai` source and always
registers `hsvai_graph_search` and `hsvai_graph_query`. Dgraph ACL must be enabled
with an ignored 32-byte `dgraph-acl-secret`; bootstrap must finish before Artemis
starts.

## Clean-room implementation sequence

Each stage should finish with tests before the next begins.

### 1. Scaffold the executable and ports

- Choose the language and package layout.
- Define normalized message, session, generation-result, and log records.
- Define ports for Discord, persistence, logging, and generation.
- Add a process entry point with clean startup failure and shutdown handling.
- Preserve a repository-level `npm run guardrail` entry point. A non-TypeScript implementation may have that script invoke its native formatter, linter, test runner, coverage check, and build.

### 2. Implement configuration

- Parse and validate the variables above.
- Parse allowlists as trimmed, deduplicated sets.
- Verify blank and absent allowlists become empty sets.
- Never include secret values in validation errors or startup logs.

### 3. Implement SQLite and dual-output logging

- Create the database parent directory before opening the file.
- Apply versioned migrations and repository constraints.
- Implement conversation/session lookup, active-session closing, ordered normalized history, native harness session storage, the atomic one-time PI cutover, source and incoming-message deduplication, assistant insertion, events, and application logs.
- Write every accepted log to console first, then SQLite.
- Test restart recovery by closing one repository instance and opening another over the same test database, including exact native usage, tool results, compactions, and parent relationships.

### 4. Implement the Discord adapter

- Request guild, guild-message, direct-message, and message-content gateway intents.
- Support partial DM channels if required by the chosen SDK.
- Register global `/ping`, `/uptime`, and `/clear-session` commands on ready.
- Normalize message events without exposing SDK objects to core policy.
- Compute mentions and direct replies from parsed user, managed-role, and replied-user metadata.
- Page through entire threads.
- Audit the raw event before filtering.
- Send ordinary channel messages and split output safely at 2,000 characters.
- Refresh typing during accepted generation, use replies for guild delivery, and retain ordinary sends for DMs.

### 5. Implement policy and conversation coordination

- Implement the decision table in the documented order.
- Derive stable conversation keys.
- Route `/clear-session` through the same identity derivation, close only its active session, and retain archived history.
- Deduplicate before session or model work.
- Serialize work per conversation key.
- Resolve the durable native harness session, persist new source messages, and build only the current prompt.
- Persist successful assistant output or a failed-generation event containing the normalized error name and message.

### 6. Implement the harness and model adapters

- Start with a deterministic fake satisfying the harness port.
- Add the selected harness strategy.
- Connect the harness's native session manager to ordered SQLite storage and complete the atomic one-time PI cutover before Discord login.
- Register and allowlist `web_fetch`, token-gated GitHub tools, scoped memory tools, and fixed-source HSVAI graph search; disable every built-in tool and build the system instruction from conversation kind, registered-tool metadata, and an optional per-session memory snapshot, including the Capability Gap Protocol.
- Load the reviewed HSVAI event baseline and runtime overlay before source synchronization. Merge legacy facilitators into speakers, then project source-matched themes, speaker edges, and complete/pending status without model calls during startup.
- Queue memory operations in tool-call arrival order. Ranked retrieval must fuse full-text, optional semantic, current-episode graph, and recency channels deterministically. Memory writes must reject duplicate and unforced similar facts without mutation.
- Add configured provider health/model validation.
- Normalize response text, reasoning, diagnostics, and actual response model.

### 7. Package the local stack

- Build a multi-stage application image containing only the application and runtime dependencies.
- Run the final application process as a non-root user.
- Ensure the mounted SQLite directory is created and writable before dropping privileges.
- Preserve the base `ollama`, model-preparation, `dgraph`, and `artemis` Compose services.
- Persist Ollama, Dgraph, and Artemis data in separate volumes.
- Ship the reviewed event baseline in the image and persist its operator-refreshed overlay on the Artemis data volume.
- Allow deployment-owned Compose overrides to select externally managed providers.
- In an override, mount the selected model config read-only, set its in-container path, and preserve the SQLite data volume.
- Document `docker compose up --build` as the one-command startup workflow after initial credentials/sign-in are prepared.

### 8. Complete conformance testing

- Mock Discord, the harness, model provider, and direct HTTP fetch at their external boundaries.
- Keep the compatibility tests independent of the concrete SDK wherever practical.
- Use Vitest for the repository's conformance and application unit suite. A different-language port may additionally use native tests.
- Enforce global statement, branch, function, and line coverage thresholds of at least 80% for code measured by the suite.
- Run lint, type/static checks, tests with coverage, and a production build through `npm run guardrail`.

## Required conformance tests

At minimum, prove all of the following:

- Blank and absent user and channel allowlists are accepted and match nothing.
- Comma-separated allowlists trim whitespace and remove duplicates.
- DM ping accepts only allowed users and returns exactly `pong`.
- Guild ping accepts any user in an allowed parent channel and rejects a disallowed channel.
- Ping performs no conversation database, harness, or model call.
- Uptime uses the ping authorization policy, reports elapsed process time in the documented format, and performs no conversation database, harness, or model call.
- Clear-session uses the ping authorization policy, resolves a thread through its parent channel, closes only the target active session, retains archived history, and gives the next turn empty history.
- Allowed DMs do not require mentions or channel entries.
- Guild messages require an allowed channel plus a direct bot user/managed-role mention or a direct reply to Artemis; they do not require an allowed user.
- `@everyone`, `@here`, unrelated roles, replies to non-Artemis users, bot authors, and blank content do not trigger generation.
- Raw message audit occurs for every received message before all filters, bypasses the log threshold, and creates one deduplicated `incoming_messages` row with normalized mention/reply metadata.
- Distinct DMs and guild channels never share history.
- A thread shares its parent guild-channel conversation key.
- Every accepted thread reply sends the complete ordered thread including the trigger.
- Duplicate thread/source messages are persisted once.
- A redelivered trigger invokes generation once.
- Same-conversation turns serialize; different conversations can progress independently.
- Restarting the application preserves the logical session plus native tool, compaction, tree, model, and exact new-turn usage state without replaying normalized history.
- Every pre-cutover logical session, including an empty one, receives native PI state in an all-or-nothing migration; available Discord speaker context is retained and migration 5 prevents future conversion scans.
- A successful turn persists one assistant record, reasoning, diagnostics, and actual model.
- Failed, aborted, missing, or blank generation persists a failure and sends nothing to Discord.
- Typing appears only for accepted, non-duplicate messages, refreshes until generation ends, and a typing API failure does not cancel generation.
- Every guild and guild-thread response chunk replies to the triggering message; DM chunks use ordinary sends.
- `web_fetch` rejects non-HTTP(S) targets, fetches directly without model credentials, bounds content, limits displayed links to ten, labels external data, and sanitizes adversarial role or instruction patterns.
- GitHub tools are absent without a token or allowed repository; when enabled they reject repositories outside the allowlist, scope searches to allowed repositories, cover all six operations, sanitize read results, and publish the explicit-mutation guideline in the model's tool registry.
- Memory tools are present for every profile; every operation uses the immutable conversation scope, writes retain Discord provenance, corrections and forgetting create tombstones, and scope isolation survives PI session clearing.
- HSVAI startup synchronization follows source pagination, builds a corpus-wide BM25 index, replaces only marked corpus nodes, skips an unchanged source/model revision, and returns cited BM25, optional semantic, and connected-neighborhood evidence through a read-only tool. Omitting `model.embedding` makes no embedding requests and leaves BM25 plus graph retrieval active.
- HSVAI catalog loading merges the baseline and overlay by source ID, rejects malformed data, applies only source-hash matches, exposes stale events as pending, and projects themes plus role-specific person edges. Its model boundary is covered only with synthetic records and mocked HTTP.
- The system prompt lists only registered tools and includes the Capability Gap Protocol in both DM and guild variants.
- Long assistant text is persisted once and sent in ordered Discord-safe chunks.
- Guild sessions receive the channel-limits system-prompt block (`GROUP_CHANNEL_MULTI_MESSAGE_MAX = 3`, self-contained-thought rule) while DM sessions receive no limit messaging; prompt selection is deterministic from the conversation kind.
- Every outbound Discord message (guild reply, DM send, chunked response, and slash-command reply) carries the `SuppressEmbeds` flag by default; `DISCORD_SUPPRESS_EMBEDS=false` omits it globally, and `DISCORD_EMBEDS_ALLOWED_CHANNEL_ID` omits it per channel with threads resolving through the parent channel.
- Console logs continue when SQLite log persistence fails, without recursive failures.
- Startup fails before Discord login when configuration, database migration, or model health validation fails.
- The application image contains no model or Dgraph server; base Compose starts both separately, while deployment-owned overrides may select an external provider.

## Language-port checklist

When changing languages, explicitly document these mappings in the pull request or companion design note:

| Concern | Required mapping |
| --- | --- |
| Async event handling | How Discord callbacks are isolated from per-conversation serialization. |
| Discord SDK | Intents, partial DM support, slash-command registration, structured mention inspection, thread pagination, and message sending. |
| SQLite driver | Foreign keys, WAL, transactions, unique constraints, migration serialization, and safe concurrent access. |
| Harness | Which session strategy is used and how history, system instruction, disabled tools, reasoning, diagnostics, and errors map to the port. |
| Model provider | Local provider definition, health check, model selection, authentication header, timeout, and response parsing. |
| Shutdown | How Discord stops and SQLite closes without accepting new work. |
| Packaging | Non-root runtime, writable data volume, unchanged Ollama Compose workflow, and optional read-only provider config. |
| Verification | How native checks are invoked by `npm run guardrail` and how the Vitest conformance suite reaches the implementation. |

Do not translate library calls line by line. Rebuild the normalized contracts and prove compatibility at the ports.

## Operator smoke check

After automated tests pass:

1. Start the stack with blank allowlists and confirm readiness without any DM, guild, or command response.
2. Add one user ID, restart, and confirm that user's DM `/ping` returns `pong` while another user's DM is silent.
3. Confirm the allowed user receives `/uptime`, then create and clear a DM session and verify the next turn starts fresh while the closed session remains stored.
4. Add one channel ID and confirm any guild user can run all three commands there.
5. Confirm normal guild chat remains silent until any user directly mentions Artemis or directly replies to an Artemis message in an allowed channel.
6. Confirm `@everyone`, `@here`, an unrelated role, and a reply to another user do not trigger Artemis.
7. Create a thread, send multiple messages, then mention or reply to Artemis from any user and verify the entire thread is represented in stored source messages.
8. Restart Artemis and confirm the next DM and guild turns retain their respective histories without crossing contexts.
9. Force a model failure and confirm Discord receives nothing while console and SQLite contain correlated diagnostics.
10. Inspect the SQLite volume and confirm conversations, sessions, messages, events, application logs, and incoming-message audit rows are durable.
11. Explicitly remember and recall a non-sensitive fact, clear the PI session, and confirm the fact remains available only in the same DM or parent guild channel.
12. During a maintenance window, run `npm run catalog:hsvai-events` with the
    configured provider, confirm the overlay is atomically updated on the
    Artemis data volume, and query one event's theme and role-specific person
    edges through the read-only HSVAI account.

Use test Discord credentials and non-sensitive content for this check because raw messages and model metadata are retained indefinitely.

## Definition of done

A clean-room rebuild is complete only when:

- The fixed compatibility boundary and conformance tests pass.
- The full `npm run guardrail` command passes with all coverage thresholds enforced.
- `docker compose up --build` preserves the documented Ollama workflow, and deployment-owned overrides can select a configured external provider.
- Restart persistence and failure silence have been smoke-tested.
- The README identifies the chosen language, Discord library, harness strategy, model endpoint, configuration, data location, and log access.
- Any intentional behavior difference is first recorded as a design change rather than hidden inside an adapter substitution.
