// Public API of src/adapters/embedders. Named exports only.
export { ALL_MINILM_DIMENSIONS, OllamaEmbedder } from "./ollama-embedder.js";
export type { OllamaEmbedderOptions } from "./ollama-embedder.js";
export { CachingEmbedder, embeddingCacheKey } from "./caching-embedder.js";
export type { EmbeddingCache } from "./caching-embedder.js";
export { FileEmbeddingCache } from "./file-embedding-cache.js";
export { PrefixingEmbedder } from "./prefixing-embedder.js";
export type { EmbedPrefixes } from "./prefixing-embedder.js";
export { parseEmbeddingProfiles } from "./model-profile.js";
export type { EmbeddingModelProfile, EmbeddingProfiles } from "./model-profile.js";
