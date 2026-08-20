import type { SourceMessage } from "./domain.js";

interface ModelAuthor {
  id: string;
  name: string;
}

interface ModelDiscordMessage {
  id: string;
  author: ModelAuthor;
  role: SourceMessage["role"];
  content: string;
  timestamp: string;
}

function knownOrUnknown(value: string): string {
  return value.trim() || "unknown";
}

function toModelDiscordMessage(message: SourceMessage): ModelDiscordMessage {
  return {
    id: message.discordMessageId,
    author: {
      id: knownOrUnknown(message.authorId),
      name: knownOrUnknown(message.authorName)
    },
    role: message.role,
    content: message.content,
    timestamp: message.createdAt
  };
}

export function formatDiscordMessage(message: SourceMessage): string {
  return JSON.stringify({ discordMessage: toModelDiscordMessage(message) });
}

export function formatThreadSnapshot(messages: SourceMessage[]): string {
  const ordered = [...messages].sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)
  );
  return [
    "The following JSON contains the complete Discord thread. Respond to the newest message in context.",
    JSON.stringify({ discordThread: ordered.map(toModelDiscordMessage) })
  ].join("\n\n");
}
