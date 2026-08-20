# Artemis

Artemis is a small, community-run Discord chatbot built with TypeScript, the PI SDK, Ollama, and SQLite. It supports direct messages and selected channels across Discord guilds, keeps each conversation isolated across restarts, and restricts conversations to a configured user allowlist.

The product and implementation baseline is documented in [design/baseline.md](design/baseline.md). Coding agents can reproduce Artemis in another language or with another conversational harness by following the [clean-room rebuild guide](design/rebuild-guide.md).

## Behavior

- Any Discord user can run `/ping` in an allowed guild channel. In DMs, `/ping` and normal conversation are restricted to users in `DISCORD_ALLOWED_USER_ID`.
- `/ping` never accesses SQLite, PI, or Ollama.
- `DISCORD_ALLOWED_USER_ID` supplies the comma-separated user allowlist. A blank list authorizes no users.
- DMs produce no response for users outside `DISCORD_ALLOWED_USER_ID`.
- Other normal messages are silently ignored.
- Guild responses across all connected guilds are limited to the comma-separated channel IDs in `DISCORD_ALLOWED_CHANNEL_ID`; threads inherit permission from their parent channel.
- In guild channels and threads, the authorized user must mention the bot user or its Discord-managed bot role (`@Artemis`) in the triggering message. `@everyone`, `@here`, unrelated roles, and reply-only mentions do not trigger Artemis. DMs do not require a mention.
- DMs have independent sessions. Guild threads share their parent channel's session.
- An authorized thread reply submits the complete ordered thread, including the new message, to PI.
- PI may use the explicitly allowlisted `web_fetch` tool to read a user-provided HTTP or HTTPS page through Ollama. Fetched content is labeled as untrusted and sanitized before it reaches the model; built-in coding tools remain disabled.
- PI and Ollama failures are written to operator logs and SQLite; nothing is sent to Discord.
- Sessions, chat content, reasoning, and diagnostics are retained in SQLite until an operator removes them.
- Every newly received Discord message is logged with its raw content and metadata before filtering, regardless of `LOG_LEVEL`. This includes DMs, guild messages, bot messages, unauthorized messages, and unmentioned messages.

## Prerequisites

- Docker with Docker Compose.
- A Discord application and bot token.
- An Ollama account that can use `deepseek-v4-flash:0731-cloud`, or another configured model.

For host-based development, Node.js 24 or newer is also required.

## Discord setup

1. Create an application in the Discord Developer Portal and add a bot user.
2. Enable the **Message Content Intent** for the bot.
3. Invite the bot to each desired guild with permissions to view channels, read message history, send messages, use application commands, and access the threads where it should operate.
4. Copy the bot token into `.env`, then add any channel IDs and user IDs Artemis should allow.

Artemis registers `/ping` as a global application command when it connects. Global command changes can take time to appear in Discord.

## Configuration

Copy the example file and fill in the required values:

```sh
cp .env.example .env
```

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | Yes | — | Discord bot token. |
| `DISCORD_ALLOWED_CHANNEL_ID` | No | Empty | Comma-separated guild channel IDs where Artemis may respond. A blank list disables guild responses. Threads use their parent channel ID. |
| `DISCORD_ALLOWED_USER_ID` | No | Empty | Comma-separated Discord user IDs allowed to converse with Artemis. A blank list authorizes no users. |
| `OLLAMA_BASE_URL` | No | `http://ollama:11434/v1` | Ollama's OpenAI-compatible endpoint. Compose enforces this internal URL. |
| `OLLAMA_MODEL` | No | `deepseek-v4-flash:0731-cloud` | Model selected by PI. |
| `OLLAMA_API_KEY` | No | `ollama` | Placeholder for local Ollama, or bearer token for a compatible remote endpoint. |
| `SQLITE_PATH` | No | `/data/artemis.sqlite` | Durable SQLite file. Compose enforces the mounted data path. |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, or `error`. |

When upgrading an existing `.env`, remove `DISCORD_GUILD_ID`, replace `AUTHORIZED_USER_ID` with `DISCORD_ALLOWED_USER_ID`, and add `DISCORD_ALLOWED_CHANNEL_ID`. Separate multiple IDs with commas; surrounding whitespace and duplicate IDs are removed. Either allowlist may be blank, which allows no matching users or channels.

Never commit `.env`, the SQLite database, or Ollama credentials.

## Ollama cloud sign-in

The default model is an Ollama cloud model. Ollama requires a one-time sign-in for a local installation—including the Compose service—to use cloud models. The `ollama-data` volume retains that sign-in and the model manifest.

Before the first `docker compose up`, run:

```sh
docker compose run --rm ollama signin
```

Follow the displayed device-login instructions. For a local model that does not require an Ollama account, set `OLLAMA_MODEL` in `.env` and skip this step.

## Run locally with Compose

Start Ollama, pull the configured model, build Artemis, and start the bot:

```sh
docker compose up --build
```

The services are intentionally separate:

- `ollama` runs the model server and owns the `ollama-data` volume.
- `ollama-model` ensures the configured model is available before Artemis starts.
- `artemis` contains only the Node.js application and owns the `artemis-data` volume.

View operator logs with:

```sh
docker compose logs -f artemis ollama
```

Stop without deleting durable data:

```sh
docker compose down
```

Deleting volumes permanently removes conversations, reasoning, diagnostics, and the Ollama sign-in/model data:

```sh
docker compose down --volumes
```

## Host-based development

Install dependencies and run the application:

```sh
npm install
npm run dev
```

When Artemis runs on the host, set `OLLAMA_BASE_URL=http://localhost:11434/v1` and choose a writable host path for `SQLITE_PATH`.

## Validation

The required completion gate runs linting, strict TypeScript checks, Vitest with coverage, and a production build:

```sh
npm run guardrail
```

Global statement, branch, function, and line coverage thresholds are all enforced at 80%.

## Data and troubleshooting

- Artemis refuses to connect to Discord if configuration, SQLite migration, or the Ollama health check fails.
- At container startup, Artemis repairs ownership of its `/data` volume and then runs the application as the unprivileged `node` user.
- Application logs are written as structured JSON to standard output and duplicated in SQLite's `application_logs` table. Credentials are excluded. The `discord_message_received` event intentionally includes raw message bodies from every Discord message event.
- Chat content, model reasoning, and diagnostics are stored in SQLite and do not expire automatically.
- If `ollama-model` cannot pull the cloud model, repeat the Ollama sign-in command and inspect `docker compose logs ollama ollama-model`.
- If messages are ignored, verify the allowed channel and user IDs, Message Content Intent, channel/thread permissions, and that guild messages directly mention the bot.
- If `/ping` is missing, allow time for global command propagation and verify the bot has application-command permissions.
