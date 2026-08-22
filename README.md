# Artemis

Artemis is a small, community-run Discord chatbot built with TypeScript, the PI SDK, a configurable OpenAI-compatible model provider, and SQLite. It supports allowlisted users in direct messages and any user in selected channels across Discord guilds, while keeping each conversation isolated across restarts.

The product and implementation baseline is documented in [design/baseline.md](design/baseline.md). Coding agents can reproduce Artemis in another language or with another conversational harness by following the [clean-room rebuild guide](design/rebuild-guide.md).

## Behavior

- Any Discord user can run `/ping` in an allowed guild channel. In DMs, `/ping` and normal conversation are restricted to users in `DISCORD_ALLOWED_USER_ID`.
- `/ping` never accesses SQLite, PI, or the model provider.
- `DISCORD_ALLOWED_USER_ID` supplies the comma-separated DM user allowlist. A blank list disables DM responses.
- DMs produce no response for users outside `DISCORD_ALLOWED_USER_ID`.
- Other normal messages are silently ignored.
- Guild responses across all connected guilds are limited to the comma-separated channel IDs in `DISCORD_ALLOWED_CHANNEL_ID`; threads inherit permission from their parent channel.
- In allowed guild channels and threads, any user can converse by mentioning the bot user or its Discord-managed bot role (`@Artemis`) in the triggering message. `@everyone`, `@here`, unrelated roles, and reply-only mentions do not trigger Artemis. DMs do not require a mention.
- DMs have independent sessions. Guild threads share their parent channel's session.
- An accepted thread reply submits the complete ordered thread, including the new message, to PI.
- After accepting a normal message, Artemis shows and refreshes Discord's typing indicator every five seconds until generation finishes. Guild and guild-thread answers reply to the triggering message; DM answers remain ordinary direct messages.
- PI may use the explicitly registered `web_fetch` tool to read a user-provided HTTP or HTTPS page directly. When `GITHUB_TOKEN` is configured, PI may also search, list, fetch, create, and update GitHub resources and upload issue images, but only within `GITHUB_ALLOWED_REPOSITORY`. External content is labeled as untrusted and sanitized before it reaches the model; built-in coding tools remain disabled.
- PI and model-provider failures are written to operator logs and SQLite; nothing is sent to Discord.
- Sessions, chat content, reasoning, and diagnostics are retained in SQLite until an operator removes them.
- Every newly received Discord message is logged with its raw content and metadata before filtering, regardless of `LOG_LEVEL`. This includes DMs, guild messages, bot messages, unauthorized messages, and unmentioned messages.

## Prerequisites

- Docker with Docker Compose.
- A Discord application and bot token.
- An Ollama account that can use `deepseek-v4-flash:0731-cloud`, another configured Ollama model, or access to an OpenAI-compatible endpoint through the optional model config.

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
| `DISCORD_ALLOWED_USER_ID` | No | Empty | Comma-separated Discord user IDs allowed to converse with Artemis in DMs. A blank list disables DM responses. This setting does not govern guild messages. |
| `DISCORD_SUPPRESS_EMBEDS` | No | `true` | When `true`, Artemis sends every outbound Discord message with link embeds suppressed, so Discord does not render link-preview cards. Set to `false` to re-enable embeds globally. |
| `DISCORD_EMBEDS_ALLOWED_CHANNEL_ID` | No | Empty | Comma-separated channel IDs where link embeds are re-enabled even when `DISCORD_SUPPRESS_EMBEDS` is `true`. Threads use their parent channel ID. |
| `OLLAMA_BASE_URL` | No | `http://ollama:11434/v1` | Existing Ollama OpenAI-compatible endpoint. Base Compose enforces this internal URL. |
| `OLLAMA_MODEL` | No | `deepseek-v4-flash:0731-cloud` | Model selected by the existing Ollama workflow. |
| `OLLAMA_API_KEY` | No | `ollama` | Existing Ollama placeholder or bearer credential. |
| `MODEL_CONFIG_PATH` | No | Empty | Runtime path to an optional JSON provider definition. When absent, Artemis uses the existing `OLLAMA_*` settings. |
| `MODEL_API_KEY` | No | `local` | Bearer value used only with `MODEL_CONFIG_PATH`. A blank value sends no authorization header. |
| `PERSONA_PATH` | No | Empty | Runtime path to an optional UTF-8 persona profile appended to the fixed Artemis system instructions. |
| `GITHUB_TOKEN` | No | Empty | GitHub API token. A blank value disables every GitHub tool. Grant only the repository permissions needed for the desired read or write operations. |
| `GITHUB_ALLOWED_REPOSITORY` | No | `HSV-AI/artemis` | Comma-separated `owner/repository` allowlist. A blank list disables every GitHub tool. Matching is case-insensitive. |
| `SQLITE_PATH` | No | `/data/artemis.sqlite` | Durable SQLite file. Compose enforces the mounted data path. |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, or `error`. |

When upgrading an existing `.env`, remove `DISCORD_GUILD_ID`, replace `AUTHORIZED_USER_ID` with `DISCORD_ALLOWED_USER_ID`, and add `DISCORD_ALLOWED_CHANNEL_ID`. Separate multiple IDs with commas; surrounding whitespace and duplicate IDs are removed. A blank user allowlist disables DMs, while a blank channel allowlist disables guild responses.

Never commit `.env`, `model.config.json`, the SQLite database, model credentials, or GitHub tokens. Artemis rejects every GitHub operation outside the repository allowlist. GitHub mutations are available only when the current Discord request explicitly asks for the specific mutation.

GitHub repository-scoped operations require both `owner` and `repo`, and both must match an allowlist entry. A search may omit them to search every allowed repository.

## Ollama setup

The existing Compose workflow remains the default. For the default cloud model, run the one-time sign-in before the first startup:

```sh
docker compose run --rm ollama signin
```

The `ollama-data` volume retains the sign-in and model manifest. Local Ollama models can be selected with `OLLAMA_MODEL` without signing in.

## Optional model-provider configuration

Set `MODEL_CONFIG_PATH` to an operator-owned JSON file to select another
OpenAI-compatible provider. The file must define `providerId`, `providerName`,
`baseUrl`, `modelId`, `reasoning`, `reasoningEffort`, `contextWindow`, `maxTokens`,
`supportsDeveloperRole`, and `supportsReasoningEffort`. Keep bearer credentials
in `MODEL_API_KEY`, not the JSON file.

`reasoningEffort` must be `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or
`max`. Artemis passes the selected value to every PI session. The default Ollama
workflow uses `medium`; deployment-owned provider definitions may select another
level supported by their endpoint.

Artemis intentionally does not ship a concrete alternate-provider file.
Deployment repositories should own those values and mount the file through a
Compose override or another runtime secret/configuration mechanism.

## Optional persona profile

Set `PERSONA_PATH` to an operator-owned text or Markdown file to give a deployment
a distinct identity, tone, or conversational style. Artemis trims the file and
uses it instead of the built-in Artemis identity under a `Persona Profile`
section. The fixed Discord, tool, and capability rules remain in force. An
unreadable or blank selected file fails startup.

For example, a deployment override can mount a profile read-only:

```yaml
services:
  artemis:
    environment:
      PERSONA_PATH: /app/persona.md
    volumes:
      - ./persona.md:/app/persona.md:ro
```

Changing a profile requires an application restart. Keep secrets out of persona
files because their full contents are sent to the configured model.

## Run locally with Compose

Start the unchanged Ollama-backed development stack:

```sh
docker compose up --build
```

The base Compose file starts `ollama`, the `ollama-model` pull job, and `artemis`
exactly as before. Deployments using another provider should layer their own
Compose override over this file. Artemis checks the selected provider's
`/models` endpoint before connecting to Discord.

View operator logs with:

```sh
docker compose logs -f artemis ollama
```

Stop without deleting durable data:

```sh
docker compose down
```

## Automated updates

[`scripts/update-artemis-if-needed.sh`](scripts/update-artemis-if-needed.sh) checks a remote branch for a new commit. When an update exists, it force-aligns the local checkout, refreshes host dependencies if `package.json` or `package-lock.json` changed, and runs `docker compose up -d --build`.

Run it on demand from any directory:

```sh
./scripts/update-artemis-if-needed.sh
```

The default source is `origin/main`. Override either value when the deployment uses another remote name or branch:

```sh
ARTEMIS_UPDATE_REMOTE=personal ARTEMIS_UPDATE_BRANCH=main ./scripts/update-artemis-if-needed.sh
```

This is a deployment script: it switches branches with `git checkout -f` and resets tracked files with `git reset --hard`. Do not run it in a development checkout containing uncommitted work. Persistent Docker volumes and `.env` are not removed.

Deleting base-Compose volumes permanently removes conversations, reasoning, diagnostics, and Ollama state:

```sh
docker compose down --volumes
```

## Host-based development

Install dependencies and run the application:

```sh
npm install
npm run dev
```

When Artemis runs on the host, the existing `OLLAMA_*` variables remain the default. Set `MODEL_CONFIG_PATH` and `MODEL_API_KEY` only to opt into an operator-provided model definition, and choose a writable host path for `SQLITE_PATH`.

## Validation

The required completion gate runs linting, strict TypeScript checks, Vitest with coverage, and a production build:

```sh
npm run guardrail
```

Global statement, branch, function, and line coverage thresholds are all enforced at 80%.

## Data and troubleshooting

- Artemis refuses to connect to Discord if configuration, SQLite migration, or model-provider health validation fails.
- At container startup, Artemis repairs ownership of its `/data` volume and then runs the application as the unprivileged `node` user.
- Application logs are written as structured JSON to standard output and duplicated in SQLite's `application_logs` table. Credentials are excluded. The `discord_message_received` event intentionally includes raw message bodies from every Discord message event.
- Chat content, model reasoning, and diagnostics are stored in SQLite and do not expire automatically.
- If base-Compose model preparation fails, repeat the Ollama sign-in and inspect `docker compose logs ollama ollama-model`.
- If an optional provider fails validation, inspect its `baseUrl`, `modelId`, `MODEL_API_KEY`, and `/models` response.
- If messages are ignored, verify the allowed channel and user IDs, Message Content Intent, channel/thread permissions, and that guild messages directly mention the bot.
- If `/ping` is missing, allow time for global command propagation and verify the bot has application-command permissions.
