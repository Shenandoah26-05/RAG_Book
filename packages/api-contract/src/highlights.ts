import { z } from "zod";
import { docIdSchema } from "./schemas.js";

// Where a passage of the book sits on its pages, so a reader can mark it (RAG-103).

/** The longest passage the API will place, in characters: a chunk is a few thousand at most. */
export const MAX_HIGHLIGHT_CHARS = 20_000;

/**
 * `GET /highlights`: the passage `[from, to)` of the document's text, as given by a citation's
 * `charStart` and `charEnd`. The document is named when the index holds several.
 */
export const highlightRequestSchema = z
  .strictObject({
    from: z
      .string()
      .regex(/^\d{1,9}$/, "must be a character offset")
      .transform(Number),
    to: z
      .string()
      .regex(/^\d{1,9}$/, "must be a character offset")
      .transform(Number),
    doc: docIdSchema.optional(),
  })
  .refine((r) => r.from < r.to, { error: "`from` must be before `to`" })
  .refine((r) => r.to - r.from <= MAX_HIGHLIGHT_CHARS, {
    error: `the passage may be at most ${MAX_HIGHLIGHT_CHARS.toString()} characters`,
  });
export type HighlightRequest = z.infer<typeof highlightRequestSchema>;

/**
 * A rectangle on a page in **PDF points** (1/72 inch), measured from the **bottom-left** corner of
 * the page, as the PDF itself does. Turning it into screen pixels needs the size of the page as the
 * viewer draws it, which only the viewer knows.
 */
export const wireBoxSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});
export type WireBox = z.infer<typeof wireBoxSchema>;

/** The boxes of one page: one per line of the passage that falls on it. */
export const wireHighlightPageSchema = z.strictObject({
  number: z.number().int().min(1),
  boxes: z.array(wireBoxSchema),
});
export type WireHighlightPage = z.infer<typeof wireHighlightPageSchema>;

/**
 * `GET /highlights`: the pages the passage touches, first to last. A page where the loader recorded
 * no text positions has no boxes (the page is still listed), so a reader can tell "the passage is on
 * this page" from "it is not".
 */
export const highlightResponseSchema = z.strictObject({
  docId: docIdSchema,
  pages: z.array(wireHighlightPageSchema),
});
export type HighlightResponse = z.infer<typeof highlightResponseSchema>;
