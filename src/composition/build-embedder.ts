import {
  ALL_MINILM_DIMENSIONS,
  CachingEmbedder,
  FileEmbeddingCache,
  KNOWN_OPENAI_EMBEDDING_DIMENSIONS,
  normalizeOllamaHost,
  OllamaEmbedder,
  OpenAiEmbedder,
  OpenAiEndpoint,
} from "../adapters/index.js";
import type { Embedder } from "../core/index.js";
import { RagError } from "../shared/index.js";
import type { Logger } from "../shared/index.js";
import { MeteredEmbedder } from "../strategies/index.js";
import type { Resilience } from "./build-resilience.js";

/** Where cached vectors go unless told otherwise. */
export const DEFAULT_EMBEDDING_CACHE_DIR = "data/cache/embeddings";

/** Ollama models whose vector length is known. Another model is one new line here. */
const OLLAMA_DIMENSIONS: ReadonlyMap<string, number> = new Map([
  ["all-minilm", ALL_MINILM_DIMENSIONS],
]);

const OPENAI_COMPATIBLE = "openai-compatible";

/** The embedders that can be named, as `provider:model`, for messages. */
export const embedderNames = (): readonly string[] => [
  ...[...OLLAMA_DIMENSIONS.keys()].map((model) => `ollama:${model}`),
  ...[...KNOWN_OPENAI_EMBEDDING_DIMENSIONS.keys()].map((model) => `${OPENAI_COMPATIBLE}:${model}`),
];

/** Splits `provider:model` at the first colon ("ollama:all-minilm:latest" keeps its tag). */
export function parseEmbedderSpec(spec: string): { provider: string; model: string } {
  const at = spec.indexOf(":");
  const provider = at < 0 ? "" : spec.slice(0, at);
  const model = at < 0 ? "" : spec.slice(at + 1);
  if (provider === "" || model === "") {
    throw new RagError(
      "INVALID_ARGUMENT",
      `Embedder "${spec}" must look like provider:model, e.g. ollama:all-minilm`,
    );
  }
  return { provider, model };
}

export interface BuildEmbedderOptions {
  readonly batchSize: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cacheDir?: string;
  readonly logger?: Logger;
  readonly fetch?: typeof fetch;
  /**
   * Retries, timeouts and rate limits (RAG-092), applied inside the cache so that a cached vector
   * costs no turn and no retry. With it the adapter does not retry on its own: that is the
   * decorator's job, and both would multiply.
   */
  readonly resilience?: Resilience;
}

/**
 * Builds the embedder for a `provider:model` name, wrapped in the on-disk cache so a text is never
 * embedded twice with the same model. Throws CONFIG_INVALID for a provider or model it does not know.
 */
export function buildEmbedder(spec: string, options: BuildEmbedderOptions): Embedder {
  const { provider, model } = parseEmbedderSpec(spec);
  const env = options.env ?? process.env;
  const fetchOption = options.fetch === undefined ? {} : { fetch: options.fetch };
  let inner: Embedder;
  if (provider === "ollama") {
    const dimensions = OLLAMA_DIMENSIONS.get(model);
    if (dimensions === undefined) {
      throw new RagError(
        "CONFIG_INVALID",
        `Unknown embedding model "${model}" for ollama (its vector length is not known). Known embedders: ${embedderNames().join(", ")}`,
      );
    }
    inner = new OllamaEmbedder({
      address: normalizeOllamaHost(env["OLLAMA_HOST"]),
      model,
      dimensions,
      batchSize: options.batchSize,
      ...(options.resilience === undefined ? {} : { maxRetries: 0 }),
      ...fetchOption,
    });
  } else if (provider === OPENAI_COMPATIBLE) {
    inner = new OpenAiEmbedder({
      endpoint: OpenAiEndpoint.fromEnv(env),
      model,
      dimensions: openAiDimensions(model, env["OPENAI_EMBEDDING_DIMENSIONS"]),
      batchSize: options.batchSize,
      ...fetchOption,
    });
  } else {
    throw new RagError(
      "CONFIG_INVALID",
      `Unknown embedding provider "${provider}". Known embedders: ${embedderNames().join(", ")}`,
    );
  }
  return new CachingEmbedder(
    // metered inside the cache, so a vector that was cached is not a call and costs nothing
    new MeteredEmbedder(
      options.resilience === undefined ? inner : options.resilience.embedder(inner),
    ),
    new FileEmbeddingCache(options.cacheDir ?? DEFAULT_EMBEDDING_CACHE_DIR),
    options.logger,
  );
}

/**
 * The vector length of an OpenAI-compatible model: `OPENAI_EMBEDDING_DIMENSIONS` if set, else the
 * known value for OpenAI's own models. A local server can serve any model, so its length cannot be
 * listed here.
 */
function openAiDimensions(model: string, override: string | undefined): number {
  const raw = override?.trim() ?? "";
  if (raw !== "") {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      throw new RagError(
        "CONFIG_INVALID",
        `OPENAI_EMBEDDING_DIMENSIONS must be a whole number of 1 or more, got "${raw}"`,
      );
    }
    return value;
  }
  const known = KNOWN_OPENAI_EMBEDDING_DIMENSIONS.get(model);
  if (known === undefined) {
    throw new RagError(
      "CONFIG_INVALID",
      `Unknown embedding model "${model}" for ${OPENAI_COMPATIBLE} (its vector length is not known). Set OPENAI_EMBEDDING_DIMENSIONS, or use one of: ${embedderNames().join(", ")}`,
    );
  }
  return known;
}
