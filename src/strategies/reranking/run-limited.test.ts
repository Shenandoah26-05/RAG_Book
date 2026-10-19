import { describe, expect, it } from "vitest";
import { runLimited } from "./run-limited.js";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("runLimited", () => {
  it("gives the results in the order of the items, whichever finishes first", async () => {
    const results = await runLimited([30, 5, 15, 1], 4, async (ms, index) => {
      await wait(ms);
      return `${index.toString()}:${ms.toString()}`;
    });
    expect(results).toEqual(["0:30", "1:5", "2:15", "3:1"]);
  });

  it("never runs more than the limit at once, and does use the whole limit", async () => {
    let running = 0;
    let peak = 0;
    await runLimited(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await wait(5);
        running -= 1;
      },
    );
    expect(peak).toBe(3);
  });

  it("works with a limit larger than the number of items, and with no items", async () => {
    expect(await runLimited([1, 2], 10, (x) => Promise.resolve(x * 2))).toEqual([2, 4]);
    expect(await runLimited([], 3, () => Promise.resolve(1))).toEqual([]);
  });

  it("throws the first error and starts nothing new after it", async () => {
    const started: number[] = [];
    await expect(
      runLimited([0, 1, 2, 3, 4, 5], 2, async (item) => {
        started.push(item);
        await wait(5);
        if (item === 1) throw new Error("boom");
        return item;
      }),
    ).rejects.toThrow("boom");
    // items 0 and 1 started first; 1 failed; 0 finished and may have taken one more, never all
    expect(started.length).toBeLessThan(6);
  });
});
