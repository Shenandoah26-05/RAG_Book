import { stat } from "node:fs/promises";
import type { DocId } from "../core/index.js";
import { isDocId, makeDocId, RagError, sha256OfFile } from "../shared/index.js";

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/** The document id for what the user typed: an id as it is, a PDF by the hash of its contents. */
export async function resolveDocId(target: string): Promise<DocId> {
  if (isDocId(target)) return target;
  if (await isFile(target)) return makeDocId(await sha256OfFile(target));
  throw new RagError(
    "INVALID_ARGUMENT",
    `"${target}" is neither a document id nor an existing file`,
  );
}
