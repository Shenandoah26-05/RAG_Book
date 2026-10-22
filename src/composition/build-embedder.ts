import { readFile } from "node:fs/promises";
import {
  CachingEmbedder,
  FileEmbeddingCache,
  normalizeOllamaHost,
  OllamaEmbedder,
  parseEmbeddingProfiles,
  PrefixingEmbedder,
} from "../adapters/index.js";
import type { EmbeddingProfiles } from "../adapters/index.js";
import type { Embedder } from "../core/index.js";
import { RagError } from "../shared/index.js";
import type { Logger } from "../shared/index.js";

/** Where cached vectors go unless told otherwise. */
export const DEFAULT_EMBEDDING_CACHE_DIR = "data/cache/embeddings";

/** The model-profile file: vector length and query/document prefixes of every known model. */
export const DEFAULT_EMBEDDING_PROFILES_FILE = "configs/embedding-models.json";

/**
 * Reads the model-profile file. Another model is one new entry there, with no code change.
 * @throws RagError CONFIG_INVALID if the file is missing, is not JSON, or has a wrong entry
 */
export async function loadEmbeddingProfiles(
  file: string = DEFAULT_EMBEDDING_PROFILES_FILE,
): Promise<EmbeddingProfiles> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, "utf8"));
  } catch (cause) {
    throw new RagError("CONFIG_INVALID", `Cannot read embedding model profiles from ${file}`, {
      cause,
    });
  }
  return parseEmbeddingProfiles(json, file);
}

/** The embedders that can be named, as `provider:model`, for messages. */
export const embedderNames = (profiles: EmbeddingProfiles): readonly string[] =>
  [...profiles.keys()].map((model) => `ollama:${model}`);

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
  /** The model-profile file. Default `configs/embedding-models.json`. */
  readonly profilesFile?: string;
  readonly logger?: Logger;
  readonly fetch?: typeof fetch;
}

/**
 * Builds the embedder for a `provider:model` name: the Ollama client, wrapped in the on-disk cache
 * so a text is never embedded twice with the same model, wrapped in the model's query and document
 * prefixes. The prefixes go outside the cache, so it keys on the text the model really saw.
 * Throws CONFIG_INVALID for a provider or model it does not know.
 */
export async function buildEmbedder(
  spec: string,
  options: BuildEmbedderOptions,
): Promise<Embedder> {
  const { provider, model } = parseEmbedderSpec(spec);
  const profilesFile = options.profilesFile ?? DEFAULT_EMBEDDING_PROFILES_FILE;
  const profiles = await loadEmbeddingProfiles(profilesFile);
  if (provider !== "ollama") {
    throw new RagError(
      "CONFIG_INVALID",
      `Unknown embedding provider "${provider}". Known embedders: ${embedderNames(profiles).join(", ")}`,
    );
  }
  const profile = profiles.get(model);
  if (profile === undefined) {
    throw new RagError(
      "CONFIG_INVALID",
      `Unknown embedding model "${model}" for ollama (it has no entry in ${profilesFile}). Known embedders: ${embedderNames(profiles).join(", ")}`,
    );
  }
  const inner = new OllamaEmbedder({
    address: normalizeOllamaHost((options.env ?? process.env)["OLLAMA_HOST"]),
    model,
    dimensions: profile.dimensions,
    batchSize: options.batchSize,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const cached = new CachingEmbedder(
    inner,
    new FileEmbeddingCache(options.cacheDir ?? DEFAULT_EMBEDDING_CACHE_DIR),
    options.logger,
  );
  return new PrefixingEmbedder(cached, {
    query: profile.queryPrefix,
    document: profile.documentPrefix,
  });
}
