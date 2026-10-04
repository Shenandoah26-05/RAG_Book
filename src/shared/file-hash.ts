import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { RagError } from "./errors.js";

/**
 * SHA-256 (hex) of a file's contents, read as a stream so a large book is never held in memory.
 * Rejects with INGESTION_FAILED, naming the file, if it cannot be read.
 */
export async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(filePath)) {
      hash.update(chunk as Buffer);
    }
  } catch (cause) {
    throw new RagError("INGESTION_FAILED", `Cannot read ${filePath}`, { cause });
  }
  return hash.digest("hex");
}
