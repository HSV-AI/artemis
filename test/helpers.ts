import { vi } from "vitest";
import type { InboundMessage, Logger, PiGateway, PiGenerationResult } from "../src/domain.js";

export function createLoggerMock(): Logger {
  return {
    audit: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

export function createPiMock(result?: Partial<PiGenerationResult>): PiGateway {
  return {
    checkHealth: vi.fn().mockResolvedValue(undefined),
    generate: vi.fn().mockResolvedValue({
      text: "assistant response",
      model: "test-model",
      ...result
    })
  };
}

export function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    discordMessageId: "message-1",
    authorId: "603384387685449728",
    authorName: "Matt",
    role: "user",
    content: "Hello Artemis",
    createdAt: "2026-08-19T12:00:00.000Z",
    channelId: "channel-1",
    isBot: false,
    mentionsBot: false,
    repliesToBot: false,
    ...overrides
  };
}
