import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { endianness } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import type {
  ChunkId,
  ChunkMetadata,
  DocId,
  ExportableVectorStore,
  VectorRecord,
  VectorStore,
} from "../../core/index.js";
import { noopLogger, RagError } from "../../shared/index.js";
import type { Logger } from "../../shared/index.js";

/** Bumped when the layout of the two files changes; an index of another version is refused. */
export const INDEX_FORMAT_VERSION = 1;

const VECTORS_FILE = "vectors.f32";
const META_FILE = "index.json";
const BYTES_PER_FLOAT = Float32Array.BYTES_PER_ELEMENT;

const whole = z.number().int().nonnegative();
const metaSchema = z.strictObject({
  formatVersion: z.number().int(),
  dimensions: whole,
  count: whole,
  /** SHA-256 (hex) of `vectors.f32`, to catch a file that was damaged or edited. */
  vectorsSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** One per vector, in the same order as the rows of `vectors.f32`. */
  entries: z.array(
    z.strictObject({
      id: z.string(),
      metadata: z.strictObject({
        docId: z.string(),
        pageStart: whole,
        pageEnd: whole,
        sectionPath: z.array(z.string()),
        charStart: whole,
        charEnd: whole,
        strategy: z.string(),
      }),
    }),
  ),
});

/** What `IndexFile.load` reports. */
export interface LoadedIndex {
  readonly count: number;
  readonly dimensions: number;
  readonly durationMs: number;
}

const corrupt = (dir: string, problem: string, cause?: unknown): RagError =>
  new RagError("INDEX_CORRUPT", `The index in "${dir}" is damaged: ${problem}`, {
    cause,
  });

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Saves a vector store to a folder and loads it back, so an index does not have to be embedded
 * again. It works through ports only: it saves any `ExportableVectorStore` and loads into any
 * `VectorStore`, and neither knows files exist.
 *
 * The folder holds two files:
 * - `vectors.f32`: every vector as raw little-endian 32-bit floats, one after another, no header.
 *   Reading it is one `readFile` and a view over the bytes. A JSON array of floats would have to be
 *   parsed number by number, and every float would cost around ten characters instead of four bytes.
 * - `index.json`: the format version, dimensions, count, a checksum of the vectors, and the id and
 *   metadata of each row, in the same order as the vectors.
 *
 * A save writes each file under a temporary name and renames it into place, `index.json` last. It is
 * the file a load reads first, so a crash part way through leaves the previous index readable, or
 * no index at all, never a half-written one that looks whole.
 */
export class IndexFile {
  readonly #dir: string;
  readonly #logger: Logger;

  /** @param dir where the two files go, e.g. `data/index`. Created on the first save. */
  constructor(dir: string, logger: Logger = noopLogger) {
    this.#dir = dir;
    this.#logger = logger;
  }

  /** Whether a saved index is there (it may still turn out to be damaged when loaded). */
  async exists(): Promise<boolean> {
    try {
      await readFile(this.#file(META_FILE));
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  /** Writes everything `source` holds. Replaces a previous index in the folder. */
  async save(source: ExportableVectorStore): Promise<void> {
    assertLittleEndian();
    const started = performance.now();
    const records = [...source.records()];
    const { dimensions } = source;

    const floats = new Float32Array(records.length * dimensions);
    records.forEach((record, row) => {
      if (record.vector.length !== dimensions) {
        throw new RagError(
          "INTERNAL",
          `Record ${record.id} has ${record.vector.length.toString()} dimensions, but the store says ${dimensions.toString()}`,
        );
      }
      floats.set(record.vector, row * dimensions);
    });
    const bytes = new Uint8Array(floats.buffer);

    const meta = {
      formatVersion: INDEX_FORMAT_VERSION,
      dimensions,
      count: records.length,
      vectorsSha256: sha256(bytes),
      entries: records.map(({ id, metadata }) => ({ id, metadata })),
    };

    await mkdir(this.#dir, { recursive: true });
    await this.#replace(VECTORS_FILE, bytes);
    await this.#replace(META_FILE, JSON.stringify(meta));
    this.#logger.info("index saved", {
      dir: this.#dir,
      count: records.length,
      dimensions,
      bytes: bytes.length,
      durationMs: elapsed(started),
    });
  }

  /**
   * Reads the saved index into `into`, which should be empty. Nothing is stored unless every check
   * passes.
   *
   * @throws RagError INVALID_ARGUMENT if there is no saved index, or it holds vectors of a different
   *   length than `into` (the embedding model changed: the index has to be built again)
   * @throws RagError INDEX_CORRUPT if the files are unreadable, of an unknown version, the wrong
   *   size, or fail their checksum
   */
  async load(into: VectorStore): Promise<LoadedIndex> {
    assertLittleEndian();
    const started = performance.now();
    const dir = this.#dir;

    const meta = await this.#readMeta();
    if (meta.dimensions !== into.dimensions) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `The index in "${dir}" holds ${meta.dimensions.toString()}-dimensional vectors, but the store takes ${into.dimensions.toString()}. The embedding model has probably changed: build the index again.`,
      );
    }
    if (meta.entries.length !== meta.count) {
      throw corrupt(
        dir,
        `it says ${meta.count.toString()} vectors but lists ${meta.entries.length.toString()}`,
      );
    }
    if (new Set(meta.entries.map((entry) => entry.id)).size !== meta.count) {
      throw corrupt(dir, "it lists the same id twice");
    }

    const bytes = await this.#readVectors();
    const expected = meta.count * meta.dimensions * BYTES_PER_FLOAT;
    if (bytes.length !== expected) {
      throw corrupt(
        dir,
        `${VECTORS_FILE} is ${bytes.length.toString()} bytes, but ${meta.count.toString()} vectors of ${meta.dimensions.toString()} numbers need ${expected.toString()}`,
      );
    }
    if (sha256(bytes) !== meta.vectorsSha256) {
      throw corrupt(dir, `${VECTORS_FILE} does not match its checksum`);
    }

    // a copy in a buffer of its own: a Buffer from readFile may not be aligned for Float32Array
    const floats = new Float32Array(new Uint8Array(bytes).buffer);
    const records: VectorRecord[] = meta.entries.map((entry, row) => ({
      id: entry.id as ChunkId,
      vector: floats.subarray(row * meta.dimensions, (row + 1) * meta.dimensions),
      metadata: { ...entry.metadata, docId: entry.metadata.docId as DocId } satisfies ChunkMetadata,
    }));
    await into.upsert(records);

    const loaded = {
      count: meta.count,
      dimensions: meta.dimensions,
      durationMs: elapsed(started),
    };
    this.#logger.info("index loaded", { dir, ...loaded });
    return loaded;
  }

  #file(name: string): string {
    return path.join(this.#dir, name);
  }

  async #readMeta(): Promise<z.infer<typeof metaSchema>> {
    let text: string;
    try {
      text = await readFile(this.#file(META_FILE), "utf8");
    } catch (error) {
      if (isMissing(error)) {
        throw new RagError(
          "INVALID_ARGUMENT",
          `There is no saved index in "${this.#dir}" (${META_FILE} not found). Ingest a book first.`,
          { cause: error },
        );
      }
      throw error;
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw corrupt(this.#dir, `${META_FILE} is not valid JSON`, error);
    }
    // the version is checked before the shape: a newer layout would fail the shape check, and
    // "unsupported version" is the more useful message
    const version = z.object({ formatVersion: z.unknown() }).safeParse(json);
    if (version.success && version.data.formatVersion !== INDEX_FORMAT_VERSION) {
      throw corrupt(
        this.#dir,
        `it is format version ${String(version.data.formatVersion)}, this program reads version ${INDEX_FORMAT_VERSION.toString()}`,
      );
    }
    const parsed = metaSchema.safeParse(json);
    if (!parsed.success) {
      throw corrupt(this.#dir, `${META_FILE} has an unexpected shape`, parsed.error);
    }
    return parsed.data;
  }

  async #readVectors(): Promise<Buffer> {
    try {
      return await readFile(this.#file(VECTORS_FILE));
    } catch (error) {
      if (isMissing(error)) {
        throw corrupt(this.#dir, `${VECTORS_FILE} is missing`, error);
      }
      throw error;
    }
  }

  async #replace(name: string, content: string | Uint8Array): Promise<void> {
    const file = this.#file(name);
    const temporary = `${file}.${process.pid.toString()}.tmp`;
    try {
      await writeFile(temporary, content);
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

const elapsed = (started: number): number => Math.round(performance.now() - started);

/** The file is little-endian on purpose (portable between machines); every Node target is. */
function assertLittleEndian(): void {
  if (endianness() !== "LE") {
    throw new RagError("INTERNAL", "Saving and loading an index needs a little-endian machine");
  }
}
