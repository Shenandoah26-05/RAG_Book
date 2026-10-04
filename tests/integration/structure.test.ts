import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PdfJsLoader, UnpdfLoader } from "../../src/adapters/index.js";
import { buildCleaner } from "../../src/composition/index.js";
import { DEFAULT_CONFIG } from "../../src/config/index.js";
import type { DocumentLoader, ParsedDocument, Section } from "../../src/core/index.js";
import { documentToMarkdown, FontHeadingDetector, outline } from "../../src/strategies/index.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

/** The pipeline as far as M1 goes: load, clean, find the structure. */
async function ingest(loader: DocumentLoader, file: string): Promise<ParsedDocument> {
  const raw = await loader.load(fixture(file));
  const cleaned = buildCleaner(DEFAULT_CONFIG.ingestion.cleaners).clean(raw);
  return new FontHeadingDetector().detect(cleaned);
}

const shape = (sections: readonly Section[]): unknown[] =>
  sections.map((s) => ({
    title: s.title,
    level: s.level,
    pages: [s.pageStart, s.pageEnd],
    children: shape(s.children),
  }));

describe.each<{ name: string; loader: DocumentLoader }>([
  { name: "pdfjs", loader: new PdfJsLoader() },
  { name: "unpdf", loader: new UnpdfLoader() },
])("section detection on the fixture PDFs, read by $name", ({ loader }) => {
  it("finds chapters and subsections in sample.pdf, with page ranges", async () => {
    const doc = await ingest(loader, "sample.pdf");
    expect(shape(doc.sections)).toEqual([
      {
        title: "Chapter 1: Introduction",
        level: 1,
        pages: [1, 2],
        children: [{ title: "1.1 Background", level: 2, pages: [2, 2], children: [] }],
      },
      { title: "Chapter 2: Methods", level: 1, pages: [3, 3], children: [] },
    ]);
  });

  it("finds the structure in noisy.pdf once the header and page numbers are cleaned away", async () => {
    const doc = await ingest(loader, "noisy.pdf");
    expect(shape(doc.sections)).toEqual([
      {
        title: "Chapter 1: Noise",
        level: 1,
        pages: [1, 6],
        children: [{ title: "1.1 Details", level: 2, pages: [2, 6], children: [] }],
      },
    ]);
  });

  it("gives every section a span that slices out its heading", async () => {
    const doc = await ingest(loader, "sample.pdf");
    const check = (sections: readonly Section[]): void => {
      for (const s of sections) {
        expect(doc.text.slice(s.titleSpan.start, s.titleSpan.end)).toBe(s.title);
        expect(doc.text.slice(s.span.start, s.span.end).startsWith(s.title)).toBe(true);
        check(s.children);
      }
    };
    check(doc.sections);
  });

  it("does not mistake the running header or page numbers for headings, even without cleaning", async () => {
    const raw = await loader.load(fixture("noisy.pdf"));
    const titles = new FontHeadingDetector()
      .detect(raw)
      .sections.flatMap((s) => [s.title, ...s.children.map((c) => c.title)]);
    expect(titles).toEqual(["Chapter 1: Noise", "1.1 Details"]);
  });

  it("exports the whole document as Markdown", async () => {
    const markdown = documentToMarkdown(await ingest(loader, "sample.pdf"));
    expect(markdown).toBe(
      [
        "<!-- page 1 -->",
        "",
        "# Chapter 1: Introduction",
        "",
        "Retrieval-augmented generation combines search with a language model.",
        "This sample book exists to test the PDF loader.",
        "",
        "<!-- page 2 -->",
        "",
        "## 1.1 Background",
        "",
        "Embeddings turn sentences into vectors that can be compared.",
        "Chunking splits a document into passages.",
        "",
        "<!-- page 3 -->",
        "",
        "# Chapter 2: Methods",
        "",
        "Each page keeps its own text.",
        "",
        "<!-- page 4 -->",
        "",
      ].join("\n"),
    );
  });

  it("prints an outline", async () => {
    const doc = await ingest(loader, "sample.pdf");
    expect(outline(doc.sections)).toBe(
      [
        "Chapter 1: Introduction  (pp.1-2)",
        "  1.1 Background  (p.2)",
        "Chapter 2: Methods  (p.3)",
      ].join("\n"),
    );
  });
});

describe("what only pdf.js can tell (bold)", () => {
  it("pdf.js reports bold text and unpdf never does, so only pdf.js can find bold headings at body size", async () => {
    // The fixtures have no such heading, so this checks the premise the detector relies on.
    const [a, b] = await Promise.all([
      new PdfJsLoader().load(fixture("sample.pdf")),
      new UnpdfLoader().load(fixture("sample.pdf")),
    ]);
    expect(a.pages.flatMap((p) => p.items).some((i) => i.isBold)).toBe(true);
    expect(b.pages.flatMap((p) => p.items).some((i) => i.isBold)).toBe(false);
  });
});
