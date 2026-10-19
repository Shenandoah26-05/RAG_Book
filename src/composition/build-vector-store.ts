import path from "node:path";
import { SqliteVectorStore } from "../adapters/index.js";
import type { RagConfig } from "../config/index.js";
import type { VectorStore } from "../core/index.js";
import { RagError } from "../shared/index.js";
import { FlatVectorStore } from "../strategies/index.js";

/** File name of the SQLite index inside `vectorStore.dir`. */
export const SQLITE_INDEX_FILE = "vectors.sqlite";

type Settings = RagConfig["vectorStore"];

const VECTOR_STORES: ReadonlyMap<string, (settings: Settings, dimensions: number) => VectorStore> =
  new Map<string, (settings: Settings, dimensions: number) => VectorStore>([
    ["in-memory", (_settings, dimensions) => new FlatVectorStore(dimensions)],
    [
      "sqlite",
      ({ dir }, dimensions) => new SqliteVectorStore(dimensions, path.join(dir, SQLITE_INDEX_FILE)),
    ],
  ]);

/** The names accepted in `vectorStore.type`. */
export const vectorStoreNames = (): readonly string[] => [...VECTOR_STORES.keys()];

/**
 * Builds the store named in `vectorStore.type`, for vectors of `dimensions` entries (the
 * embedder's). Throws CONFIG_INVALID if there is no such store.
 */
export function buildVectorStore(settings: Settings, dimensions: number): VectorStore {
  const create = VECTOR_STORES.get(settings.type);
  if (create === undefined) {
    throw new RagError(
      "CONFIG_INVALID",
      `Unknown vector store "${settings.type}" in vectorStore.type. Known stores: ${vectorStoreNames().join(", ")}`,
    );
  }
  return create(settings, dimensions);
}
