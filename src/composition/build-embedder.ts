import {
  ALL_MINILM_DIMENSIONS,
  CachingEmbedder,
  FileEmbeddingCache,
  normalizeOllamaHost,
  OllamaEmbedder,
} from "../adapters/index.js";
import type { Embedder } from "../core/index.js";
import { RagError } from "../shared/index.js";
import type { Logger } from "../shared/index.js";

/** Where cached vectors go unless told otherwise. */
export const DEFAULT_EMBEDDING_CACHE_DIR = "data/cache/embeddings";

/** Ollama models whose vector length is known. Another model is one new line here. */
const OLLAMA_DIMENSIONS: ReadonlyMap<string, number> = new Map([
  ["all-minilm", ALL_MINILM_DIMENSIONS],
]);

/** The embedders that can be named, as `provider:model`, for messages. */
export const embedderNames = (): readonly string[] =>
  [...OLLAMA_DIMENSIONS.keys()].map((model) => `ollama:${model}`);

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
}

/**
 * Builds the embedder for a `provider:model` name, wrapped in the on-disk cache so a text is never
 * embedded twice with the same model. Throws CONFIG_INVALID for a provider or model it does not know.
 */
export function buildEmbedder(spec: string, options: BuildEmbedderOptions): Embedder {
  const { provider, model } = parseEmbedderSpec(spec);
  if (provider !== "ollama") {
    throw new RagError(
      "CONFIG_INVALID",
      `Unknown embedding provider "${provider}". Known embedders: ${embedderNames().join(", ")}`,
    );
  }
  const dimensions = OLLAMA_DIMENSIONS.get(model);
  if (dimensions === undefined) {
    throw new RagError(
      "CONFIG_INVALID",
      `Unknown embedding model "${model}" for ollama (its vector length is not known). Known embedders: ${embedderNames().join(", ")}`,
    );
  }
  const inner = new OllamaEmbedder({
    address: normalizeOllamaHost((options.env ?? process.env)["OLLAMA_HOST"]),
    model,
    dimensions,
    batchSize: options.batchSize,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return new CachingEmbedder(
    inner,
    new FileEmbeddingCache(options.cacheDir ?? DEFAULT_EMBEDDING_CACHE_DIR),
    options.logger,
  );
}
