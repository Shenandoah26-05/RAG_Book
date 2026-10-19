import type {
  Chunk,
  Chunker,
  ChunkStore,
  DocId,
  DocumentStore,
  Embedder,
  IndexManifest,
  IndexWriter,
  VectorRecord,
  VectorStore,
} from "../core/index.js";
import { contentHash, INDEX_MANIFEST_VERSION } from "../core/index.js";
import { RagError, Trace } from "../shared/index.js";
import type { Logger } from "../shared/index.js";

/** The parts the pipeline is built from. All interfaces; the composition root picks the real ones. */
export interface IndexDeps {
  readonly documents: DocumentStore;
  readonly chunker: Chunker;
  readonly embedder: Embedder;
  /** Receives the vectors. Starts empty, so what it accepts is checked and counted. */
  readonly vectorStore: VectorStore;
  /** Receives every chunk, parents included. Starts empty. */
  readonly chunkStore: ChunkStore;
  readonly writer: IndexWriter;
  readonly logger: Logger;
  readonly now?: () => Date;
}

/** What the composition root knows and the pipeline only records. */
export interface IndexSettings {
  /** Folder name of the index, see `indexNamespace`. */
  readonly namespace: string;
  readonly chunker: IndexManifest["chunker"];
  /** Texts embedded per call. */
  readonly batchSize: number;
  readonly configHash: string;
  readonly gitCommit: string | null;
}

export interface IndexOptions {
  /** Build again even if the index is up to date. */
  readonly force?: boolean;
}

export interface IndexResult {
  /** "built" now, or "skipped" because the index on disk is already up to date. */
  readonly status: "built" | "skipped";
  readonly location: string;
  readonly manifest: IndexManifest;
}

/**
 * Builds one searchable index, in five steps:
 *
 *   load documents -> chunk -> embed -> store -> write
 *
 * Chunks are embedded as `embedText` when the strategy sets one, else `text`. The small chunks of
 * a parent-child strategy get vectors; their parents are only stored.
 *
 * Running it again is safe: the manifest records a fingerprint of the chunker, the embedder and the
 * document ids, and a run that finds the same fingerprint does nothing. The fingerprint does not
 * cover the code itself, so after changing a chunker or cleaner, run with `force`. A rebuild is
 * cheap anyway, because the embedder the composition root passes in caches vectors.
 *
 * The manifest's `timingsMs` covers load/chunk, embed and store; writing happens after the manifest
 * is built, so its time is only logged.
 */
export async function buildIndex(
  deps: IndexDeps,
  docIds: readonly DocId[],
  settings: IndexSettings,
  options: IndexOptions = {},
): Promise<IndexResult> {
  const { documents, chunker, embedder, vectorStore, chunkStore, writer, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const log = logger.child({ namespace: settings.namespace });

  if (docIds.length === 0) {
    throw new RagError("INVALID_ARGUMENT", 'No documents to index. Run "pnpm ingest" first.');
  }
  if (chunker.name !== settings.chunker.name) {
    throw new RagError(
      "INTERNAL",
      `Index settings name chunker "${settings.chunker.name}", but the chunker is "${chunker.name}"`,
    );
  }
  if (vectorStore.dimensions !== embedder.dimensions) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `The vector store holds ${vectorStore.dimensions.toString()} numbers per vector, the embedder makes ${embedder.dimensions.toString()}`,
    );
  }

  const documentIds = [...new Set(docIds)].sort();
  const fingerprint = contentHash(
    "index",
    settings.chunker.name,
    settings.chunker.tokenizer,
    settings.chunker.maxTokens.toString(),
    settings.chunker.overlapTokens.toString(),
    embedder.modelId,
    embedder.dimensions.toString(),
    ...documentIds,
  );

  const location = writer.locationOf(settings.namespace);
  if (options.force !== true) {
    const earlier = await writer.readManifest(settings.namespace);
    if (earlier?.fingerprint === fingerprint) {
      log.info("up to date, skipping (use --force to build again)", { location });
      return { status: "skipped", location, manifest: earlier };
    }
  }

  log.info("indexing", {
    documents: documentIds.length,
    chunker: chunker.name,
    embedder: embedder.modelId,
  });
  const trace = new Trace();

  // parents (if the strategy has them) are stored but not searched
  const children: Chunk[] = [];
  const parents: Chunk[] = [];
  await trace.run(
    "chunk",
    async () => {
      for (const id of documentIds) {
        const doc = await documents.load(id);
        if (doc === undefined) {
          throw new RagError(
            "INVALID_ARGUMENT",
            `No processed document ${id}. Run "pnpm ingest" first.`,
          );
        }
        children.push(...(await chunker.chunk(doc)));
        if (chunker.parents !== undefined) parents.push(...(await chunker.parents(doc)));
      }
    },
    () => ({ chunks: children.length, parents: parents.length }),
  );

  // in batches, so a long book shows progress and never sends one huge request
  const vectors: VectorRecord[] = [];
  await trace.run(
    "embed",
    async () => {
      for (let i = 0; i < children.length; i += settings.batchSize) {
        const batch = children.slice(i, i + settings.batchSize);
        const embedded = await embedder.embed(
          batch.map((chunk) => chunk.embedText ?? chunk.text),
          "document",
        );
        if (embedded.length !== batch.length) {
          throw new RagError(
            "INTERNAL",
            `The embedder returned ${embedded.length.toString()} vectors for ${batch.length.toString()} texts`,
          );
        }
        batch.forEach((chunk, j) => {
          vectors.push({
            id: chunk.id,
            vector: embedded[j] as Float32Array,
            metadata: chunk.metadata,
          });
        });
        log.info("embedded", { done: vectors.length, total: children.length });
      }
    },
    () => ({ vectors: vectors.length }),
  );

  const allChunks = [...children, ...parents];
  await trace.run(
    "store",
    async () => {
      await vectorStore.upsert(vectors);
      await chunkStore.put(allChunks);
      const storedVectors = await vectorStore.count();
      const storedChunks = await chunkStore.count();
      if (storedVectors !== vectors.length || storedChunks !== allChunks.length) {
        throw new RagError(
          "INTERNAL",
          `The stores hold ${storedVectors.toString()} vectors and ${storedChunks.toString()} chunks, expected ${vectors.length.toString()} and ${allChunks.length.toString()} (duplicate chunk ids?)`,
        );
      }
    },
    () => ({ vectors: vectors.length, chunks: allChunks.length }),
  );

  const timingsMs: Record<string, number> = {};
  for (const stage of trace.stages) timingsMs[stage.stage] = Math.round(stage.durationMs);
  timingsMs["total"] = Math.round(trace.snapshot().totalMs);

  const manifest: IndexManifest = {
    version: INDEX_MANIFEST_VERSION,
    namespace: settings.namespace,
    createdAt: now().toISOString(),
    gitCommit: settings.gitCommit,
    configHash: settings.configHash,
    fingerprint,
    chunker: settings.chunker,
    embedder: {
      modelId: embedder.modelId,
      dimensions: embedder.dimensions,
      batchSize: settings.batchSize,
    },
    documents: documentIds,
    counts: {
      documents: documentIds.length,
      chunks: allChunks.length,
      parents: parents.length,
      vectors: vectors.length,
    },
    timingsMs,
  };

  const writeStarted = performance.now();
  const written = await writer.write({ manifest, vectors, chunks: allChunks });
  log.info("indexed", {
    location: written,
    vectors: vectors.length,
    chunks: allChunks.length,
    writeMs: Math.round(performance.now() - writeStarted),
  });
  return { status: "built", location: written, manifest };
}
