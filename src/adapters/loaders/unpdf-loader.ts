import { extractTextItems, getDocumentProxy, getMeta } from "unpdf";
import type { DocumentLoader, ParsedDocument } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { DocumentAssembler, readSourceFile } from "./pdf-pages.js";
import type { RawTextItem } from "./pdf-pages.js";

/**
 * Reads PDFs with unpdf, a packaging of pdf.js made to run anywhere without extra setup. Its text
 * items carry the font size but only a generic font family and no bold flag, so every item here
 * is reported as not bold.
 */
export class UnpdfLoader implements DocumentLoader {
  readonly name = "unpdf";

  async load(filePath: string): Promise<ParsedDocument> {
    const { bytes, sha256 } = await readSourceFile(filePath);

    try {
      // verbosity 0 = errors only; the default prints font warnings for many ordinary PDFs.
      const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
      const { items } = await extractTextItems(pdf);
      const { info } = await getMeta(pdf);

      const assembler = new DocumentAssembler();
      items.forEach((pageItems, index) => {
        const raw = pageItems.map((item): RawTextItem => ({
          str: item.str,
          transform: [item.fontSize, 0, 0, item.fontSize, item.x, item.y],
          width: item.width,
          hasEOL: item.hasEOL,
          fontName: item.fontFamily === "" ? "unknown" : item.fontFamily,
        }));
        assembler.addPage(index + 1, raw, (name) => ({ name, isBold: false }));
      });
      return assembler.build({ filePath, sha256, info });
    } catch (cause) {
      throw new RagError("INGESTION_FAILED", `Cannot extract text from ${filePath}`, { cause });
    }
  }
}
