import { z } from "zod";
import { isDocId } from "../../shared/index.js";
import type { ParsedDocument, Section } from "../../core/index.js";

// What a processed document looks like on disk, and how to check that a file really has that shape.
//
// A file is data from outside the program: it may be cut short, edited, or written by an older
// version. So everything read back is checked here instead of being trusted. The schema mirrors
// the types in core/types/document.ts; keep the two in step.

/**
 * Bump this when the stored layout changes. A file with another version is reported as such,
 * instead of being misread.
 *
 *   1: the document id was a SHA-256 hash
 *   2: the document id is a UUID
 */
export const FORMAT_VERSION = 2;

/** A character offset: a whole number, never negative. */
const offset = z.number().int().nonnegative();

/** A half-open range of characters, as in `CharSpan`. */
const span = z.strictObject({ start: offset, end: offset });

/** One run of text with its font and position, as in `TextItem`. */
const textItem = z.strictObject({
  text: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  fontSize: z.number(),
  fontName: z.string(),
  isBold: z.boolean(),
  span,
});

/** One page, as in `Page`. Page numbers start at 1. */
const page = z.strictObject({
  number: z.number().int().positive(),
  text: z.string(),
  span,
  items: z.array(textItem),
});

/**
 * A heading and everything under it, as in `Section`. Sections contain sections, so the schema
 * refers to itself; `z.lazy` delays the reference until the schema exists.
 */
const section: z.ZodType<Section> = z.lazy(() =>
  z.strictObject({
    title: z.string(),
    level: z.number().int().positive(),
    pageStart: z.number().int().positive(),
    pageEnd: z.number().int().positive(),
    span,
    titleSpan: span,
    children: z.array(section),
  }),
);

/** The whole file: a small header, then the document. */
const storedFile = z.strictObject({
  version: z.literal(FORMAT_VERSION),
  /** When the document was processed, as an ISO 8601 timestamp. */
  ingestedAt: z.string(),
  document: z.strictObject({
    id: z.string().refine(isDocId, "must be a document id (a UUID)"),
    title: z.string(),
    pageCount: offset,
    /** SHA-256 (hex) of the source file. */
    sha256: z.string(),
    text: z.string(),
    pages: z.array(page),
    sections: z.array(section),
  }),
});

/** What goes into a stored file. */
export function toStoredFile(document: ParsedDocument, ingestedAt: Date): unknown {
  return { version: FORMAT_VERSION, ingestedAt: ingestedAt.toISOString(), document };
}

/** Why a stored file was rejected, in one line. */
export type StoredFileProblem = string;

/**
 * Checks parsed JSON against the stored layout. Returns the document, or the first problem found.
 * The checks are about shape (the right fields with the right types), not about whether the spans
 * agree with the text.
 */
export function readStoredFile(
  json: unknown,
): { readonly document: ParsedDocument } | { readonly problem: StoredFileProblem } {
  const parsed = storedFile.safeParse(json);
  if (!parsed.success) {
    return { problem: parsed.error.issues[0]?.message ?? "unexpected shape" };
  }
  // `refine(isDocId)` in the schema both checks the id and narrows its type, so this is a DocId.
  return { document: parsed.data.document };
}
