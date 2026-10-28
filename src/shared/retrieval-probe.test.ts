import { describe, expect, it } from "vitest";
import { currentProbe, RetrievalProbe, withProbe } from "./retrieval-probe.js";

describe("RetrievalProbe", () => {
  it("keeps the searches in the order they were recorded", () => {
    const probe = new RetrievalProbe();
    probe.record("dense", []);
    probe.record("bm25", []);
    expect(probe.calls.map((c) => c.name)).toEqual(["dense", "bm25"]);
  });

  it("hands out a copy, so a caller cannot change what was recorded", () => {
    const probe = new RetrievalProbe();
    probe.record("dense", []);
    (probe.calls as unknown[]).push("x");
    expect(probe.calls).toHaveLength(1);
  });
});

describe("withProbe", () => {
  it("has no probe outside a question", () => {
    expect(currentProbe()).toBeUndefined();
  });

  it("puts the probe in scope for the work it starts, including after an await", async () => {
    const probe = new RetrievalProbe();
    const seen = await withProbe(probe, async () => {
      await Promise.resolve();
      return currentProbe();
    });
    expect(seen).toBe(probe);
    expect(currentProbe()).toBeUndefined();
  });

  it("keeps concurrent questions apart", async () => {
    const [a, b] = [new RetrievalProbe(), new RetrievalProbe()];
    const run = (probe: RetrievalProbe, delay: number) =>
      withProbe(probe, async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        currentProbe()?.record(probe === a ? "a" : "b", []);
      });
    await Promise.all([run(a, 10), run(b, 1)]);
    expect(a.calls.map((c) => c.name)).toEqual(["a"]);
    expect(b.calls.map((c) => c.name)).toEqual(["b"]);
  });
});
