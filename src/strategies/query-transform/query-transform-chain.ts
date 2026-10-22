import type { Query, QueryTransformer, TransformOptions } from "../../core/index.js";
import { RagError } from "../../shared/index.js";

/**
 * Runs transformers one after another, each on the query the one before returned (chain of
 * responsibility, like `CleaningChain`). The chain is itself a `QueryTransformer`, so the pipeline
 * does not know whether it has one transformer or four.
 *
 * Order matters in one way: the rewriter goes first, so that the others work on a standalone
 * question and not on "what about chapter 4?".
 */
export class QueryTransformChain implements QueryTransformer {
  readonly name: string;
  readonly #transformers: readonly QueryTransformer[];

  /** @throws RagError INVALID_ARGUMENT for an empty chain */
  constructor(transformers: readonly QueryTransformer[]) {
    if (transformers.length === 0) {
      throw new RagError(
        "INVALID_ARGUMENT",
        "A query transform chain needs at least one transformer",
      );
    }
    this.#transformers = transformers;
    this.name = `chain(${transformers.map((t) => t.name).join(">")})`;
  }

  async transform(query: Query, options: TransformOptions = {}): Promise<Query> {
    let current = query;
    for (const transformer of this.#transformers) {
      options.signal?.throwIfAborted();
      current = await transformer.transform(current, options);
    }
    return current;
  }
}
