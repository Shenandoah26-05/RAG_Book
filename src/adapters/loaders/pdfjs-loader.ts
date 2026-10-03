import { createRequire } from "node:module";
import path from "node:path";
import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import { z } from "zod";
import type { DocumentLoader, ParsedDocument } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { DocumentAssembler, readSourceFile } from "./pdf-pages.js";
import type { FontInfo, RawTextItem } from "./pdf-pages.js";

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

/** Reads PDFs with pdf.js, page by page, keeping every text item with its real font. */
export class PdfJsLoader implements DocumentLoader {
  readonly name = "pdfjs";

  async load(filePath: string): Promise<ParsedDocument> {
    const { bytes, sha256 } = await readSourceFile(filePath);

    let task: ReturnType<typeof getDocument> | undefined;
    try {
      task = getDocument({
        data: new Uint8Array(bytes),
        standardFontDataUrl: standardFontDataUrl(),
        verbosity: VerbosityLevel.ERRORS,
      });
      const pdf = await task.promise;
      const metadata = await pdf.getMetadata();

      const assembler = new DocumentAssembler();
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

        assembler.addPage(
          number,
          raw,
          (fontId) => fonts.get(fontId) ?? { name: fontId, isBold: false },
        );
        pdfPage.cleanup();
      }
      return assembler.build({ filePath, sha256, info: metadata.info });
    } catch (cause) {
      throw new RagError("INGESTION_FAILED", `Cannot extract text from ${filePath}`, { cause });
    } finally {
      await task?.destroy();
    }
  }
}
