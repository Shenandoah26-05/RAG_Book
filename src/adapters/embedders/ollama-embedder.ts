import { z } from "zod";
import type { Embedder } from "../../core/index.js";
import { RagError } from "../../shared/index.js";

/** all-minilm is a Sentence-BERT model that gives 384 numbers per text. */
export const ALL_MINILM_DIMENSIONS = 384;

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 250;

export interface OllamaEmbedderOptions {
  /** Base URL of the server, e.g. `OllamaHost.address`. */
  readonly address: string;
  /** Model name as Ollama knows it, e.g. "all-minilm". */
  readonly model: string;
  /** Length of the model's vectors. Every response is checked against it. */
  readonly dimensions: number;
  /** Texts per request. Default 32. */
  readonly batchSize?: number;
  /** Time allowed for one request. Default 30 seconds. */
  readonly timeoutMs?: number;
  /** Extra attempts after a network error or a 5xx/429 answer. Default 3. */
  readonly maxRetries?: number;
  /** Wait before the first retry; it doubles each time. Default 250 ms. */
  readonly retryDelayMs?: number;
  readonly fetch?: typeof fetch;
  /** Replaces the real wait between retries, so tests do not have to sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** What `POST /api/embed` returns; extra fields are ignored. */
const embedResponse = z.object({ embeddings: z.array(z.array(z.number())) });

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const positiveInt = (name: string, value: number, min: number): void => {
  if (!Number.isInteger(value) || value < min) {
    throw new RagError(
      "CONFIG_INVALID",
      `OllamaEmbedder: ${name} must be a whole number of ${min.toString()} or more, got ${String(value)}`,
    );
  }
};

/**
 * Embeds text with a model served by Ollama (`/api/embed`). The only file that knows Ollama's
 * request and response format.
 *
 * Texts are sent in batches of `batchSize`, one request at a time, and the vectors come back in the
 * order of the texts. Network errors and 5xx/429 answers are retried with a doubling wait; other
 * errors (such as a model that is not installed) fail at once. Each vector is checked against
 * `dimensions` and scaled to length 1, as the `Embedder` port requires.
 *
 * all-minilm treats a query and a passage alike, so `kind` makes no difference here.
 */
export class OllamaEmbedder implements Embedder {
  readonly modelId: string;
  readonly dimensions: number;

  readonly #address: string;
  readonly #model: string;
  readonly #batchSize: number;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #retryDelayMs: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  /** @throws RagError CONFIG_INVALID if a size, count or time is not a usable number */
  constructor(options: OllamaEmbedderOptions) {
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    positiveInt("dimensions", options.dimensions, 1);
    positiveInt("batchSize", batchSize, 1);
    positiveInt("timeoutMs", timeoutMs, 1);
    positiveInt("maxRetries", maxRetries, 0);
    positiveInt("retryDelayMs", retryDelayMs, 0);

    this.modelId = `ollama:${options.model}`;
    this.dimensions = options.dimensions;
    this.#address = options.address;
    this.#model = options.model;
    this.#batchSize = batchSize;
    this.#timeoutMs = timeoutMs;
    this.#maxRetries = maxRetries;
    this.#retryDelayMs = retryDelayMs;
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? realSleep;
  }

  // Takes no `kind` parameter: it is optional to declare, and this model ignores it.
  async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    const vectors: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += this.#batchSize) {
      const batch = texts.slice(start, start + this.#batchSize);
      vectors.push(...(await this.#embedBatch(batch)));
    }
    return vectors;
  }

  async #embedBatch(batch: readonly string[]): Promise<Float32Array[]> {
    const body = await this.#post(batch);
    const parsed = embedResponse.safeParse(body);
    if (!parsed.success) {
      throw new RagError(
        "PROVIDER_UNAVAILABLE",
        `The server at ${this.#address} did not answer like Ollama's /api/embed (unexpected response)`,
        { cause: parsed.error },
      );
    }
    const { embeddings } = parsed.data;
    if (embeddings.length !== batch.length) {
      throw new RagError(
        "PROVIDER_UNAVAILABLE",
        `Ollama returned ${embeddings.length.toString()} vectors for ${batch.length.toString()} texts`,
      );
    }
    return embeddings.map((values) => this.#toUnitVector(values));
  }

  /** POSTs one batch, retrying what is worth retrying, and returns the parsed JSON body. */
  async #post(batch: readonly string[]): Promise<unknown> {
    const url = `${this.#address}/api/embed`;
    for (let attempt = 0; ; attempt += 1) {
      const failure = await this.#tryOnce(url, batch);
      if (failure.ok) return failure.body;
      if (!failure.retry || attempt >= this.#maxRetries) throw failure.error;
      await this.#sleep(this.#retryDelayMs * 2 ** attempt);
    }
  }

  async #tryOnce(
    url: string,
    batch: readonly string[],
  ): Promise<
    | { readonly ok: true; readonly body: unknown }
    | { readonly ok: false; readonly retry: boolean; readonly error: RagError }
  > {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.#model, input: batch }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      const error = new RagError(
        "PROVIDER_UNAVAILABLE",
        `Cannot reach Ollama at ${this.#address}`,
        {
          cause,
        },
      );
      return { ok: false, retry: true, error };
    }

    if (!response.ok) {
      const detail = await errorDetail(response);
      const missing = response.status === 404;
      const error = new RagError(
        "PROVIDER_UNAVAILABLE",
        missing
          ? `Ollama at ${this.#address} has no model "${this.#model}" (${detail}). Run: ollama pull ${this.#model}`
          : `Ollama at ${this.#address} answered with HTTP ${response.status.toString()} (${detail})`,
      );
      return { ok: false, retry: response.status >= 500 || response.status === 429, error };
    }

    try {
      return { ok: true, body: await response.json() };
    } catch (cause) {
      const error = new RagError(
        "PROVIDER_UNAVAILABLE",
        `The server at ${this.#address} did not answer like Ollama (not JSON)`,
        { cause },
      );
      return { ok: false, retry: false, error };
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

/** The `error` text of an Ollama error body, or the status text if there is none. */
async function errorDetail(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const parsed = z.object({ error: z.string() }).safeParse(body);
    if (parsed.success) return parsed.data.error;
  } catch {
    // not JSON: fall through to the status text
  }
  return response.statusText === "" ? "no details" : response.statusText;
}
