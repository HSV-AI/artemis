import { describe, expect, it } from "vitest";
import { KeyedSerialQueue } from "../src/keyed-queue.js";

describe("KeyedSerialQueue", () => {
  it("serializes work for one key and allows different keys to proceed", async () => {
    const queue = new KeyedSerialQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run("same", async () => {
      events.push("first-start");
      await firstGate;
      events.push("first-end");
      return 1;
    });
    const second = queue.run("same", async () => {
      events.push("second");
      return 2;
    });
    const other = queue.run("other", async () => {
      events.push("other");
      return 3;
    });

    await other;
    expect(events).toEqual(["first-start", "other"]);
    releaseFirst?.();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(["first-start", "other", "first-end", "second"]);
  });

  it("releases a key after an operation throws", async () => {
    const queue = new KeyedSerialQueue();
    await expect(
      queue.run("key", async () => {
        throw new Error("failure");
      })
    ).rejects.toThrow("failure");
    await expect(queue.run("key", async () => "recovered")).resolves.toBe("recovered");
  });
});
