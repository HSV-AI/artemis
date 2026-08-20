# Artemis Discord Bot Design

Status: Proposed

Source: [HSV-AI/artemis issue #1](https://github.com/HSV-AI/artemis/issues/1)

Last updated: 2026-08-19

## Summary

Artemis is a community-run Discord bot that supports AI-assisted conversations in direct messages and selected guild chats. The first release allows a configured list of users to converse with the model in configured channels across guilds, exposes a context-aware `/ping` health command, and preserves each chat's context across restarts.

The implementation uses PI and the PI SDK as the conversational harness, Ollama as the initial model provider, SQLite for durable sessions and chat logs, and Docker Compose for local operation. Configuration and credentials are supplied through an uncommitted `.env` file.

## Goals

- Connect reliably to Discord and operate in configured channels across guilds.
- Support conversations in direct messages and allowed guild channels, treating threads as part of their parent guild channel.
- Keep every Discord conversation isolated and durable.
- Support a comma-separated configuration list of Discord users allowed to converse with the model, with a blank list authorizing no users.
- Let any Discord user run `/ping` and receive exactly `pong` without touching the AI or conversation state.
- Make the model and runtime settings configurable without code changes.
- Record enough activity, errors, chat history, and available model diagnostics for operators to debug conversations.
- Make the project approachable for community members to run and learn from locally.

## Non-goals for the first release

- Providing a general user, role, or server administration system.
- Supporting model providers other than Ollama.
- Sharing context across unrelated direct messages or guild channels.
- Building a hosted control plane or managed deployment service.
- Requiring Ollama or Docker integration tests in the automated test suite.

## Requirements and design responses

| Requirement | Design response |
| --- | --- |
| Multiple Discord guilds | Scope guild responses by globally unique channel IDs rather than by a single guild ID. Direct messages remain supported. |
| Context-aware `/ping` | Handle `/ping` in the Discord adapter before persistence or PI invocation. Reply with exactly `pong` for allowlisted users in DMs and for any user in allowed guild channels. |
| Authorized conversational users | Parse `DISCORD_ALLOWED_USER_ID` as a comma-separated allowlist and compare the message author's Discord user ID before loading a conversation or invoking PI. Unauthorized normal messages receive no response. |
| Allowed guild channels | Parse `DISCORD_ALLOWED_CHANNEL_ID` as a comma-separated channel allowlist. Accept a guild message only when its channel ID, or a thread's parent channel ID, is present. DMs remain supported independently. |
| Explicit guild invocation | Require the triggering message in a guild channel or thread to mention the Artemis bot user or its Discord-managed bot role (`@Artemis`). `@everyone`, `@here`, unrelated roles, and reply-only mentions do not qualify. Direct messages do not require a mention. |
| Direct-message and guild conversations | Derive a stable conversation key from the Discord context. Direct messages use the DM channel ID. Guild messages, including thread replies, use the guild ID plus the parent channel ID. |
| Isolated, persistent context | Associate each conversation key with one durable PI session and store its session state and messages in SQLite. Never query history without the conversation key. |
| Configurable model and runtime | Read validated settings from environment variables loaded through `.env` for local use. |
| Reconnection | Use the Discord client's reconnect and resume behavior, and log connection lifecycle events. |
| Debuggable operation | Emit structured application logs and persist sessions, chat messages, model metadata, and available reasoning or diagnostics. |

## Implementation decisions from the issue comments

The following choices come from the [implementation comment on issue #1](https://github.com/HSV-AI/artemis/issues/1#issuecomment-5349536413) and are constraints for the initial implementation.

| Comment direction | Implementation detail |
| --- | --- |
| Use PI and the PI SDK as the base harness | PI owns the model-facing conversation lifecycle. Discord-specific code sits outside PI behind an adapter so the main flow remains easy for a first-time chatbot contributor to follow. |
| Save all sessions and chat logs to SQLite | SQLite is the durable system of record for conversation identity, PI session references or state, user and assistant messages, model metadata, and available reasoning or diagnostic data. |
| Community members must be able to run locally | A documented local workflow requires only Discord credentials, the configured Ollama access, and Docker Compose. Persistent data lives in a named or bind-mounted local volume. |
| Start with Ollama and `deepseek-v4-flash:0731-cloud` | Ollama is the initial model boundary and `deepseek-v4-flash:0731-cloud` is the default model. The model remains configurable without a code change. |
| Store configuration in `.env` | Local configuration is loaded from `.env`; `.env` is ignored by Git, while a non-secret `.env.example` documents every required value. Startup fails clearly when required configuration is absent or invalid. |
| Use Docker and Docker Compose | The project supplies an Artemis image and a Compose definition for local startup. Compose starts Ollama as a separate dependency container, mounts durable data, injects `.env`, and connects Artemis to Ollama over the Compose network. Ollama is not installed in the Artemis image. |
| Create design docs | This document is the initial design baseline and should be updated when implementation decisions change. |

## High-level architecture

```mermaid
flowchart LR
    User[Discord user] --> DM[Direct message]
    User --> Guild[Guild group chat]
    DM --> Bot
    Guild --> Bot
    Config[Environment configuration] --> Bot
    Config --> Ollama
    subgraph Compose[Docker Compose]
        Bot[Artemis bot<br/>TypeScript container]
        Bot --> Ping{Ping command?}
        Ping -- Yes, allowed DM user or any user in allowed channel --> Pong[Direct protocol response]
        Ping -- No --> Auth{User ID in configured allowlist?}
        Auth -- No --> Ignore[Silently ignore message]
        Auth -- Yes --> Group{DM or allowed guild channel?}
        Group -- No --> Ignore
        Group -- Yes --> Mention{DM or bot mentioned?}
        Mention -- No --> Ignore
        Mention -- Yes --> Sessions[Session router<br/>One PI session per DM or guild group chat]
        Sessions --> Store[(SQLite<br/>sessions and chat logs)]
        Sessions --> PI[PI harness SDK]
        PI --> Ollama[Ollama container]
        Ollama --> Model[deepseek-v4-flash<br/>configurable model]
        Model --> Ollama
        Ollama --> PI
        PI -- Reasoning and diagnostics --> Store
        Bot -- Application logs --> Store
        PI --> Bot
    end
    Pong --> Discord[Discord response]
    Bot --> Discord
    Bot -- Application logs --> Stdout[Standard output]
```

### Component responsibilities

#### Configuration

Configuration is loaded once at startup, parsed into a typed runtime object, and validated before any network connection or database mutation. At minimum it includes:

- Discord bot token and an optional comma-separated list of allowed channel IDs across guilds. A blank list disables guild responses.
- An optional comma-separated list of authorized Discord user IDs, with no built-in default. A blank list authorizes no users.
- Comma-separated allowed guild channel IDs. Threads are matched by parent channel ID.
- Ollama endpoint and model, with `deepseek-v4-flash:0731-cloud` as the default model.
- SQLite database path.
- Log level and other non-secret runtime controls.

Secrets are never committed, printed, or included in error payloads. `.env.example` contains names and safe examples only.

#### Discord adapter

The Discord adapter owns gateway connection, interaction registration, incoming-event normalization, outbound replies, and connection lifecycle logging. It exposes normalized events to the application rather than leaking Discord SDK objects into the conversation core.

The adapter distinguishes `/ping` interactions from normal chat messages immediately. Bot-authored conversational messages are ignored to prevent loops, while channel allowlisting determines where guild responses are permitted.

#### Ping handler

The ping path is independent of the conversational path. It performs no authorization check, database read or write, PI call, or Ollama call. Its entire user-visible response is exactly `pong`.

#### Conversation authorization

Normal chat is accepted only when the author's Discord ID appears in the configured user allowlist. Rejected messages are not sent to PI and do not create or alter conversation records. They produce no Discord response.

Within a guild, an authorized message must originate in one of the configured channels and mention either the Artemis bot user or the Discord-managed role whose `botId` belongs to Artemis. A thread is allowed when its parent channel is configured. Reply metadata, unrelated roles, `@everyone`, and `@here` do not count as a bot mention. Direct messages retain their normal conversational behavior and never require a channel match or mention.

#### Conversation coordinator

The coordinator maps a normalized Discord event to a stable conversation key, restores or creates the corresponding PI session, submits the message, persists the result, and returns the response to Discord.

Conversation keys are namespaced by context:

- Direct message: `dm:<channel-id>`
- Guild channel: `guild:<guild-id>:channel:<channel-id>`

Discord channel IDs are immutable identifiers. Human-readable names are stored only as optional metadata and never used as keys. A Discord thread belongs to its parent guild channel and therefore uses that parent channel's conversation key rather than creating an independent conversation.

When an authorized user replies in a thread, the coordinator fetches the complete thread in Discord order, including the new message, and submits that thread snapshot to PI for the current turn. The snapshot preserves author and message identity so the model can follow the discussion. Messages from other users may appear in this snapshot as context, but only a new message from the authorized user can trigger model generation. Repeated snapshots do not create duplicate SQLite message rows because source Discord message IDs are deduplicated.

Work for the same conversation is serialized so two rapidly arriving messages cannot race while updating one session. Different conversations may run concurrently. Discord message IDs provide idempotency so a redelivered event is not submitted to the model twice.

#### PI and Ollama boundary

PI is the base conversational harness and owns interaction with the configured model through Ollama. Application code supplies the isolated conversation session and user message, then consumes the assistant response plus any available reasoning or diagnostic metadata.

The model name is configuration, not a conditional embedded in application logic. Changing from the default `deepseek-v4-flash:0731-cloud` therefore requires a configuration update and restart, not a code change. Ollama-specific calls remain behind a narrow boundary so unit tests can substitute a deterministic fake.

#### Persistence

SQLite stores all durable conversational data. A minimal logical schema includes:

- `conversations`: stable conversation key, Discord context metadata, timestamps, and active-session reference.
- `sessions`: conversation ID, PI session identifier or serialized state, model, lifecycle status, and timestamps.
- `messages`: session ID, Discord message and thread IDs where applicable, role, content, model metadata, available reasoning or diagnostics, and timestamp.
- `events`: structured operational events that need durable correlation with a session or message.
- `application_logs`: every structured application log emitted at the configured level, including its timestamp, severity, event name, and metadata.
- `schema_migrations`: applied schema version history.

Foreign keys are enabled. Conversation keys and inbound Discord message IDs are uniquely constrained. Message and session writes for a model turn occur in a transaction so a partial write cannot appear as a completed exchange.

The SQLite file lives on a persistent Docker volume and remains available across container restarts and upgrades. Schema migrations run before Discord connects and must be backward-safe for existing local data.

There is no automatic retention or deletion policy. Chat content, session data, and model reasoning or diagnostics remain in SQLite indefinitely unless an operator deliberately removes records or deletes the local data volume.

#### Logging and operator access

Application logs are structured and written to standard output for `docker compose logs`. Every emitted entry is also inserted into SQLite's `application_logs` table with the same timestamp, severity, event name, and metadata. A database-write failure never suppresses the console entry and produces a console-only persistence-failure diagnostic without recursively attempting another database write. Each relevant event includes correlation fields such as conversation ID, session ID, and Discord message ID and excludes credentials.

Every newly received Discord message is logged before normalization or any bot, content, channel, mention, authorization, or conversation filter runs. The `discord_message_received` entry includes the raw message body, guild and channel identifiers, author identity and display name, bot flag, thread identity when applicable, and Discord creation timestamp. This deliberately sensitive audit event bypasses the normal `LOG_LEVEL` threshold, is emitted to standard output, and is retained in `application_logs`. It includes DMs, messages from every connected guild, bot-authored messages, unauthorized messages, and unmentioned messages.

Chat content, PI session history, and model-provided reasoning or diagnostics are stored in SQLite as required for conversation debugging. These records are sensitive: only local operators should have database access, and documentation must warn against publishing or committing the database file.

#### Container topology

Docker Compose starts at least two separate services:

- `ollama`: the model service and an explicit runtime dependency of Artemis, with its own persistent data volume where required.
- `artemis`: the Discord bot application, built from the Artemis Dockerfile, with its SQLite data volume and configuration from `.env`.

The Artemis Dockerfile contains only the application and its runtime dependencies; it does not install or launch Ollama. The Artemis container reaches Ollama by its Compose service name over the internal Compose network. Compose waits for Ollama to become healthy before starting Artemis so the bot does not connect to Discord with an unavailable required model dependency.

## Runtime flows

### Startup

1. Load and validate environment configuration.
2. Open SQLite, enable foreign keys, and apply migrations.
3. Initialize the PI/Ollama boundary using the configured model.
4. Register Discord interactions and connect the Discord client.
5. Log a successful ready event including the connected bot identity and allowed channel IDs, but no secrets.

If configuration, migration, or required model setup fails, startup exits with a clear error instead of connecting in a partially working state.

### `/ping`

1. Receive and identify the `/ping` interaction.
2. In a DM, silently stop unless the caller is in the configured user allowlist.
3. In a guild, silently stop unless the channel ID, or a thread's parent channel ID, is in the configured channel allowlist. Guild callers do not require user authorization for `/ping`.
4. Reply with exactly `pong`.
5. Do not resolve a conversation, access SQLite, invoke PI, or invoke Ollama.

### Normal message

1. Ignore bot-authored messages.
2. In a guild, silently stop unless the channel ID, or a thread's parent channel ID, is in the configured channel allowlist. DMs skip this check.
3. In a guild, silently stop unless the triggering message directly mentions Artemis. DMs skip this check.
4. Check the author ID against the configured user allowlist; silently stop if it is not authorized.
5. For a thread reply, fetch the complete thread in Discord order, including the new message.
6. Derive the conversation key from the DM channel or the parent guild channel.
7. Serialize work behind that conversation's queue.
8. Within the conversation, deduplicate source messages by Discord message ID.
9. Restore or create the durable PI session and persist any new inbound messages.
10. Submit the current message, or the complete thread snapshot for a thread reply, to PI through the configured Ollama model.
11. Atomically persist the assistant response and available model diagnostics.
12. Send the response to the originating Discord conversation or thread.

If generation fails, Artemis records the failed attempt and sanitized diagnostics for operators. It does not fabricate an assistant turn or send anything to Discord. A later message reuses the last valid session state.

### Reconnection and restart

Transient Discord disconnects rely on the Discord client's resume and reconnect behavior with bounded backoff. Lifecycle events are logged. After a process or container restart, Artemis reopens SQLite and resolves the next incoming message to the existing conversation and PI session before generating a response.

## Failure handling

- Invalid or missing required configuration: fail startup with actionable field names and no secret values.
- SQLite unavailable or migration failure: fail startup; do not accept messages without persistence.
- Ollama unavailable during startup validation: report the provider/model failure and remain unhealthy.
- Ollama or PI failure during a turn: persist a sanitized failure event and log correlation IDs, but send nothing to Discord.
- Discord disconnect: reconnect automatically and log disconnect, retry, resume, and ready transitions.
- Duplicate Discord event: return without a second model invocation or duplicate persisted turn.
- Discord response too long: split at Discord-safe boundaries while retaining one assistant message in conversation history.

## Security and privacy

- Keep Discord and model credentials only in the local environment or an operator-provided secret mechanism; never commit `.env`.
- Ignore unauthorized normal messages before reading conversation state or invoking the model.
- Scope every persistence query by the stable conversation identifier.
- Do not expose chat history, model reasoning, tokens, or raw error payloads in routine application logs.
- Run containers as a non-root user where practical and grant write access only to the data volume.
- Bind locally exposed service ports to loopback by default.
- Treat the SQLite database and operator logs as sensitive user data, especially because stored records have no automatic expiration.

## Local development and operations

The expected contributor workflow is:

1. Copy `.env.example` to `.env` and provide Discord credentials and any required Ollama model credentials.
2. Start the separate Artemis and Ollama containers with `docker compose up`.
3. Watch readiness and reconnect events with `docker compose logs`.
4. Stop the stack without deleting the persistent data volume.

The README should document Discord application setup, required intents and permissions, Ollama authentication or model availability, first startup, database location, log access, upgrades, and safe cleanup.

## Testing and completion gates

Application code is tested with Vitest. Discord, PI, and Ollama are mocked at their external boundaries; Ollama and Docker integration tests are not required. Unit coverage has global statement, branch, function, and line thresholds of at least 80%.

Required tests include:

- `/ping` returns exactly `pong` for allowlisted DM users and any user in allowed guild channels, ignores unauthorized DMs and disallowed guild channels, and proves that persistence, PI, and Ollama are untouched.
- Unauthorized normal chat is silently ignored without persistence or model calls.
- Guild messages outside the configured channel allowlist are silently ignored, while DMs are unaffected.
- Unmentioned guild messages are silently ignored, while direct messages continue without requiring a mention.
- DM and guild-channel keys remain distinct and stable, while a thread resolves to its parent guild-channel key.
- Every authorized thread reply submits the complete ordered thread, including the new message, without duplicating persisted source messages.
- Repeated messages reuse the correct session after a simulated process restart.
- Context never crosses conversation keys.
- Duplicate Discord message IDs invoke the model once.
- Concurrent messages in one conversation are serialized.
- Configuration defaults and validation behave as documented, including the default model.
- Persistence transactions, migrations, and error paths preserve the last valid session state.
- PI or Ollama failures are logged without creating an assistant turn or sending a Discord response.
- Discord reconnect lifecycle events are handled without losing durable context.

`npm run guardrail` is the completion gate and runs all required checks, including the Vitest suite with coverage. A change is not complete until that command passes.

## Acceptance criteria traceability

| Issue acceptance criterion | Verification approach |
| --- | --- |
| Connect and log success | Adapter unit test plus a documented local smoke check. |
| Reconnect after interruption | Adapter reconnect-state unit test with the Discord boundary mocked. |
| Eligible users receive exactly `pong` | Ping unit tests for authorized and unauthorized DMs plus allowed guild channels, allowed threads, and disallowed channels. |
| Ping does not affect AI or history | Assert zero calls to the persistence, PI, and Ollama boundaries. |
| Authorized users can chat in DM and guild contexts | Coordinator unit tests proving comma-separated user and channel allowlists, DMs needing no channel match or mention, and allowed guild messages requiring a direct bot mention. |
| Other users are silently ignored | Authorization unit test asserting no reply, persistence, or model call. |
| Each conversation reuses durable context | Persistence and coordinator tests across fresh application instances. |
| No context leaks | Cross-key isolation tests using distinct DMs and parent guild channels, plus tests proving threads share only their own parent channel's key. |
| Model changes through configuration | Configuration and PI-boundary tests with a non-default model. |
| Secrets remain outside the repository | `.env.example`, `.gitignore`, secret-scanning guard, and review. |
| Activity and diagnostics are operator-accessible | Logging and persistence tests plus documented `docker compose logs` and SQLite access. |

## Resolved implementation questions

- Guild threads are part of their parent guild channel conversation. A thread is eligible only when its parent channel ID is in `DISCORD_ALLOWED_CHANNEL_ID`. On each authorized thread reply that directly mentions Artemis, the bot resubmits the entire ordered thread, including the new message.
- SQLite has no automatic retention or deletion policy. Stored chat content, sessions, and model reasoning or diagnostics remain until an operator deliberately removes them.
- PI or Ollama generation failures are recorded for operators but produce no Discord response.
- Docker Compose starts Ollama as a separate dependency container. Ollama is not included in the Artemis Dockerfile or application container.

Changes to these decisions should update this document and, when they alter observable behavior, the source issue and acceptance criteria.
