import { describe, expect, it, vi } from "vitest";
import type { ChannelTimezoneStore } from "../src/domain.js";
import { createChannelTimezoneTools, isValidTimezone } from "../src/timezone-tools.js";

const conversationKey = "guild:guild-1:channel:channel-1";

function fixedNow(instant: string): () => Date {
  return () => new Date(instant);
}

function storeMock(initial: Record<string, string> = {}): ChannelTimezoneStore {
  const settings = new Map(Object.entries(initial));
  return {
    getChannelTimezone: vi.fn((key: string) => settings.get(key)),
    setChannelTimezone: vi.fn((key: string, timezone: string) => {
      settings.set(key, timezone);
    })
  };
}

// Tool definitions carry precise parameter types, so the helper invokes each
// execute through a never-typed signature that every tool satisfies.
type ToolTextResult = { content: ReadonlyArray<{ type: string; text?: string }> };

function executeTool(
  tool: { execute: (...args: never[]) => Promise<ToolTextResult> },
  params: unknown
): Promise<string> {
  return tool
    .execute("call" as never, params as never, undefined as never, undefined as never, {} as never)
    .then((result) => {
      const text = result.content[0]?.text;
      if (typeof text !== "string") {
        throw new Error("tool returned no text content");
      }
      return text;
    });
}

describe("timezone identifier validation", () => {
  it("accepts IANA identifiers, aliases, and case variants", () => {
    expect(isValidTimezone("America/Chicago")).toBe(true);
    expect(isValidTimezone("Europe/Berlin")).toBe(true);
    expect(isValidTimezone("US/Central")).toBe(true);
    expect(isValidTimezone("america/chicago")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
  });

  it("rejects unknown identifiers, blank input, and embedded controls", () => {
    expect(isValidTimezone("Not/AZone")).toBe(false);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("America/Chicago\n")).toBe(false);
    expect(isValidTimezone(" America/Chicago")).toBe(false);
  });
});

describe("set_channel_timezone", () => {
  it("stores a valid timezone under the harness-injected conversation key", async () => {
    const store = storeMock();
    const [setChannelTimezone] = createChannelTimezoneTools(
      store,
      { conversationKey },
      fixedNow("2026-08-29T14:15:00.000Z")
    );

    const text = await executeTool(setChannelTimezone, { timezone: "America/Chicago" });

    expect(store.setChannelTimezone).toHaveBeenCalledWith(conversationKey, "America/Chicago");
    expect(text).toContain("America/Chicago");
    expect(text).toContain("UTC-05:00");
    expect(text).toContain("2026-08-29T09:15:00-05:00");
  });

  it("returns a clear error for an invalid timezone and writes nothing", async () => {
    const store = storeMock();
    const [setChannelTimezone] = createChannelTimezoneTools(
      store,
      { conversationKey },
      fixedNow("2026-08-29T14:15:00.000Z")
    );

    const text = await executeTool(setChannelTimezone, { timezone: "Not/AZone" });

    expect(store.setChannelTimezone).not.toHaveBeenCalled();
    expect(text).toContain("Error:");
    expect(text).toContain("Not/AZone");
    expect(text).toMatch(/IANA timezone/i);
  });

  it("treats a missing timezone argument as invalid without writing", async () => {
    const store = storeMock();
    const [setChannelTimezone] = createChannelTimezoneTools(
      store,
      { conversationKey },
      fixedNow("2026-08-29T14:15:00.000Z")
    );

    const text = await executeTool(setChannelTimezone, {});

    expect(store.setChannelTimezone).not.toHaveBeenCalled();
    expect(text).toContain("Error:");
  });

  it("ignores a model-supplied channel identity and binds the injected key", async () => {
    const store = storeMock();
    const [setChannelTimezone] = createChannelTimezoneTools(
      store,
      { conversationKey },
      fixedNow("2026-08-29T14:15:00.000Z")
    );

    await executeTool(setChannelTimezone, {
      timezone: "Europe/Berlin",
      channel: "dm:not-my-channel",
      conversationKey: "dm:not-my-channel"
    });

    expect(store.setChannelTimezone).toHaveBeenCalledTimes(1);
    expect(store.setChannelTimezone).toHaveBeenCalledWith(conversationKey, "Europe/Berlin");
  });
});

describe("get_current_datetime", () => {
  it("defaults to the stored channel timezone with a DST-correct local time", async () => {
    const store = storeMock({ [conversationKey]: "America/Chicago" });
    const [, getCurrentDatetime] = createChannelTimezoneTools(
      store,
      { conversationKey },
      fixedNow("2026-08-29T14:15:00.000Z")
    );

    const text = await executeTool(getCurrentDatetime, {});

    expect(store.getChannelTimezone).toHaveBeenCalledWith(conversationKey);
    expect(text).toContain("UTC now: 2026-08-29T14:15:00.000Z");
    expect(text).toContain("Timezone: America/Chicago (UTC-05:00, CDT)");
    expect(text).toContain("Local now: 2026-08-29T09:15:00-05:00 (Sat)");
  });

  it("uses the winter offset when daylight saving time is not active", async () => {
    const store = storeMock({ [conversationKey]: "America/Chicago" });
    const [, getCurrentDatetime] = createChannelTimezoneTools(
      store,
      { conversationKey },
      fixedNow("2026-01-15T14:15:00.000Z")
    );

    const text = await executeTool(getCurrentDatetime, {});

    expect(text).toContain("Timezone: America/Chicago (UTC-06:00, CST)");
    expect(text).toContain("Local now: 2026-01-15T08:15:00-06:00 (Thu)");
  });

  it("falls back to UTC when no channel timezone is stored", async () => {
    const store = storeMock();
    const [, getCurrentDatetime] = createChannelTimezoneTools(
      store,
      { conversationKey },
      fixedNow("2026-08-29T14:15:00.000Z")
    );

    const text = await executeTool(getCurrentDatetime, {});

    expect(text).toContain("UTC now: 2026-08-29T14:15:00.000Z");
    expect(text).toContain("Timezone: UTC (UTC+00:00, UTC)");
    expect(text).toContain("Local now: 2026-08-29T14:15:00+00:00 (Sat)");
  });

  it("prefers an explicit timezone parameter over the stored channel timezone", async () => {
    const store = storeMock({ [conversationKey]: "America/Chicago" });
    const [, getCurrentDatetime] = createChannelTimezoneTools(
      store,
      { conversationKey },
      fixedNow("2026-08-29T14:15:00.000Z")
    );

    const text = await executeTool(getCurrentDatetime, { timezone: "Europe/Berlin" });

    expect(text).toContain("Timezone: Europe/Berlin (UTC+02:00, GMT+2)");
    expect(text).toContain("Local now: 2026-08-29T16:15:00+02:00 (Sat)");
    expect(text).toContain("UTC now: 2026-08-29T14:15:00.000Z");
  });

  it("returns a clear error for an invalid explicit timezone", async () => {
    const store = storeMock({ [conversationKey]: "America/Chicago" });
    const [, getCurrentDatetime] = createChannelTimezoneTools(
      store,
      { conversationKey },
      fixedNow("2026-08-29T14:15:00.000Z")
    );

    const text = await executeTool(getCurrentDatetime, { timezone: "Mars/Olympus" });

    expect(text).toContain("Error:");
    expect(text).toContain("Mars/Olympus");
   });

  it("falls back to UTC when the stored timezone is no longer valid", async () => {
    const store = storeMock({ [conversationKey]: "Not/AZone" });
    const [, getCurrentDatetime] = createChannelTimezoneTools(
      store,
      { conversationKey },
      fixedNow("2026-08-29T14:15:00.000Z")
    );

    const text = await executeTool(getCurrentDatetime, {});

    expect(text).toContain("Timezone: UTC (UTC+00:00, UTC)");
    expect(text).toContain("Local now: 2026-08-29T14:15:00+00:00 (Sat)");
  });

  it("ignores a model-supplied channel identity when reading", async () => {
    const store = storeMock({ [conversationKey]: "America/Chicago" });
    const [, getCurrentDatetime] = createChannelTimezoneTools(
      store,
      { conversationKey },
      fixedNow("2026-08-29T14:15:00.000Z")
    );

    await executeTool(getCurrentDatetime, { channel: "dm:not-my-channel" });

    expect(store.getChannelTimezone).toHaveBeenCalledWith(conversationKey);
  });
});

describe("tool registry metadata", () => {
  it("advertises both tools with trust-boundary guidelines", () => {
    const store = storeMock();
    const [setChannelTimezone, getCurrentDatetime] = createChannelTimezoneTools(
      store,
      { conversationKey }
    );

    expect(setChannelTimezone.name).toBe("set_channel_timezone");
    expect(setChannelTimezone.promptSnippet).toBeTruthy();
    expect(setChannelTimezone.promptGuidelines?.join("\n")).toMatch(/explicitly/i);
    expect(setChannelTimezone.description).toMatch(/IANA/);

    expect(getCurrentDatetime.name).toBe("get_current_datetime");
    expect(getCurrentDatetime.promptSnippet).toBeTruthy();
    expect(getCurrentDatetime.promptGuidelines?.join("\n")).toMatch(/current date|current time/i);
  });
});