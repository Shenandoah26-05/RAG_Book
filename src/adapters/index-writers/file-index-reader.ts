import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Chunk, IndexContents, VectorRecord } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { CHUNKS_FILE, FileIndexWriter, VECTORS_FILE } from "./file-index-writer.js";

const rowSchema = z.object({
  indexed: z.boolean(),
  // loose: parentId, embedText and any later field must survive the trip
  chunk: z
    .object({
      id: z.string(),
      text: z.string(),
      metadata: z.object({ docId: z.string() }).loose(),
    })
    .loose(),
});

/**
 * Reads back an index that `FileIndexWriter` saved: the manifest, every chunk, one vector per
 * indexed chunk and the keyword index. It reads only what the writer wrote, in the format
 * described there, and checks it against the manifest, so a half-copied or edited folder is an
 * error with the file named and not a quiet wrong answer.
 */
export class FileIndexReader {
  readonly #files: FileIndexWriter;

  /** @param root the folder holding every index, e.g. `data/index`. */
  constructor(root: string) {
    this.#files = new FileIndexWriter(root);
  }

  /**
   * The index saved under `namespace`, or undefined if there is none.
   * @throws RagError INDEX_CORRUPT if a file is damaged or disagrees with the manifest
   */
  async read(namespace: string): Promise<IndexContents | undefined> {
    const manifest = await this.#files.readManifest(namespace);
    if (manifest === undefined) return undefined;
    const folder = this.#files.locationOf(namespace);
    const damaged = (file: string, problem: string, cause?: unknown): RagError =>
      new RagError("INDEX_CORRUPT", `${path.join(folder, file)} is damaged: ${problem}`, {
        cause,
      });

    const chunkText = await readText(path.join(folder, CHUNKS_FILE));
    const rows = chunkText
      .split("\n")
      .filter((line) => line !== "")
      .map((line, i) => {
        try {
          return rowSchema.parse(JSON.parse(line));
        } catch (cause) {
          throw damaged(CHUNKS_FILE, `line ${(i + 1).toString()} is not a chunk`, cause);
        }
      });
    if (rows.length !== manifest.counts.chunks) {
      throw damaged(
        CHUNKS_FILE,
        `it holds ${rows.length.toString()} chunks, the manifest says ${manifest.counts.chunks.toString()}`,
      );
    }

    const dimensions = manifest.embedder.dimensions;
    const bytes = await readBytes(path.join(folder, VECTORS_FILE));
    const indexed = rows.filter((row) => row.indexed).length;
    if (bytes.byteLength !== indexed * dimensions * 4 || indexed !== manifest.counts.vectors) {
      throw damaged(
        VECTORS_FILE,
        `it holds ${(bytes.byteLength / 4).toString()} numbers, expected ${indexed.toString()} vectors of ${dimensions.toString()} (the manifest says ${manifest.counts.vectors.toString()} vectors)`,
      );
    }
    // a copy, so the numbers sit at a 4-byte boundary whatever the read buffer did
    const floats = new Float32Array(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );

    const chunks: Chunk[] = [];
    const vectors: VectorRecord[] = [];
    for (const row of rows) {
      const chunk = row.chunk as unknown as Chunk;
      chunks.push(chunk);
      if (row.indexed) {
        const at = vectors.length * dimensions;
        vectors.push({
          id: chunk.id,
          vector: floats.subarray(at, at + dimensions),
          metadata: chunk.metadata,
        });
      }
    }

    const keywordIndex = await this.#files.readKeywordIndex(namespace);
    return { manifest, chunks, vectors, ...(keywordIndex === undefined ? {} : { keywordIndex }) };
  }
}

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (cause) {
    throw new RagError("INDEX_CORRUPT", `Cannot read ${file}. Rebuild with "pnpm index --force".`, {
      cause,
    });
  }
}

async function readBytes(file: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (cause) {
    throw new RagError("INDEX_CORRUPT", `Cannot read ${file}. Rebuild with "pnpm index --force".`, {
      cause,
    });
  }
}
