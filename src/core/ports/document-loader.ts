import type { ParsedDocument } from "../types/document.js";

/** Reads a source file into a ParsedDocument. One implementation per file format or library. */
export interface DocumentLoader {
  /** The name used in config, e.g. "pdfjs". */
  readonly name: string;
  /** Rejects with a RagError coded INGESTION_FAILED if the file cannot be read or understood. */
  load(filePath: string): Promise<ParsedDocument>;
}
