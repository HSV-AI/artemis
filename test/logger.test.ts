import { describe, expect, it, vi } from "vitest";
import { JsonLogger, safeError } from "../src/logger.js";

describe("JsonLogger", () => {
  it("writes structured entries at or above the configured level", () => {
    const write = vi.fn();
    const persist = vi.fn();
    const logger = new JsonLogger("info", write, persist);
    logger.debug("hidden");
    logger.info("ready", { guildId: "guild" });
    logger.warn("warning");
    logger.error("failed", { token: undefined });

    expect(write).toHaveBeenCalledTimes(3);
    expect(persist).toHaveBeenCalledTimes(3);
    expect(JSON.parse(write.mock.calls[0]?.[0] as string)).toMatchObject({
      level: "info",
      event: "ready",
      guildId: "guild"
    });
    expect(persist.mock.calls[0]?.[0]).toEqual(JSON.parse(write.mock.calls[0]?.[0] as string));
  });

  it("keeps console logging available when persistence fails", () => {
    const write = vi.fn();
    const logger = new JsonLogger("debug", write, () => {
      throw new Error("database unavailable");
    });

    expect(() => logger.info("ready", { guildId: "guild" })).not.toThrow();
    expect(write).toHaveBeenCalledTimes(2);
    expect(JSON.parse(write.mock.calls[0]?.[0] as string)).toMatchObject({ event: "ready" });
    expect(JSON.parse(write.mock.calls[1]?.[0] as string)).toMatchObject({
      level: "error",
      event: "log_persistence_failed",
      originalEvent: "ready",
      errorMessage: "database unavailable"
    });
  });
});

describe("safeError", () => {
  it("normalizes Error and non-Error values", () => {
    expect(safeError(new TypeError("bad"))).toEqual({ errorName: "TypeError", errorMessage: "bad" });
    expect(safeError("bad")).toEqual({ errorName: "UnknownError", errorMessage: "bad" });
  });
});
