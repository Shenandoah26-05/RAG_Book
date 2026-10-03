import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import { z } from "zod";
import { makeDocId } from "../../core/index.js";
import type { DocumentLoader, Page, ParsedDocument, TextItem } from "../../core/index.js";
import { RagError } from "../../shared/index.js";

/** Pages are joined with a blank line in `ParsedDocument.text`. */
const PAGE_SEPARATOR = "\n\n";

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

const fontObject = z.object({ name: z.string().optional(), bold: z.boolean().optional() });
const BOLD_NAME = /bold|black|heavy/i;
/** Fonts embedded as subsets are named "ABCDEF+Times-Bold". */
const SUBSET_PREFIX = /^[A-Z]{6}\+/;

function readFont(
  commonObjs: { get(id: string): unknown },
  fontId: string,
  styles: Readonly<Record<string, { fontFamily?: string } | undefined>>,
): FontInfo {
  let font: unknown;
  try {
    font = commonObjs.get(fontId);
  } catch {
    font = undefined; // the font was not loaded; fall back to what the text layer says
  }
  const parsed = fontObject.safeParse(font).data;
  const name = (parsed?.name ?? styles[fontId]?.fontFamily ?? fontId).replace(SUBSET_PREFIX, "");
  return { name, isBold: parsed?.bold === true || BOLD_NAME.test(name) };
}

let standardFontsDir: string | undefined;
/**
 * pdf.js needs its bundled font files to read PDFs that use the standard 14 fonts. It insists on
 * forward slashes and a trailing slash, even for a Windows path.
 */
function standardFontDataUrl(): string {
  standardFontsDir ??=
    path
      .join(
        path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")),
        "standard_fonts",
      )
      .replaceAll("\\", "/") + "/";
  return standardFontsDir;
}

/** Reads PDFs with pdf.js, page by page, keeping every text item with its font. */
export class PdfJsLoader implements DocumentLoader {
  readonly name = "pdfjs";

  async load(filePath: string): Promise<ParsedDocument> {
    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch (cause) {
      throw new RagError("INGESTION_FAILED", `Cannot read ${filePath}`, { cause });
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    let task: ReturnType<typeof getDocument> | undefined;
    try {
      task = getDocument({
        data: new Uint8Array(bytes),
        standardFontDataUrl: standardFontDataUrl(),
        verbosity: VerbosityLevel.ERRORS,
      });
      const pdf = await task.promise;
      const metadata = await pdf.getMetadata();

      const pages: Page[] = [];
      let offset = 0;
      for (let number = 1; number <= pdf.numPages; number++) {
        const pdfPage = await pdf.getPage(number);
        const content = await pdfPage.getTextContent();
        const raw: RawTextItem[] = [];
        for (const item of content.items) {
          if ("str" in item) raw.push(item); // the rest are structure markers, not text
        }

        const fonts = new Map<string, FontInfo>();
        if (raw.some((item) => item.str !== "")) {
          // Fonts only become available once the page's drawing commands have been read.
          await pdfPage.getOperatorList();
          for (const fontId of new Set(raw.map((item) => item.fontName))) {
            fonts.set(fontId, readFont(pdfPage.commonObjs, fontId, content.styles));
          }
        }

        const page = buildPage(
          number,
          raw,
          (fontId) => fonts.get(fontId) ?? { name: fontId, isBold: false },
          offset,
        );
        pages.push(page);
        offset = page.span.end + PAGE_SEPARATOR.length;
        pdfPage.cleanup();
      }

      return {
        id: makeDocId(sha256),
        title: pickTitle(metadata.info, filePath),
        pageCount: pages.length,
        sha256,
        text: pages.map((page) => page.text).join(PAGE_SEPARATOR),
        pages,
        sections: [],
      };
    } catch (cause) {
      throw new RagError("INGESTION_FAILED", `Cannot extract text from ${filePath}`, { cause });
    } finally {
      await task?.destroy();
    }
  }
}
