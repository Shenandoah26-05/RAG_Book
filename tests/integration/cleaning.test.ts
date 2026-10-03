import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { PdfJsLoader, UnpdfLoader } from "../../src/adapters/index.js";
import { buildCleaner } from "../../src/composition/index.js";
import { DEFAULT_CONFIG } from "../../src/config/index.js";
import type { DocumentLoader, ParsedDocument } from "../../src/core/index.js";
import {
  expectConsistent,
  pageTexts,
} from "../../src/strategies/cleaning/make-document.testing.js";

const NOISY = fileURLToPath(new URL("../fixtures/noisy.pdf", import.meta.url));

const CLEAN_TEXT = [
  "Chapter 1: Noise\nCleaning removes extraction noise before chunking.\nWords are split with a hyphen across lines.",
  "1.1 Details\nThe header and the page number repeat on every page.\nEmbeddings turn sentences into vectors that can be compared.",
  "Body text of the third page.",
  "Body text of the fourth page.",
  "Body text of the fifth page.",
  "Body text of the sixth page.",
];

describe.each<{ name: string; loader: DocumentLoader }>([
  { name: "pdfjs", loader: new PdfJsLoader() },
  { name: "unpdf", loader: new UnpdfLoader() },
])("cleaning tests/fixtures/noisy.pdf, read by $name", ({ loader }) => {
  let raw: ParsedDocument;
  let cleaned: ParsedDocument;
  beforeAll(async () => {
    raw = await loader.load(NOISY);
    cleaned = buildCleaner(DEFAULT_CONFIG.ingestion.cleaners).clean(raw);
  });

  it("starts out noisy: a running header, printed page numbers and split words", () => {
    expect(raw.pages[0]?.text).toContain("The RAG Handbook");
    expect(raw.pages[0]?.text.endsWith("\n3")).toBe(true);
    expect(raw.pages[0]?.text).toContain("hyph-\nen");
    expect(raw.pages[5]?.text.endsWith("\n8")).toBe(true);
  });

  it("ends up as clean text, page by page", () => {
    expect(pageTexts(cleaned)).toEqual(CLEAN_TEXT);
  });

  it("keeps every page, item and span consistent with the cleaned text", () => {
    expectConsistent(cleaned);
    expect(cleaned.pageCount).toBe(raw.pageCount);
    expect(cleaned.pages.map((p) => p.number)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("does not change what identifies the document", () => {
    expect(cleaned.id).toBe(raw.id);
    expect(cleaned.sha256).toBe(raw.sha256);
    expect(cleaned.title).toBe(raw.title);
  });

  it("drops the header and page number items, and trims the two halves of a split word", () => {
    const itemTexts = cleaned.pages.flatMap((p) => p.items.map((i) => i.text));
    expect(itemTexts).not.toContain("The RAG Handbook");
    expect(itemTexts.filter((t) => /^\d+$/.test(t))).toEqual([]);
    // the joined word is "hyphen": "hyph" ends one item and "en across lines." starts the next
    expect(itemTexts).toContain("Words are split with a hyph");
    expect(itemTexts).toContain("en across lines.");
  });

  it("keeps the font size and position of the headings that heading detection needs", () => {
    const heading = cleaned.pages[0]?.items.find((i) => i.text === "Chapter 1: Noise");
    const subheading = cleaned.pages[1]?.items.find((i) => i.text === "1.1 Details");
    const body = cleaned.pages[0]?.items.find((i) => i.text.startsWith("Cleaning removes"));

    expect(heading).toMatchObject({ fontSize: 24, y: 700 });
    expect(subheading).toMatchObject({ fontSize: 16, y: 700 });
    expect(body).toMatchObject({ fontSize: 12 });
  });

  it("is idempotent: cleaning a clean document changes nothing", () => {
    expect(buildCleaner(DEFAULT_CONFIG.ingestion.cleaners).clean(cleaned)).toBe(cleaned);
  });

  it("each cleaner does only its own job", () => {
    const only = (name: string): string[] => pageTexts(buildCleaner([name]).clean(raw));

    expect(only("page-numbers")[0]).toBe(
      "The RAG Handbook\nChapter 1: Noise\nCleaning removes extraction noise before chunking.\nWords are split with a hyph-\nen across lines.",
    );
    // with digits masked, the printed numbers repeat on every page like any other footer
    expect(only("headers-footers")[0]).toBe(
      "Chapter 1: Noise\nCleaning removes extraction noise before chunking.\nWords are split with a hyph-\nen across lines.",
    );
    expect(only("dehyphenate")[0]).toContain("with a hyphen across lines.");
    expect(only("dehyphenate")[0]).toContain("The RAG Handbook");
  });

  it("the unicode cleaner has nothing to do here, because pdf.js already normalises spaces", () => {
    expect(buildCleaner(["unicode"]).clean(raw)).toBe(raw);
  });
});

describe("the font detail survives cleaning (pdfjs)", () => {
  it("keeps the bold flag and real font name on headings", async () => {
    const raw = await new PdfJsLoader().load(NOISY);
    const cleaned = buildCleaner(DEFAULT_CONFIG.ingestion.cleaners).clean(raw);
    const heading = cleaned.pages[0]?.items.find((i) => i.text === "Chapter 1: Noise");
    expect(heading).toMatchObject({ isBold: true, fontName: "Helvetica-Bold" });
  });
});
