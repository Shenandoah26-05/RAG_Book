import type { CharSpan, ParsedDocument } from "../../core/index.js";
import type { Gold } from "./schema.js";

export type ResolvedGold =
  | { readonly ok: true; readonly page: number; readonly span: CharSpan }
  | {
      readonly ok: false;
      readonly code: "page-missing" | "quote-not-found" | "quote-ambiguous";
      readonly message: string;
    };

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Finds a gold quote in the document and returns where it sits in `ParsedDocument.text`, as the
 * half-open character range `[start, end)` that chunk spans are compared with.
 *
 * Whitespace is matched loosely (a line break in the PDF is a space in the quote). A quote that
 * appears twice on its page is refused, because the label would not say which one holds the answer.
 */
export function resolveGold(doc: ParsedDocument, gold: Gold): ResolvedGold {
  const page = doc.pages.find((p) => p.number === gold.page);
  if (page === undefined) {
    return {
      ok: false,
      code: "page-missing",
      message: `page ${gold.page.toString()} does not exist (the document has ${doc.pageCount.toString()})`,
    };
  }
  const pattern = new RegExp(gold.quote.trim().split(/\s+/).map(escapeRegExp).join("\\s+"), "g");
  const matches = [...page.text.matchAll(pattern)];
  const first = matches[0];
  if (first === undefined) {
    return {
      ok: false,
      code: "quote-not-found",
      message: `page ${gold.page.toString()} does not contain "${gold.quote}"`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      code: "quote-ambiguous",
      message: `"${gold.quote}" appears ${matches.length.toString()} times on page ${gold.page.toString()}; quote more words`,
    };
  }
  const start = page.span.start + first.index;
  return { ok: true, page: gold.page, span: { start, end: start + first[0].length } };
}
