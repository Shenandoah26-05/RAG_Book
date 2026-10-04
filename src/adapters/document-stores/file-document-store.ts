import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DocId, DocumentStore, ParsedDocument } from "../../core/index.js";
import { isDocId, RagError } from "../../shared/index.js";
import { readStoredFile, toStoredFile } from "./stored-document.js";

/**
 * Keeps each processed document as one JSON file, `<folder>/<docId>.json`.
 *
 * The file holds the whole document, so you can open it to see exactly what the later steps
 * (chunking, embedding, search) are given. See stored-document.ts for what is in it.
 */
export class FileDocumentStore implements DocumentStore {
  readonly #folder: string;
  readonly #now: () => Date;

  /**
   * @param folder where the files go. It is created when the first document is saved.
   * @param now the clock, for the "ingestedAt" timestamp. Tests pass a fixed one.
   */
  constructor(folder: string, now: () => Date = () => new Date()) {
    this.#folder = folder;
    this.#now = now;
  }

  // -------------------------------------------------------------------------------------------
  // Where documents are kept
  // -------------------------------------------------------------------------------------------

  /** The file for this id, whether or not it exists yet. */
  locationOf(id: DocId): string {
    // The id becomes part of a file name. Accepting only what a document id looks like means an
    // id such as "../../secrets" can never point outside the folder. (The type says DocId, but a
    // value can reach here from outside the type system, so it is checked at run time as well.)
    const candidate: string = id;
    if (!isDocId(candidate)) {
      throw new RagError("INVALID_ARGUMENT", `Not a document id: "${candidate}"`);
    }
    return path.join(this.#folder, `${candidate}.json`);
  }

  async has(id: DocId): Promise<boolean> {
    try {
      return (await stat(this.locationOf(id))).isFile();
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------------------------

  /** The stored document, or undefined if there is none. Rejects if the file is damaged. */
  async load(id: DocId): Promise<ParsedDocument | undefined> {
    const file = this.locationOf(id);

    const text = await this.#readText(file);
    if (text === undefined) return undefined;

    // Step 1: is it JSON at all? A file cut short by a crash or edited by hand may not be.
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (cause) {
      throw new RagError("INGESTION_FAILED", `${file} is damaged (it is not valid JSON)`, {
        cause,
      });
    }

    // Step 2: does it have the shape of a stored document, in this version of the format?
    const result = readStoredFile(json);
    if ("problem" in result) {
      throw new RagError(
        "INGESTION_FAILED",
        `${file} is damaged or from another version (${result.problem}). Re-run with --force.`,
      );
    }
    return result.document;
  }

  /** The text of the file, or undefined if it does not exist. */
  async #readText(file: string): Promise<string | undefined> {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw new RagError("INGESTION_FAILED", `Cannot read ${file}`, { cause: error });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------------------------

  /** Stores the document, replacing any earlier one with the same id. Returns the file's path. */
  async save(doc: ParsedDocument): Promise<string> {
    const file = this.locationOf(doc.id);

    // Compact JSON, not indented: a book has hundreds of thousands of text items, and indenting
    // would make the file several times bigger. Use `pnpm export:markdown` to read a document.
    const contents = JSON.stringify(toStoredFile(doc, this.#now()));

    await mkdir(this.#folder, { recursive: true });
    await this.#writeAtomically(file, contents);
    return file;
  }

  /**
   * Writes the file so that it is either complete or not there at all. The contents go to a
   * temporary file first, and renaming that file over the real one is a single step. If the program
   * stops half way through, the real file is untouched and only the temporary file is left over.
   */
  async #writeAtomically(file: string, contents: string): Promise<void> {
    const temporary = `${file}.${process.pid.toString()}.tmp`;
    try {
      await writeFile(temporary, contents);
      await rename(temporary, file);
    } catch (cause) {
      await rm(temporary, { force: true }); // do not leave the half-written file behind
      throw new RagError("INGESTION_FAILED", `Cannot write ${file}`, { cause });
    }
  }
}

/** True if the error says that the file or folder does not exist (ENOENT). */
function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
