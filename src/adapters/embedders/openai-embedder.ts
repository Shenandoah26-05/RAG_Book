import { z } from "zod";
import type { Embedder } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import type { OpenAiEndpoint } from "../openai-compatible/index.js";

/** Vector lengths of the models OpenAI sells. Other servers' models need the length given. */
export const KNOWN_OPENAI_EMBEDDING_DIMENSIONS: ReadonlyMap<string, number> = new Map([
  ["text-embedding-3-small", 1536],
  ["text-embedding-3-large", 3072],
  ["text-embedding-ada-002", 1536],
]);

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface OpenAiEmbedderOptions {
  readonly endpoint: OpenAiEndpoint;
  /** Model name as the server knows it, e.g. "text-embedding-3-small". */
  readonly model: string;
  /** Length of the model's vectors. Every response is checked against it. */
  readonly dimensions: number;
  /** Texts per request. Default 32. */
  readonly batchSize?: number;
  /** Time allowed for one request. Default 30 seconds. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/** What `POST /embeddings` returns; extra fields are ignored. */
const embeddingsResponse = z.object({
  data: z.array(z.object({ index: z.number().int().optional(), embedding: z.array(z.number()) })),
});

const positiveInt = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 1) {
    throw new RagError(
      "CONFIG_INVALID",
      `OpenAiEmbedder: ${name} must be a whole number of 1 or more, got ${String(value)}`,
    );
  }
};

/**
 * Embeds text with any server that speaks OpenAI's `POST /embeddings`. The only file that knows
 * this embeddings format.
 *
 * Texts go out in batches of `batchSize`, one request at a time. The server may return the vectors
 * in any order, so they are put back in the order of the texts by their `index`. Each vector is
 * checked against `dimensions` and scaled to length 1, as the `Embedder` port requires. There are no
 * retries here: a retry decorator wraps any provider (RAG-092).
 *
 * These models treat a query and a passage alike, so `kind` makes no difference here.
 */
export class OpenAiEmbedder implements Embedder {
  readonly modelId: string;
  readonly dimensions: number;

  readonly #endpoint: OpenAiEndpoint;
  readonly #model: string;
  readonly #batchSize: number;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  /** @throws RagError CONFIG_INVALID if a size or time is not a usable number */
  constructor(options: OpenAiEmbedderOptions) {
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    positiveInt("dimensions", options.dimensions);
    positiveInt("batchSize", batchSize);
    positiveInt("timeoutMs", timeoutMs);

    this.modelId = `openai-compatible:${options.model}`;
    this.dimensions = options.dimensions;
    this.#endpoint = options.endpoint;
    this.#model = options.model;
    this.#batchSize = batchSize;
    this.#timeoutMs = timeoutMs;
    this.#fetch = options.fetch ?? fetch;
  }

  // Takes no `kind` parameter: it is optional to declare, and these models ignore it.
  async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    const vectors: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += this.#batchSize) {
      vectors.push(...(await this.#embedBatch(texts.slice(start, start + this.#batchSize))));
    }
    return vectors;
  }

  async #embedBatch(batch: readonly string[]): Promise<Float32Array[]> {
    const body = await this.#post(batch);
    const parsed = embeddingsResponse.safeParse(body);
    if (!parsed.success) {
      throw this.#endpoint.notCompatible("unexpected response", parsed.error);
    }
    const { data } = parsed.data;
    if (data.length !== batch.length) {
      throw new RagError(
        "PROVIDER_UNAVAILABLE",
        `The server at ${this.#endpoint.baseUrl} returned ${data.length.toString()} vectors for ${batch.length.toString()} texts`,
      );
    }
    // `index` says which text a vector belongs to; without it the order of the list is used
    const ordered = new Array<readonly number[] | undefined>(batch.length).fill(undefined);
    for (const [position, item] of data.entries()) {
      const at = item.index ?? position;
      if (at < 0 || at >= batch.length || ordered[at] !== undefined) {
        throw this.#endpoint.notCompatible("vector indexes do not match the texts");
      }
      ordered[at] = item.embedding;
    }
    return ordered.map((values) => this.#toUnitVector(values ?? []));
  }

  /** POSTs one batch and returns the parsed JSON body. */
  async #post(batch: readonly string[]): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint.url("/embeddings"), {
        method: "POST",
        headers: this.#endpoint.headers(),
        body: JSON.stringify({ model: this.#model, input: batch, encoding_format: "float" }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      throw this.#endpoint.unreachable(cause);
    }
    if (!response.ok) throw await this.#endpoint.httpError(response, this.#model);
    try {
      return await response.json();
    } catch (cause) {
      throw this.#endpoint.notCompatible("not JSON", cause);
    }
  }

  #toUnitVector(values: readonly number[]): Float32Array {
    if (values.length !== this.dimensions) {
      throw new RagError(
        "CONFIG_INVALID",
        `${this.modelId} returned vectors of length ${values.length.toString()}, but dimensions is ${this.dimensions.toString()}`,
      );
    }
    const vector = Float32Array.from(values);
    const length = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
    if (!Number.isFinite(length) || length === 0) {
      throw new RagError(
        "PROVIDER_UNAVAILABLE",
        `${this.modelId} returned a vector that cannot be normalised (length ${String(length)})`,
      );
    }
    return vector.map((x) => x / length);
  }
}
