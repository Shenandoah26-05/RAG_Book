import { RagError } from "../../shared/index.js";

/** Scores one batch of (question, passage) pairs: one number per passage. */
export type PairScorer = (query: string, passages: readonly string[]) => Promise<readonly number[]>;

export interface TransformersBackendOptions {
  /** A Hugging Face id of a cross-encoder with an ONNX build. */
  readonly model: string;
  /** The longest question + passage, in tokens, before the tail is cut off. */
  readonly maxLength: number;
}

/**
 * Loads a cross-encoder with transformers.js and returns a function that scores a batch of pairs.
 * The library is imported here, not at the top of the file, so merely importing this module (or
 * building a pipeline that never reranks) does not load the runtime. The model is downloaded on
 * first use and kept in the library's cache.
 * @throws RagError PROVIDER_UNAVAILABLE if the library or the model cannot be loaded
 */
export async function loadTransformersBackend(
  options: TransformersBackendOptions,
): Promise<PairScorer> {
  try {
    const { AutoTokenizer, AutoModelForSequenceClassification } =
      await import("@huggingface/transformers");
    const tokenizer = await AutoTokenizer.from_pretrained(options.model);
    // the 8-bit build is about a quarter of the size of the full-precision one
    const model = await AutoModelForSequenceClassification.from_pretrained(options.model, {
      dtype: "q8",
    });
    return async (query, passages) => {
      const inputs = tokenizer(
        passages.map(() => query),
        {
          text_pair: [...passages],
          padding: true,
          truncation: true,
          max_length: options.maxLength,
        },
      );
      const { logits } = (await model(inputs)) as { logits: { data: ArrayLike<number> } };
      return Array.from(logits.data);
    };
  } catch (error) {
    throw new RagError(
      "PROVIDER_UNAVAILABLE",
      `Could not load the cross-encoder model ${options.model}. The first use downloads it, ` +
        "so it needs a network connection once; after that it runs offline.",
      { cause: error },
    );
  }
}
