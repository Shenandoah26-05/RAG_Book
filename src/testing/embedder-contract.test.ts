import { describe, expect, it } from "vitest";
import type { Embedder } from "../core/index.js";
import {
  checkEmbedder,
  describeEmbedderContract,
  type EmbedderViolationCode,
} from "./embedder-contract.testing.js";

/** Hashes a text into a deterministic unit vector. */
function hashVector(text: string, dimensions: number): Float32Array {
  const v = new Float32Array(dimensions);
  for (let i = 0; i < text.length; i++)
    v[i % dimensions] = (v[i % dimensions] ?? 0) + text.charCodeAt(i) + 1;
  const length = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / length);
}

/** A correct reference embedder. It exists only to show the contract accepts a good one. */
class ReferenceEmbedder implements Embedder {
  readonly modelId = "reference:hash";
  readonly dimensions = 8;
  // a symmetric model: `kind` makes no difference
  embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    return Promise.resolve(texts.map((t) => hashVector(t, this.dimensions)));
  }
}

const reference: Embedder = new ReferenceEmbedder();

/** The reference embedder with one part replaced, to show the contract notices the break. */
function broken(override: Partial<Embedder>): Embedder {
  return {
    modelId: reference.modelId,
    dimensions: reference.dimensions,
    embed: (texts, kind) => reference.embed(texts, kind),
    ...override,
  };
}

describeEmbedderContract("reference embedder", () => new ReferenceEmbedder());

describe("embedder contract catches broken embedders", () => {
  const cases: [EmbedderViolationCode, Embedder][] = [
    ["wrong-count", broken({ embed: (t, k) => reference.embed(t.slice(1), k) })],
    ["wrong-dimensions", broken({ dimensions: 4 })],
    [
      "not-normalised",
      broken({
        embed: async (t, k) => (await reference.embed(t, k)).map((v) => v.map((x) => x * 2)),
      }),
    ],
    [
      "non-finite",
      broken({ embed: (t) => Promise.resolve(t.map(() => new Float32Array(8).fill(Number.NaN))) }),
    ],
    [
      "not-in-order",
      broken({ embed: async (t, k) => (await reference.embed(t, k)).slice().reverse() }),
    ],
    [
      "not-deterministic",
      broken({
        embed: (t) => Promise.resolve(t.map(() => hashVector(Math.random().toString(), 8))),
      }),
    ],
    [
      "nonempty-for-empty",
      broken({ embed: (t, k) => reference.embed(t.length === 0 ? ["x"] : t, k) }),
    ],
  ];

  it.each(cases)("reports %s", async (code, embedder) => {
    const violations = await checkEmbedder(embedder, "document");
    expect(violations.map((v) => v.code)).toContain(code);
  });
});
