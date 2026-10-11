import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { RagError } from "../../shared/index.js";
import type { EmbeddingCache } from "./caching-embedder.js";

const KEY = /^[0-9a-f]{64}$/;
const BYTES_PER_FLOAT = Float32Array.BYTES_PER_ELEMENT;

/**
 * Keeps each vector as one file of raw 32-bit floats, `<folder>/<first 2 hex>/<key>.bin`. The first
 * two characters of the key become a sub-folder so no single folder holds every file. There is
 * nothing to parse and no shared file to rewrite; a write goes to a temporary file first and is then
 * renamed, so a crash never leaves a half-written entry.
 */
export class FileEmbeddingCache implements EmbeddingCache {
  readonly #folder: string;

  /** @param folder where the files go, e.g. `data/cache/embeddings`. Created on the first write. */
  constructor(folder: string) {
    this.#folder = folder;
  }

  /** The file for this key, whether or not it exists yet. */
  locationOf(key: string): string {
    // The key becomes part of a path, so only what a key looks like is accepted: "../x" can never
    // point outside the folder.
    if (!KEY.test(key)) {
      throw new RagError("INVALID_ARGUMENT", `Not an embedding cache key: "${key}"`);
    }
    return path.join(this.#folder, key.slice(0, 2), `${key}.bin`);
  }

  async get(key: string): Promise<Float32Array | undefined> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.locationOf(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    // not a whole number of floats: damaged, so treat it as missing and let it be replaced
    if (bytes.length === 0 || bytes.length % BYTES_PER_FLOAT !== 0) return undefined;
    // copy into a buffer of its own: a Buffer from readFile may not be aligned for Float32Array
    const copy = new Uint8Array(bytes);
    return new Float32Array(copy.buffer);
  }

  async set(key: string, vector: Float32Array): Promise<void> {
    const file = this.locationOf(key);
    const temporary = `${file}.${process.pid.toString()}.tmp`;
    await mkdir(path.dirname(file), { recursive: true });
    try {
      await writeFile(
        temporary,
        new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength),
      );
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
