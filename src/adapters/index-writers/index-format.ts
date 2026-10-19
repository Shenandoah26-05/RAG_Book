import path from "node:path";
import { z } from "zod";
import { INDEX_MANIFEST_VERSION } from "../../core/index.js";
import { RagError } from "../../shared/index.js";

// What the folder of one index looks like. Shared by the writer and the reader, so the two cannot
// drift apart.

export const MANIFEST_FILE = "manifest.json";
export const CHUNKS_FILE = "chunks.jsonl";
export const VECTORS_FILE = "vectors.bin";
export const KEYWORD_FILE = "keyword.json";

/** A namespace becomes a folder name: letters, digits, `.`, `_` and `-`, never starting with a dot. */
const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The folder of `namespace` inside `root`. @throws RagError INVALID_ARGUMENT for a name that could leave it */
export function namespaceFolder(root: string, namespace: string): string {
  if (!NAMESPACE.test(namespace) || namespace.includes("..")) {
    throw new RagError("INVALID_ARGUMENT", `Not an index namespace: "${namespace}"`);
  }
  return path.join(root, namespace);
}

const count = z.number().int().nonnegative();

/** The shape of `manifest.json`. Unknown keys are rejected, so a manifest of another version fails loudly. */
export const manifestSchema = z.strictObject({
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

/** One line of `chunks.jsonl`. */
export const chunkLineSchema = z.strictObject({
  indexed: z.boolean(),
  chunk: z.strictObject({
    id: z.string(),
    text: z.string(),
    embedText: z.string().optional(),
    parentId: z.string().optional(),
    metadata: z.strictObject({
      docId: z.string(),
      pageStart: count,
      pageEnd: count,
      sectionPath: z.array(z.string()),
      charStart: count,
      charEnd: count,
      strategy: z.string(),
    }),
  }),
});
