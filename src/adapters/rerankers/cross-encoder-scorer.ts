import type { RelevanceScorer } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { loadTransformersBackend } from "./transformers-backend.js";
import type { PairScorer } from "./transformers-backend.js";

/** The MS MARCO MiniLM cross-encoder, converted to ONNX for transformers.js (about 23 MB, 8-bit). */
export const DEFAULT_CROSS_ENCODER_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
export const DEFAULT_BATCH_SIZE = 8;
/** The model's own limit: longer pairs are cut off. */
export const DEFAULT_MAX_LENGTH = 512;

export interface CrossEncoderScorerOptions {
  readonly model?: string;
  /** Pairs scored per model call. A whole number of 1 or more. */
  readonly batchSize?: number;
  readonly maxLength?: number;
  /** Loads the model. Replaced in tests, so they need no download. */
  readonly load?: () => Promise<PairScorer>;
}

/**
 * Scores (question, passage) pairs with a cross-encoder running inside this process.
 *
 * A bi-encoder (the `Embedder`) turns the question and each passage into vectors separately, so
 * the passages can be embedded once, ahead of time. A cross-encoder reads the question and one
 * passage **together**, so it can judge how they relate, which is more accurate but means one model
 * run per candidate at question time. That is why it reorders the few candidates a retriever found
 * instead of searching the whole book.
 *
 * - The model loads on the first `score` call, once, however many calls overlap. A failed load is
 *   not remembered, so the next call tries again.
 * - Candidates go through the model `batchSize` at a time, in order, and the scores are put back
 *   in the order of the passages.
 * - A score is the model's raw logit: higher is more relevant, and only comparable within a call.
 */
export class CrossEncoderScorer implements RelevanceScorer {
  readonly name = "cross-encoder";

  readonly #batchSize: number;
  readonly #load: () => Promise<PairScorer>;
  #loaded: Promise<PairScorer> | undefined;

  /** @throws RagError INVALID_ARGUMENT if `batchSize` is not a whole number of 1 or more */
  constructor(options: CrossEncoderScorerOptions = {}) {
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `batchSize must be a whole number of 1 or more, got ${String(batchSize)}`,
      );
    }
    this.#batchSize = batchSize;
    const model = options.model ?? DEFAULT_CROSS_ENCODER_MODEL;
    const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
    this.#load = options.load ?? (() => loadTransformersBackend({ model, maxLength }));
  }

  async score(query: string, passages: readonly string[]): Promise<readonly number[]> {
    if (passages.length === 0) return [];
    const scorePairs = await this.#backend();

    const scores: number[] = [];
    for (let start = 0; start < passages.length; start += this.#batchSize) {
      const batch = passages.slice(start, start + this.#batchSize);
      const batchScores = await scorePairs(query, batch);
      if (batchScores.length !== batch.length) {
        throw new RagError(
          "INTERNAL",
          `The cross-encoder returned ${batchScores.length.toString()} scores for ${batch.length.toString()} passages`,
        );
      }
      scores.push(...batchScores);
    }
    return scores;
  }

  #backend(): Promise<PairScorer> {
    this.#loaded ??= this.#load().catch((error: unknown) => {
      this.#loaded = undefined; // do not remember a failure
      throw error;
    });
    return this.#loaded;
  }
}
