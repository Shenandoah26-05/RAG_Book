import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ByteRange, SourceFile, SourceFileStore } from "../../core/index.js";
import { sha256OfFile } from "../../shared/index.js";

/** What is known about a file in the folder; hashing is the slow part, so it is remembered. */
interface Known {
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}

/**
 * Finds a PDF in one folder (default `data/raw`, where `pnpm ingest` is pointed) by the SHA-256 of
 * its contents. A request never carries a path: it carries a hash, and the store looks for a file
 * that has it. Only `*.pdf` directly inside the folder are considered.
 *
 * Each file is hashed once and again only if its size or modification time changes, so the first
 * lookup reads the PDFs in the folder and later ones read nothing but the directory listing. A
 * folder that does not exist has no files.
 */
export class DirectorySourceFileStore implements SourceFileStore {
  readonly #dir: string;
  readonly #known = new Map<string, Known>();

  constructor(dir: string) {
    this.#dir = dir;
  }

  async find(sha256: string): Promise<SourceFile | undefined> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch {
      return undefined;
    }
    for (const name of names.filter((n) => n.toLowerCase().endsWith(".pdf")).sort()) {
      const file = path.join(this.#dir, name);
      let hash: Known | undefined;
      try {
        hash = await this.#hashOf(file);
      } catch {
        continue; // unreadable, or removed since the listing: it cannot be the one
      }
      if (hash?.sha256 === sha256) return pdfFile(file, hash.size);
    }
    return undefined;
  }

  async #hashOf(file: string): Promise<Known | undefined> {
    const info = await stat(file);
    if (!info.isFile()) return undefined;
    const known = this.#known.get(file);
    if (known?.size === info.size && known.mtimeMs === info.mtimeMs) return known;
    const fresh: Known = {
      size: info.size,
      mtimeMs: info.mtimeMs,
      sha256: await sha256OfFile(file),
    };
    this.#known.set(file, fresh);
    return fresh;
  }
}

function pdfFile(file: string, size: number): SourceFile {
  return {
    size,
    mediaType: "application/pdf",
    read(range?: ByteRange): AsyncIterable<Uint8Array> {
      // The stream is opened when the first byte is asked for, and closed if the reader stops.
      return createReadStream(
        file,
        range === undefined ? {} : { start: range.start, end: range.end },
      );
    },
  };
}
