# Discord link-embed suppression

## Status

Accepted and implemented.

Source: [HSV-AI/artemis issue #27](https://github.com/HSV-AI/artemis/issues/27).

## Problem

Discord renders link-preview cards (embeds) for any URL a message contains. Artemis posts model-generated content and slash-command replies that may contain URLs, and operators do not want those links to expand into preview cards in Discord. Relying on the model to request embed suppression in its response settings is not acceptable because the model may omit or malform the field; suppression must be enforced by the application layer for every outbound message.

## Scope

In scope:

- All outbound Discord messages Artemis sends through the Discord adapter: normal chat responses (guild replies and DM channel sends), chunked responses, and slash-command replies (`/ping`, `/uptime`, `/clear-session`).
- A global configuration switch that defaults to suppressing embeds.
- A per-channel override allowlist that re-enables embeds for specific channels even when global suppression is on.

Out of scope:

- Editing or suppressing embeds on messages Artemis did not author.
- Suppressing embeds on messages the model never causes Artemis to send.
- Any model-prompt or harness-level mechanism. The harness and system prompt are unchanged.

## Observable behavior

- Every message Artemis sends to Discord has link embeds suppressed by default, regardless of whether the model's output contained URLs or requested embed handling.
- Suppression is applied by the Discord adapter when it builds the outgoing message payload, not by PI, the model, or the system prompt.
- When suppression is disabled globally via configuration, Artemis sends messages without the suppress-embeds flag, so Discord renders link embeds normally.
- When a specific channel is listed in the per-channel override allowlist, Artemis sends messages in that channel without the suppress-embeds flag, even while every other channel remains suppressed.
- A guild thread resolves its override channel through its parent channel, matching the conversation-identity rule that a thread belongs to its parent guild channel.
- Slash-command replies also carry the suppress-embeds flag by default, so the guarantee covers every outbound message, not only chat responses.

## Contracts and data flow

The Discord adapter owns suppression. It exposes no new event or port to the conversation coordinator; the change is confined to the outbound payload construction inside `DiscordGateway`.

The adapter provides a private helper that, given a content string and an effective channel ID, returns the message-send options object:

```text
messageOptions(content, channelId) -> { content, flags? }
  if global suppress is off -> { content }
  else if channelId is in the embed allowlist -> { content }
  else -> { content, flags: MessageFlags.SuppressEmbeds }
```

The effective channel ID for a normal message is the parent channel ID when the message originated in a guild thread, otherwise the channel ID. The effective channel ID for a slash-command interaction is the thread parent when the interaction occurred in a thread, otherwise the interaction channel ID. This matches the existing parent-channel resolution used for authorization and conversation identity.

`handleMessage` calls `messageOptions` for every chunk it sends, both guild replies and DM channel sends. `handleInteraction` calls `messageOptions` for every slash-command reply. Discord.js accepts `MessageFlags.SuppressEmbeds` in the `flags` field of `MessageCreateOptions` and `InteractionReplyOptions`.

The conversation coordinator, PI gateway, repository, and system prompt are unchanged. The model never participates in the decision.

## Configuration

Two environment variables, loaded and validated by `parseConfig`:

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `DISCORD_SUPPRESS_EMBEDS` | No | `true` | Global switch. `true` suppresses link embeds on every outbound message. `false` disables suppression globally so Discord renders embeds normally. Must be `true` or `false`; any other value fails startup. |
| `DISCORD_EMBEDS_ALLOWED_CHANNEL_ID` | No | Empty list | Comma-separated channel IDs where link embeds are re-enabled even when global suppression is on. Values are trimmed and deduplicated. A blank list re-enables embeds nowhere. Threads resolve through their parent channel, so list the parent channel ID to re-enable embeds in a thread. |

`discordSuppressEmbeds` defaults to `true`, so an operator who adds no configuration gets embeds suppressed. The override is strictly re-enabling: it cannot add suppression when the global switch is `false`.

`.env.example` documents both variables with the default values above.

## Persistence

No persistence change. Embed-suppression state is configuration loaded at startup and is not stored in SQLite. No new table, migration, or conversation field is introduced.

## Security and privacy

Suppressing embeds reduces information leakage because Discord no longer fetches and renders preview metadata for URLs the model emits. The setting does not change what Artemis logs or persists; URLs in message content remain subject to the existing audit-logging and SQLite-retention rules. No secret is added or exposed by this feature.

## Failure handling

- Invalid `DISCORD_SUPPRESS_EMBEDS` value fails startup with an actionable field name before Discord connects.
- A malformed `DISCORD_EMBEDS_ALLOWED_CHANNEL_ID` entry is treated like the other comma-separated Discord ID lists: it is trimmed and kept as-is. Channel IDs are opaque snowflakes, so no format validation is applied beyond nonblank trimming and deduplication, matching `DISCORD_ALLOWED_CHANNEL_ID`.
- A failure to send a Discord message follows the existing message-handler error path. The suppress-embeds flag is a static payload field and has no failure mode of its own.

## Verification

Unit tests in `test/discord-gateway.test.ts` and `test/config.test.ts` prove:

- `parseConfig` defaults `discordSuppressEmbeds` to `true` and `discordEmbedsAllowedChannelIds` to an empty list.
- `DISCORD_SUPPRESS_EMBEDS=false` disables suppression, `true` keeps it, and any other value fails startup.
- `DISCORD_EMBEDS_ALLOWED_CHANNEL_ID` is parsed as a trimmed, deduplicated list, with blank and absent values yielding an empty list.
- Guild reply chunks and DM channel-send chunks carry `MessageFlags.SuppressEmbeds` by default.
- Slash-command replies carry `MessageFlags.SuppressEmbeds` by default.
- `suppressEmbeds: false` omits the flag entirely.
- A channel in the override allowlist omits the flag while a non-listed channel still gets it.
- A thread resolves the override through its parent channel.

## References

- [Baseline design](baseline.md)
- [Clean-room rebuild guide](rebuild-guide.md)
- [HSV-AI/artemis issue #27](https://github.com/HSV-AI/artemis/issues/27)