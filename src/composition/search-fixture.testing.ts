// A small index written to disk, for the tests of loading and searching. Not part of the build.
// It lives in composition/ and not in testing/ because it builds real adapters and strategies,
// which test helpers in testing/ may not import.
import { FileIndexWriter } from "../adapters/index.js";
import { INDEX_MANIFEST_VERSION, makeChunkId } from "../core/index.js";
import type { Chunk, DocId, IndexContents } from "../core/index.js";
import { makeDocId } from "../shared/index.js";
import { Bm25Index } from "../strategies/index.js";

export const DOC_A: DocId = makeDocId("a".repeat(64));
export const DOC_B: DocId = makeDocId("b".repeat(64));
export const NAMESPACE = "recursive__ollama-all-minilm";
/** The length all-minilm makes, so the real `OllamaEmbedder` (with a fake server) can be used. */
export const DIMENSIONS = 384;

/** A unit vector whose first numbers are `v` and the rest 0. */
export function unit(...v: number[]): Float32Array {
  const length = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  const vector = new Float32Array(DIMENSIONS);
  v.forEach((x, i) => {
    vector[i] = x / length;
  });
  return vector;
}

function chunk(
  docId: DocId,
  text: string,
  start: number,
  page: number,
  extra: Partial<Chunk> = {},
): Chunk {
  return {
    id: makeChunkId({
      docId,
      strategy: "recursive",
      charStart: start,
      charEnd: start + text.length,
      text,
    }),
    text,
    metadata: {
      docId,
      pageStart: page,
      pageEnd: page,
      sectionPath: page === 1 ? ["Chapter 1"] : ["Chapter 2"],
      charStart: start,
      charEnd: start + text.length,
      strategy: "recursive",
    },
    ...extra,
  };
}

export const purr = chunk(DOC_A, "cats purr", 0, 1);
export const young = chunk(DOC_A, "kittens are young cats", 10, 1);
export const dogs = chunk(DOC_B, "dogs bark and fetch", 0, 2);
export const cars = chunk(DOC_B, "cars have four wheels", 30, 2);
export const furry = chunk(DOC_B, "furry animals such as cats like to sleep all day long", 60, 2);
export const SEARCHABLE = [purr, young, dogs, cars, furry];

/** The vectors the fake embedder gives the question "cats", and each chunk. */
export const QUESTION_VECTOR = unit(1, 0, 0);
export const VECTORS = new Map<string, Float32Array>([
  [young.id, unit(1, 0.1, 0)],
  [dogs.id, unit(0.8, 0.6, 0)],
  [furry.id, unit(0.6, 0.8, 0)],
  [purr.id, unit(0.2, 1, 0)],
  [cars.id, unit(0, 0, 1)],
]);

export interface FixtureOptions {
  readonly parents?: readonly Chunk[];
  readonly withKeyword?: boolean;
  readonly modelId?: string;
}

/** The contents of an index of the five chunks (plus optional parents), as `pnpm index` would write it. */
export function fixtureContents(options: FixtureOptions = {}): IndexContents {
  const { parents = [], withKeyword = true, modelId = "ollama:all-minilm" } = options;
  const keyword = new Bm25Index();
  keyword.add(SEARCHABLE);
  return {
    manifest: {
      version: INDEX_MANIFEST_VERSION,
      namespace: NAMESPACE,
      createdAt: "2026-10-19T10:00:00.000Z",
      gitCommit: "abc1234def",
      configHash: "c".repeat(64),
      fingerprint: "f".repeat(64),
      chunker: { name: "recursive", tokenizer: "approx", maxTokens: 400, overlapTokens: 60 },
      embedder: { modelId, dimensions: DIMENSIONS, batchSize: 32 },
      documents: [DOC_A, DOC_B],
      counts: {
        documents: 2,
        chunks: SEARCHABLE.length + parents.length,
        parents: parents.length,
        vectors: SEARCHABLE.length,
      },
      timingsMs: { chunk: 1, embed: 2, store: 3, total: 6 },
    },
    vectors: SEARCHABLE.map((c) => ({
      id: c.id,
      vector: VECTORS.get(c.id) as Float32Array,
      metadata: c.metadata,
    })),
    chunks: [...SEARCHABLE, ...parents],
    ...(withKeyword ? { keywordIndex: keyword.serialize() } : {}),
  };
}

/** Writes the fixture index into `root`. */
export async function writeFixtureIndex(root: string, options: FixtureOptions = {}): Promise<void> {
  await new FileIndexWriter(root).write(fixtureContents(options));
}
