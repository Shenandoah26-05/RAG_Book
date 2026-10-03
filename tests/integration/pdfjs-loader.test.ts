import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { PdfJsLoader } from "../../src/adapters/index.js";
import { makeDocId } from "../../src/core/index.js";
import type { ParsedDocument } from "../../src/core/index.js";
import { RagError } from "../../src/shared/index.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/sample.pdf", import.meta.url));

describe("PdfJsLoader on tests/fixtures/sample.pdf", () => {
  let doc: ParsedDocument;
  beforeAll(async () => {
    doc = await new PdfJsLoader().load(FIXTURE);
  });

  it("is named for the config value", () => {
    expect(new PdfJsLoader().name).toBe("pdfjs");
  });

  it("reads the metadata: title, page count and the sha256 of the file", () => {
    const expected = createHash("sha256").update(readFileSync(FIXTURE)).digest("hex");
    expect(doc.title).toBe("Sample Book");
    expect(doc.pageCount).toBe(4);
    expect(doc.pages).toHaveLength(4);
    expect(doc.sha256).toBe(expected);
    expect(doc.id).toBe(makeDocId(expected));
  });

  it("numbers pages from 1", () => {
    expect(doc.pages.map((p) => p.number)).toEqual([1, 2, 3, 4]);
  });

  it("returns the text of each page", () => {
    expect(doc.pages[0]?.text).toBe(
      [
        "Chapter 1: Introduction",
        "Retrieval-augmented generation combines search with a language model.",
        "This sample book exists to test the PDF loader.",
      ].join("\n"),
    );
    expect(doc.pages[1]?.text).toBe(
      [
        "1.1 Background",
        "Embeddings turn sentences into vec-",
        "tors that can be compared.",
        "Chunking splits a document into passages.",
      ].join("\n"),
    );
    expect(doc.pages[2]?.text).toBe("Chapter 2: Methods\nEach page keeps its own text.");
  });

  it("gives a page with no text layer empty text and no items", () => {
    expect(doc.pages[3]).toMatchObject({ number: 4, text: "", items: [] });
  });

  it("keeps the document invariant: every page's span slices out exactly its text", () => {
    for (const page of doc.pages) {
      expect(doc.text.slice(page.span.start, page.span.end)).toBe(page.text);
    }
    expect(doc.text).toBe(doc.pages.map((p) => p.text).join("\n\n"));
  });

  it("keeps every text item's span pointing at its own text in the document", () => {
    const items = doc.pages.flatMap((p) => p.items);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(doc.text.slice(item.span.start, item.span.end)).toBe(item.text);
    }
  });

  it("keeps font size and weight, which heading detection needs", () => {
    const page1 = doc.pages[0]?.items ?? [];
    const heading = page1.find((i) => i.text === "Chapter 1: Introduction");
    const body = page1.find((i) => i.text.startsWith("Retrieval-augmented"));

    expect(heading).toMatchObject({
      fontSize: 24,
      fontName: "Helvetica-Bold",
      isBold: true,
      x: 72,
      y: 700,
    });
    expect(body).toMatchObject({ fontSize: 12, fontName: "Helvetica", isBold: false });

    const subheading = doc.pages[1]?.items.find((i) => i.text === "1.1 Background");
    expect(subheading).toMatchObject({ fontSize: 16, isBold: true });
  });

  it("does not detect sections yet (that is a later step)", () => {
    expect(doc.sections).toEqual([]);
  });

  it("gives the same document, with the same id, every time", async () => {
    const again = await new PdfJsLoader().load(FIXTURE);
    expect(again).toEqual(doc);
  });
});

describe("PdfJsLoader errors", () => {
  it("rejects a missing file with INGESTION_FAILED, naming the path", async () => {
    const error = await new PdfJsLoader().load("tests/fixtures/nope.pdf").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RagError);
    expect((error as RagError).code).toBe("INGESTION_FAILED");
    expect((error as RagError).message).toContain("nope.pdf");
  });

  it("rejects a file that is not a PDF with INGESTION_FAILED and keeps the cause", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rag-pdf-"));
    try {
      const file = path.join(dir, "fake.pdf");
      await writeFile(file, "this is not a pdf");
      const error = await new PdfJsLoader().load(file).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RagError);
      expect((error as RagError).code).toBe("INGESTION_FAILED");
      expect((error as RagError).cause).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
