import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { INDEX_MANIFEST_VERSION } from "../../core/index.js";
import type { IndexContents, IndexManifest, IndexWriter } from "../../core/index.js";
import { RagError } from "../../shared/index.js";

const MANIFEST_FILE = "manifest.json";
const CHUNKS_FILE = "chunks.jsonl";
const VECTORS_FILE = "vectors.bin";

/** A namespace becomes a folder name: letters, digits, `.`, `_` and `-`, never starting with a dot. */
const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const count = z.number().int().nonnegative();

/** The shape of `manifest.json`. Unknown keys are rejected, so a manifest of another version fails loudly. */
const manifestSchema = z.strictObject({
  version: z.literal(INDEX_MANIFEST_VERSION),
  namespace: z.string(),
  createdAt: z.string(),
  gitCommit: z.string().nullable(),
  configHash: z.string(),
  fingerprint: z.string(),
  chunker: z.strictObject({
    name: z.string(),
    tokenizer: z.string(),
    maxTokens: count,
    overlapTokens: count,
  }),
  embedder: z.strictObject({
    modelId: z.string(),
    dimensions: count,
    batchSize: count,
  }),
  documents: z.array(z.string()),
  counts: z.strictObject({ documents: count, chunks: count, parents: count, vectors: count }),
  timingsMs: z.record(z.string(), z.number()),
});

/**
 * Saves an index as a folder, `<root>/<namespace>/`:
 *
 * - `manifest.json`: what built it (see `IndexManifest`), indented to be read by people.
 * - `chunks.jsonl`: one line per chunk, `{"indexed": boolean, "chunk": {...}}`, in order.
 * - `vectors.bin`: raw little-endian float32, `dimensions` numbers per vector, one vector for each
 *   line whose `indexed` is true, in the same order. No ids are stored: the line says which chunk.
 *
 * The folder is written under a temporary name and renamed into place, with the manifest last, so
 * an index is either complete or absent. This is the minimal format the indexing pipeline needs;
 * loading it again with validation is RAG-042.
 */
export class FileIndexWriter implements IndexWriter {
  readonly #root: string;

  /** @param root the folder holding every index, e.g. `data/index`. Created on the first write. */
  constructor(root: string) {
    this.#root = root;
  }

  locationOf(namespace: string): string {
    if (!NAMESPACE.test(namespace) || namespace.includes("..")) {
      throw new RagError("INVALID_ARGUMENT", `Not an index namespace: "${namespace}"`);
    }
    return path.join(this.#root, namespace);
  }

  async readManifest(namespace: string): Promise<IndexManifest | undefined> {
    const file = path.join(this.locationOf(namespace), MANIFEST_FILE);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new RagError("INGESTION_FAILED", `Cannot read ${file}`, { cause: error });
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (cause) {
      throw new RagError("INGESTION_FAILED", `${file} is damaged (it is not valid JSON)`, {
        cause,
      });
    }
    const parsed = manifestSchema.safeParse(json);
    if (!parsed.success) {
      throw new RagError(
        "INGESTION_FAILED",
        `${file} is damaged or from another version. Re-run with --force.`,
        { cause: parsed.error },
      );
    }
    return parsed.data as unknown as IndexManifest;
  }

  async write(contents: IndexContents): Promise<string> {
    const { manifest, vectors, chunks } = contents;
    const target = this.locationOf(manifest.namespace);
    const dimensions = manifest.embedder.dimensions;

    const vectorById = new Map(vectors.map((record) => [record.id, record.vector]));
    const lines: string[] = [];
    const rows: Float32Array[] = [];
    for (const chunk of chunks) {
      const vector = vectorById.get(chunk.id);
      if (vector !== undefined) {
        if (vector.length !== dimensions) {
          throw new RagError(
            "INTERNAL",
            `Vector of chunk ${chunk.id} has ${vector.length.toString()} numbers, the manifest says ${dimensions.toString()}`,
          );
        }
        rows.push(vector);
      }
      lines.push(`${JSON.stringify({ indexed: vector !== undefined, chunk })}\n`);
    }
    if (rows.length !== vectors.length) {
      throw new RagError("INTERNAL", "Some vectors belong to chunks that are not in the index");
    }

    const floats = new Float32Array(rows.length * dimensions);
    rows.forEach((row, i) => {
      floats.set(row, i * dimensions);
    });

    const temporary = `${target}.${process.pid.toString()}.tmp`;
    try {
      await rm(temporary, { recursive: true, force: true });
      await mkdir(temporary, { recursive: true });
      await writeFile(path.join(temporary, CHUNKS_FILE), lines.join(""));
      await writeFile(
        path.join(temporary, VECTORS_FILE),
        new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength),
      );
      // the manifest goes last: its presence means the rest is there
      await writeFile(
        path.join(temporary, MANIFEST_FILE),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      // a folder cannot be renamed over another one on every system, so the old index goes first
      await rm(target, { recursive: true, force: true });
      await rename(temporary, target);
    } catch (cause) {
      await rm(temporary, { recursive: true, force: true });
      throw new RagError("INGESTION_FAILED", `Cannot write the index to ${target}`, { cause });
    }
    return target;
  }
}
