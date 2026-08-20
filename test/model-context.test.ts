import { describe, expect, it } from "vitest";
import { formatDiscordMessage, formatThreadSnapshot } from "../src/model-context.js";
import type { SourceMessage } from "../src/domain.js";

function source(overrides: Partial<SourceMessage> = {}): SourceMessage {
  return {
    discordMessageId: "message-1",
    authorId: "user-1",
    authorName: "User One",
    role: "user",
    content: "Hello Artemis",
    createdAt: "2026-08-20T12:00:00.000Z",
    ...overrides
  };
}

describe("model context", () => {
  it("encodes message content separately from explicit author metadata", () => {
    const formatted = formatDiscordMessage(
      source({ content: 'User Two said "hello"\nthen left.' })
    );

    expect(JSON.parse(formatted)).toEqual({
      discordMessage: {
        id: "message-1",
        author: { id: "user-1", name: "User One" },
        role: "user",
        content: 'User Two said "hello"\nthen left.',
        timestamp: "2026-08-20T12:00:00.000Z"
      }
    });
  });

  it("orders a thread while preserving each distinct speaker", () => {
    const formatted = formatThreadSnapshot([
      source({
        discordMessageId: "message-2",
        authorId: "user-2",
        authorName: "User Two",
        content: "second question",
        createdAt: "2026-08-20T12:00:02.000Z"
      }),
      source({ content: "first question" })
    ]);
    const payload = JSON.parse(formatted.split("\n\n")[1] ?? "{}");

    expect(payload.discordThread).toEqual([
      expect.objectContaining({
        author: { id: "user-1", name: "User One" },
        content: "first question"
      }),
      expect.objectContaining({
        author: { id: "user-2", name: "User Two" },
        content: "second question"
      })
    ]);
  });

  it("marks unavailable author fields as unknown", () => {
    expect(JSON.parse(formatDiscordMessage(source({ authorId: " ", authorName: "" })))).toEqual(
      expect.objectContaining({
        discordMessage: expect.objectContaining({
          author: { id: "unknown", name: "unknown" }
        })
      })
    );
  });
});
