import { describe, expect, it } from "vitest";
import { RagError } from "../../shared/index.js";
import { CrossEncoderScorer } from "./cross-encoder-scorer.js";
import type { PairScorer } from "./transformers-backend.js";

/** A fake model that scores a passage by its length, and records every batch it is given. */
function fakeModel(): { load: () => Promise<PairScorer>; batches: string[][]; loads: number } {
  const state = { batches: [] as string[][], loads: 0 };
  return {
    get batches() {
      return state.batches;
    },
    get loads() {
      return state.loads;
    },
    load: () => {
      state.loads += 1;
      return Promise.resolve((_query: string, passages: readonly string[]) => {
        state.batches.push([...passages]);
        return Promise.resolve(passages.map((p) => p.length));
      });
    },
  };
}

const passages = ["a", "bb", "ccc", "dddd", "eeeee"];

describe("CrossEncoderScorer", () => {
  it("is called cross-encoder", () => {
    expect(new CrossEncoderScorer({ load: fakeModel().load }).name).toBe("cross-encoder");
  });

  it("returns one score per passage, in the passages' order", async () => {
    const scorer = new CrossEncoderScorer({ load: fakeModel().load });
    expect(await scorer.score("q", passages)).toEqual([1, 2, 3, 4, 5]);
  });

  it("scores in batches of batchSize, in order, and puts the scores back together", async () => {
    const model = fakeModel();
    const scorer = new CrossEncoderScorer({ load: model.load, batchSize: 2 });
    expect(await scorer.score("q", passages)).toEqual([1, 2, 3, 4, 5]);
    expect(model.batches).toEqual([["a", "bb"], ["ccc", "dddd"], ["eeeee"]]);
  });

  it("uses batches of 8 by default", async () => {
    const model = fakeModel();
    const many = Array.from({ length: 20 }, (_, i) => "x".repeat(i + 1));
    await new CrossEncoderScorer({ load: model.load }).score("q", many);
    expect(model.batches.map((b) => b.length)).toEqual([8, 8, 4]);
  });

  it("gives no scores, and loads nothing, for no passages", async () => {
    const model = fakeModel();
    expect(await new CrossEncoderScorer({ load: model.load }).score("q", [])).toEqual([]);
    expect(model.loads).toBe(0);
  });

  it("loads the model on first use, once, even for overlapping calls", async () => {
    const model = fakeModel();
    const scorer = new CrossEncoderScorer({ load: model.load });
    expect(model.loads).toBe(0); // building the scorer loads nothing
    await Promise.all([
      scorer.score("q", ["a"]),
      scorer.score("q", ["b"]),
      scorer.score("q", ["c"]),
    ]);
    await scorer.score("q", ["d"]);
    expect(model.loads).toBe(1);
  });

  it("does not remember a failed load: the next call tries again", async () => {
    let attempts = 0;
    const good = fakeModel();
    const scorer = new CrossEncoderScorer({
      load: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new RagError("PROVIDER_UNAVAILABLE", "offline"))
          : good.load();
      },
    });
    await expect(scorer.score("q", ["a"])).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(await scorer.score("q", ["a"])).toEqual([1]);
    expect(attempts).toBe(2);
  });

  it("fails with INTERNAL if the model returns the wrong number of scores for a batch", async () => {
    const scorer = new CrossEncoderScorer({
      load: () => Promise.resolve(() => Promise.resolve([1])),
    });
    await expect(scorer.score("q", ["a", "b"])).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects batchSize %s as INVALID_ARGUMENT", (batchSize) => {
    expect(() => new CrossEncoderScorer({ batchSize })).toThrow(RagError);
  });
});
