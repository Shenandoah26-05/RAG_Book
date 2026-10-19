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
import type {
  Chunk,
  ChunkId,
  DocId,
  IndexContents,
  IndexManifest,
  IndexReader,
  VectorRecord,
} from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import {
  CHUNKS_FILE,
  chunkLineSchema,
  KEYWORD_FILE,
  MANIFEST_FILE,
  manifestSchema,
  namespaceFolder,
  VECTORS_FILE,
} from "./index-format.js";

const BYTES_PER_FLOAT = Float32Array.BYTES_PER_ELEMENT;

/**
 * Reads the folder `FileIndexWriter` wrote (see there for the format) and checks that its parts
 * agree with each other before anything is built from it: the lines of `chunks.jsonl` must parse,
 * their number must be the manifest's, and `vectors.bin` must be exactly one vector per searchable
 * line. A failed check is INDEX_CORRUPT with a message that says which and how to rebuild.
 */
export class FileIndexReader implements IndexReader {
  readonly #root: string;

  /** @param root the folder holding every index, e.g. `data/index` */
  constructor(root: string) {
    this.#root = root;
  }

  locationOf(namespace: string): string {
    return namespaceFolder(this.#root, namespace);
  }

  async read(namespace: string): Promise<IndexContents | undefined> {
    const folder = this.locationOf(namespace);
    const damaged = (problem: string, cause?: unknown): RagError =>
      new RagError(
        "INDEX_CORRUPT",
        `The index in ${folder} is damaged: ${problem}. Rebuild it with "pnpm index --force".`,
        cause === undefined ? {} : { cause },
      );

    const manifestText = await readIfThere(path.join(folder, MANIFEST_FILE), damaged);
    if (manifestText === undefined) return undefined;
    const manifest = parseManifest(manifestText, damaged);

    const chunksText = await readIfThere(path.join(folder, CHUNKS_FILE), damaged);
    if (chunksText === undefined) throw damaged(`${CHUNKS_FILE} is missing`);
    const { chunks, indexed } = parseChunks(chunksText, damaged);

    const { counts } = manifest;
    if (chunks.length !== counts.chunks) {
      throw damaged(
        `the manifest lists ${counts.chunks.toString()} chunks, ${CHUNKS_FILE} has ${chunks.length.toString()}`,
      );
    }
    if (indexed.length !== counts.vectors) {
      throw damaged(
        `the manifest lists ${counts.vectors.toString()} vectors, ${CHUNKS_FILE} marks ${indexed.length.toString()}`,
      );
    }

    const bytes = await readFile(path.join(folder, VECTORS_FILE)).catch((cause: unknown) => {
      throw damaged(`${VECTORS_FILE} cannot be read`, cause);
    });
    const dimensions = manifest.embedder.dimensions;
    const expected = indexed.length * dimensions * BYTES_PER_FLOAT;
    if (bytes.length !== expected) {
      throw damaged(
        `${VECTORS_FILE} is ${bytes.length.toString()} bytes, but ${indexed.length.toString()} vectors of ${dimensions.toString()} numbers need ${expected.toString()}`,
      );
    }
    // copy into a buffer of its own: a Buffer from readFile may not be aligned for Float32Array
    const floats = new Float32Array(new Uint8Array(bytes).buffer);
    const vectors: VectorRecord[] = indexed.map((chunk, row) => ({
      id: chunk.id,
      vector: floats.subarray(row * dimensions, (row + 1) * dimensions),
      metadata: chunk.metadata,
    }));

    const keywordIndex = await readIfThere(path.join(folder, KEYWORD_FILE), damaged);
    return { manifest, vectors, chunks, ...(keywordIndex === undefined ? {} : { keywordIndex }) };
  }
}

/** The text of a file, or undefined if it does not exist. */
async function readIfThere(
  file: string,
  damaged: (problem: string, cause?: unknown) => RagError,
): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw damaged(`${path.basename(file)} cannot be read`, error);
  }
}

function parseManifest(
  text: string,
  damaged: (problem: string, cause?: unknown) => RagError,
): IndexManifest {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw damaged(`${MANIFEST_FILE} is not valid JSON`, cause);
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    throw damaged(
      `${MANIFEST_FILE} has an unexpected shape or is from another version`,
      parsed.error,
    );
  }
  return parsed.data as unknown as IndexManifest;
}

function parseChunks(
  text: string,
  damaged: (problem: string, cause?: unknown) => RagError,
): { chunks: Chunk[]; indexed: Chunk[] } {
  const chunks: Chunk[] = [];
  const indexed: Chunk[] = [];
  const ids = new Set<string>();
  text
    .split("\n")
    .filter((line) => line !== "")
    .forEach((line, i) => {
      const where = `line ${(i + 1).toString()} of ${CHUNKS_FILE}`;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch (cause) {
        throw damaged(`${where} is not valid JSON`, cause);
      }
      const parsed = chunkLineSchema.safeParse(json);
      if (!parsed.success) throw damaged(`${where} has an unexpected shape`, parsed.error);
      const chunk = parsed.data.chunk as unknown as Chunk & {
        id: ChunkId;
        metadata: { docId: DocId };
      };
      if (ids.has(chunk.id)) throw damaged(`chunk ${chunk.id} is listed twice`);
      ids.add(chunk.id);
      chunks.push(chunk);
      if (parsed.data.indexed) indexed.push(chunk);
    });
  return { chunks, indexed };
}
