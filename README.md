# Artemis

Artemis is a small, community-run Discord chatbot built with TypeScript, the PI SDK, Ollama, and SQLite. It supports direct messages and one Discord guild, keeps each conversation isolated across restarts, and deliberately starts with one authorized conversational user.

The product and implementation baseline is documented in [design/baseline.md](design/baseline.md).

## Behavior

- Any Discord user can run `/ping` in a DM or the configured guild and receive exactly `pong`.
- `/ping` never accesses SQLite, PI, or Ollama.
- Only Discord user `603384387685449728` is allowed to trigger conversational responses by default.
- Other normal messages are silently ignored.
- In guild channels and threads, the authorized user must directly mention the bot user (`@Artemis`) in the triggering message. `@everyone`, `@here`, role mentions, and reply-only mentions do not trigger Artemis. DMs do not require a mention.
- DMs have independent sessions. Guild threads share their parent channel's session.
- An authorized thread reply submits the complete ordered thread, including the new message, to PI.
- PI and Ollama failures are written to operator logs and SQLite; nothing is sent to Discord.
- Sessions, chat content, reasoning, and diagnostics are retained in SQLite until an operator removes them.

## Prerequisites

- Docker with Docker Compose.
- A Discord application and bot token.
- An Ollama account that can use `deepseek-v4-flash:0731-cloud`, or another configured model.

For host-based development, Node.js 24 or newer is also required.

## Discord setup

1. Create an application in the Discord Developer Portal and add a bot user.
2. Enable the **Message Content Intent** for the bot.
3. Invite the bot to the target guild with permissions to view channels, read message history, send messages, use application commands, and access the threads where it should operate.
4. Copy the bot token and guild ID into `.env`.

Artemis registers `/ping` as a global application command when it connects. Global command changes can take time to appear in Discord.

## Configuration

Copy the example file and fill in the required values:

```sh
cp .env.example .env
```

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | Yes | — | Discord bot token. |
| `DISCORD_GUILD_ID` | Yes | — | The only guild in which normal messages are accepted. |
| `AUTHORIZED_USER_ID` | No | `603384387685449728` | User allowed to converse with Artemis. |
| `OLLAMA_BASE_URL` | No | `http://ollama:11434/v1` | Ollama's OpenAI-compatible endpoint. Compose enforces this internal URL. |
| `OLLAMA_MODEL` | No | `deepseek-v4-flash:0731-cloud` | Model selected by PI. |
| `OLLAMA_API_KEY` | No | `ollama` | Placeholder for local Ollama, or bearer token for a compatible remote endpoint. |
| `SQLITE_PATH` | No | `/data/artemis.sqlite` | Durable SQLite file. Compose enforces the mounted data path. |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, or `error`. |

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
- Application logs are written as structured JSON to standard output and duplicated in SQLite's `application_logs` table. They exclude message bodies and credentials.
- Chat content, model reasoning, and diagnostics are stored in SQLite and do not expire automatically.
- If `ollama-model` cannot pull the cloud model, repeat the Ollama sign-in command and inspect `docker compose logs ollama ollama-model`.
- If messages are ignored, verify the guild ID, authorized user ID, Message Content Intent, channel/thread permissions, and that guild messages directly mention the bot.
- If `/ping` is missing, allow time for global command propagation and verify the bot has application-command permissions.
