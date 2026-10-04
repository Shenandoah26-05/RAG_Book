import type {
  Cleaner,
  DocId,
  DocumentLoader,
  DocumentStore,
  ParsedDocument,
  Section,
  SectionDetector,
} from "../core/index.js";
import { makeDocId, RagError, Trace } from "../shared/index.js";
import type { Logger } from "../shared/index.js";

// ---------------------------------------------------------------------------------------------
// What ingest needs, and what it returns
// ---------------------------------------------------------------------------------------------

/** The parts the pipeline is built from. All of them are interfaces; the composition root picks the real ones. */
export interface IngestDeps {
  /** Reads the file and extracts the text. */
  readonly loader: DocumentLoader;
  /** Removes extraction noise: odd characters, headers, page numbers, split words. */
  readonly cleaner: Cleaner;
  /** Finds the chapters and sections. */
  readonly detector: SectionDetector;
  /** Keeps the finished document. */
  readonly store: DocumentStore;
  readonly logger: Logger;
  /** SHA-256 (hex) of a file's contents. The document id is derived from it. */
  readonly hashFile: (filePath: string) => Promise<string>;
}

export interface IngestOptions {
  /** Process the file again even if a result is already stored. */
  readonly force?: boolean;
}

/** What happened: the file was processed now, or an earlier result was found and left alone. */
export type IngestResult =
  | {
      readonly status: "ingested";
      readonly docId: DocId;
      /** Where the processed document was stored. */
      readonly location: string;
      readonly pages: number;
      /** All sections, subsections included. */
      readonly sections: number;
      readonly durationMs: number;
    }
  | {
      readonly status: "skipped";
      readonly docId: DocId;
      /** Where the earlier result is. */
      readonly location: string;
    };

/** How many sections there are in a tree, counting every level. */
const countSections = (sections: readonly Section[]): number =>
  sections.reduce((total, section) => total + 1 + countSections(section.children), 0);

// ---------------------------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------------------------

/**
 * Turns a PDF into a stored, processed document, in four steps:
 *
 *   load -> clean -> detect sections -> save
 *
 * Running it again on the same file does nothing, because the result is stored under an id taken
 * from the hash of the file's contents. That makes the command safe to repeat:
 *   - a renamed or moved copy of a file is recognised as the same document;
 *   - an edited file has a different hash, so it is a new document;
 *   - `force` processes the file again regardless.
 *
 * Only the file's hash is checked. If the cleaners or the section detector change, stored
 * documents are not refreshed automatically: run again with `force`.
 */
export async function ingest(
  deps: IngestDeps,
  filePath: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const { loader, cleaner, detector, store, logger, hashFile } = deps;
  const log = logger.child({ file: filePath });

  // Work out which document this is before doing any of the expensive work.
  const docId = makeDocId(await hashFile(filePath));
  const location = store.locationOf(docId);

  // Already done? Then stop here. This is what makes a second run take almost no time.
  const forced = options.force === true;
  if (!forced && (await store.has(docId))) {
    log.info("unchanged, skipping (use --force to process again)", { docId, location });
    return { status: "skipped", docId, location };
  }

  log.info("ingesting", { loader: loader.name, force: forced });

  // The trace times each step. Its total is the duration that gets logged at the end.
  const trace = new Trace();

  const loaded = await trace.run(
    "load",
    () => loader.load(filePath),
    (doc) => ({ pages: doc.pageCount, characters: doc.text.length }),
  );
  assertSameFile(loaded, docId, filePath);

  const cleaned = await trace.run(
    "clean",
    () => cleaner.clean(loaded),
    (doc) => ({ characters: doc.text.length }),
  );

  const structured = await trace.run(
    "detect-sections",
    () => detector.detect(cleaned),
    (doc) => ({ sections: countSections(doc.sections) }),
  );

  const storedAt = await trace.run("save", () => store.save(structured));

  const result: IngestResult = {
    status: "ingested",
    docId,
    location: storedAt,
    pages: structured.pageCount,
    sections: countSections(structured.sections),
    durationMs: Math.round(trace.snapshot().totalMs),
  };
  log.info("ingested", {
    pages: result.pages,
    sections: result.sections,
    durationMs: result.durationMs,
    location: result.location,
  });
  return result;
}

/**
 * The file is read twice: once to hash it, once by the loader. If someone replaced it in between,
 * the document we built would be stored under the wrong id, so stop instead.
 */
function assertSameFile(loaded: ParsedDocument, expected: DocId, filePath: string): void {
  if (loaded.id !== expected) {
    throw new RagError("INGESTION_FAILED", `${filePath} changed while it was being read`);
  }
}
