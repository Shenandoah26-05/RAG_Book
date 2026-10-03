import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { makeDocId, PAGE_SEPARATOR } from "../../core/index.js";
import type { Page, ParsedDocument, TextItem } from "../../core/index.js";
import { RagError } from "../../shared/index.js";

// Pieces shared by every PDF loader, so that two loaders differ only in how they extract text.

/** The parts of a pdf.js text item that we use. */
export interface RawTextItem {
  readonly str: string;
  /** [scaleX, skewY, skewX, scaleY, x, y]: how the text is placed on the page. */
  readonly transform: readonly number[];
  readonly width: number;
  /** True when this item ends a line. */
  readonly hasEOL: boolean;
  readonly fontName: string;
}

export interface FontInfo {
  readonly name: string;
  readonly isBold: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Builds one page from pdf.js text items. The text is each item's string, plus a newline after an
 * item that ends a line. pdf.js marks line ends on separate empty items, which add a newline but
 * are not kept as items. `offset` is where the page starts in the document's text.
 */
export function buildPage(
  number: number,
  rawItems: readonly RawTextItem[],
  fontOf: (fontId: string) => FontInfo,
  offset: number,
): Page {
  let text = "";
  const items: TextItem[] = [];

  for (const raw of rawItems) {
    if (raw.str !== "") {
      const font = fontOf(raw.fontName);
      const start = offset + text.length;
      items.push({
        text: raw.str,
        x: round2(raw.transform[4] ?? 0),
        y: round2(raw.transform[5] ?? 0),
        width: round2(raw.width),
        fontSize: round2(Math.hypot(raw.transform[0] ?? 0, raw.transform[1] ?? 0)),
        fontName: font.name,
        isBold: font.isBold,
        span: { start, end: start + raw.str.length },
      });
      text += raw.str;
    }
    if (raw.hasEOL) text += "\n";
  }
  return { number, text, span: { start: offset, end: offset + text.length }, items };
}

const pdfInfo = z.object({ Title: z.string().optional() });

/** The document's own title if it has one, otherwise the file name without its extension. */
export function pickTitle(info: unknown, filePath: string): string {
  const title = pdfInfo.safeParse(info).data?.Title?.trim();
  return title === undefined || title === "" ? path.parse(filePath).name : title;
}

/** Reads a file, or fails with INGESTION_FAILED naming the path. */
export async function readSourceFile(
  filePath: string,
): Promise<{ readonly bytes: Buffer; readonly sha256: string }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (cause) {
    throw new RagError("INGESTION_FAILED", `Cannot read ${filePath}`, { cause });
  }
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * Collects pages in order and produces the ParsedDocument. It tracks where each page starts in the
 * document text, so every span stays consistent with `ParsedDocument.text`.
 */
export class DocumentAssembler {
  readonly #pages: Page[] = [];
  #offset = 0;

  addPage(
    number: number,
    rawItems: readonly RawTextItem[],
    fontOf: (fontId: string) => FontInfo,
  ): void {
    const page = buildPage(number, rawItems, fontOf, this.#offset);
    this.#pages.push(page);
    this.#offset = page.span.end + PAGE_SEPARATOR.length;
  }

  build(source: {
    readonly filePath: string;
    readonly sha256: string;
    readonly info: unknown;
  }): ParsedDocument {
    return {
      id: makeDocId(source.sha256),
      title: pickTitle(source.info, source.filePath),
      pageCount: this.#pages.length,
      sha256: source.sha256,
      text: this.#pages.map((page) => page.text).join(PAGE_SEPARATOR),
      pages: [...this.#pages],
      sections: [],
    };
  }
}
