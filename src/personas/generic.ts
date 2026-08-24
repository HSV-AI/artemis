/**
 * Generic profile. This is the default persona: it intentionally defines no
 * fixed identity name, so the bot's display name is resolved from the
 * connected Discord client at startup and used for self-introduction. The
 * `name` field is intentionally blank; `buildSystemPrompt` falls back to the
 * configured default display name when Discord has not reported one.
 */
export const GENERIC_PROFILE = {
  id: "generic",
  name: "",
  instructions: "You are a helpful conversational assistant in Discord."
} as const;