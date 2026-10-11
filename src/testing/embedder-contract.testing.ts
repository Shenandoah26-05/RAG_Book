// The contract every Embedder must meet (see core/ports/embedder.ts). Used by each embedder's own
// test through `describeEmbedderContract`. Not part of the build.
//
// Like the chunker contract, the checks are plain functions that return the violations they find,
// as data, so that the contract itself can be tested with deliberately broken embedders
// (embedder-contract.test.ts).
import { describe, expect, it } from "vitest";
import type { EmbedKind, Embedder } from "../core/index.js";

export type EmbedderViolationCode =
  | "wrong-count" // not one vector per input text
  | "wrong-dimensions" // a vector's length differs from `dimensions`
  | "not-normalised" // a vector's length is not 1
  | "non-finite" // a vector holds NaN or Infinity
  | "not-in-order" // vectors do not follow the order of the texts
  | "not-deterministic" // the same texts gave different vectors
  | "nonempty-for-empty"; // vectors for an empty input

export interface EmbedderViolation {
  readonly code: EmbedderViolationCode;
  readonly message: string;
  /** Index of the offending vector, when the violation is about one vector. */
  readonly vector?: number;
}

/** One line per violation, for a test failure message. */
export function formatEmbedderViolations(violations: readonly EmbedderViolation[]): string {
  return violations
    .map(
      (v) =>
        `${v.code}${v.vector === undefined ? "" : ` (vector ${v.vector.toString()})`}: ${v.message}`,
    )
    .join("\n");
}

/** How far from 1 a vector's length may be: Float32 rounding, not a real error. */
const NORM_TOLERANCE = 1e-4;

const norm = (v: Float32Array): number => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));

const sameVector = (a: Float32Array, b: Float32Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Texts used by the contract. Distinct, so an embedder that mixes up the order is caught. */
export const embedderFixtureTexts: readonly string[] = [
  "How does retrieval-augmented generation work?",
  "Chunks are embedded and stored in a vector index.",
  "A third, quite different sentence about cooking pasta.",
];

/** Runs every check for one `kind` and returns the violations (empty when the embedder is fine). */
export async function checkEmbedder(
  embedder: Embedder,
  kind: EmbedKind,
  texts: readonly string[] = embedderFixtureTexts,
): Promise<readonly EmbedderViolation[]> {
  const violations: EmbedderViolation[] = [];

  const empty = await embedder.embed([], kind);
  if (empty.length !== 0) {
    violations.push({
      code: "nonempty-for-empty",
      message: `got ${empty.length.toString()} vectors for no texts`,
    });
  }

  const vectors = await embedder.embed(texts, kind);
  if (vectors.length !== texts.length) {
    violations.push({
      code: "wrong-count",
      message: `${texts.length.toString()} texts gave ${vectors.length.toString()} vectors`,
    });
    return violations; // the per-vector checks below would only add noise
  }

  vectors.forEach((vector, i) => {
    if (vector.length !== embedder.dimensions) {
      violations.push({
        code: "wrong-dimensions",
        vector: i,
        message: `length ${vector.length.toString()}, expected ${embedder.dimensions.toString()}`,
      });
    }
    if (!vector.every(Number.isFinite)) {
      violations.push({ code: "non-finite", vector: i, message: "holds NaN or Infinity" });
    } else if (Math.abs(norm(vector) - 1) > NORM_TOLERANCE) {
      violations.push({
        code: "not-normalised",
        vector: i,
        message: `L2 norm is ${norm(vector).toString()}, expected 1`,
      });
    }
  });

  // Order: embedding a text alone must give the same vector as embedding it inside the batch.
  for (const [i, text] of texts.entries()) {
    const alone = (await embedder.embed([text], kind))[0];
    const inBatch = vectors[i];
    if (alone === undefined || inBatch === undefined) continue;
    if (!sameVector(alone, inBatch)) {
      violations.push({
        code: "not-in-order",
        vector: i,
        message: "differs from the vector for the same text embedded alone",
      });
    }
  }

  const again = await embedder.embed(texts, kind);
  const changed =
    again.length !== vectors.length ||
    again.some((v, i) => {
      const first = vectors[i];
      return first === undefined || !sameVector(v, first);
    });
  if (changed) {
    violations.push({
      code: "not-deterministic",
      message: "embedding the same texts twice gave different vectors",
    });
  }

  return violations;
}

/** Registers the contract tests for an embedder. Call it from the embedder's own test file. */
export function describeEmbedderContract(name: string, makeEmbedder: () => Embedder): void {
  describe(`${name} meets the Embedder contract`, () => {
    it("has a model id and positive dimensions", () => {
      const embedder = makeEmbedder();
      expect(embedder.modelId).not.toBe("");
      expect(embedder.dimensions).toBeGreaterThan(0);
    });

    for (const kind of ["query", "document"] as const) {
      it(`returns ordered, unit-length vectors of the right size for kind ${kind}`, async () => {
        const violations = await checkEmbedder(makeEmbedder(), kind);
        expect(violations, formatEmbedderViolations(violations)).toEqual([]);
      });
    }
  });
}
