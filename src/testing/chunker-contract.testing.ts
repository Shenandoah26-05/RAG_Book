// The contract every Chunker must meet (see core/ports/chunker.ts and ADR-0003). Used by each
// chunker's own test through `describeChunkerContract`. Not part of the build.
//
// The checks are plain functions that return the violations they find, as data. That is what makes
// the contract itself testable: strategies/chunking/chunker-contract.test.ts feeds them deliberately
// broken chunkers and confirms that each break is caught.
//
// The checks are written independently of `createChunk`. If they used it, a bug in `createChunk`
// would be "confirmed" by checking it against itself.
import { describe, expect, it } from "vitest";
import type { Chunk, Chunker, ParsedDocument, Section } from "../core/index.js";
import { makeChunkId } from "../core/index.js";
import { makeDocument } from "./make-document.testing.js";

// ---------------------------------------------------------------------------------------------
// Violations
// ---------------------------------------------------------------------------------------------

export type ViolationCode =
  | "span-out-of-range" // the span is not inside the document
  | "text-differs-from-source" // text differs from its passage by more than whitespace
  | "out-of-order" // chunks are not in document order
  | "gap" // text that is not whitespace falls between two chunks
  | "uncovered-edge" // text that is not whitespace falls before the first or after the last chunk
  | "wrong-doc-id"
  | "wrong-strategy"
  | "wrong-pages"
  | "wrong-section-path"
  | "wrong-id"
  | "duplicate-id"
  | "not-deterministic" // two runs on the same document gave different chunks
  | "mutated-document" // the chunker changed the document it was given
  | "nonempty-for-empty"; // chunks for a document that has no text

export interface Violation {
  readonly code: ViolationCode;
  readonly message: string;
  /** Index of the offending chunk, when the violation is about one chunk. */
  readonly chunk?: number;
}

/** One line per violation, for a test failure message. */
export function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map(
      (v) =>
        `${v.code}${v.chunk === undefined ? "" : ` (chunk ${v.chunk.toString()})`}: ${v.message}`,
    )
    .join("\n");
}

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

const strip = (text: string): string => text.replace(/\s+/g, "");

/** Which pages a span touches, worked out here on its own, ignoring pages with no text. */
function expectedPages(doc: ParsedDocument, start: number, end: number): [number, number] {
  const pages = doc.pages.filter((page) => page.text.trim() !== "");
  let first = pages.at(-1);
  for (const page of pages) {
    if (page.span.end > start) {
      first = page;
      break;
    }
  }
  let last = pages[0];
  for (const page of pages) {
    if (page.span.start < end) last = page;
  }
  const pageStart = first?.number ?? 1;
  return [pageStart, Math.max(last?.number ?? pageStart, pageStart)];
}

/** The titles of the sections that contain a position, worked out here on its own. */
function expectedSectionPath(sections: readonly Section[], position: number): string[] {
  const path: string[] = [];
  let level = sections;
  for (;;) {
    const hit = level.find((s) => s.span.start <= position && position < s.span.end);
    if (hit === undefined) return path;
    path.push(hit.title);
    level = hit.children;
  }
}

/**
 * Checks one run of a chunker against the contract and returns every violation found. Pure: it
 * only looks at the document and the chunks. (Checks that need to run the chunker twice are in
 * `runChunkerChecks`.)
 */
export function checkChunker(
  doc: ParsedDocument,
  chunks: readonly Chunk[],
  chunkerName: string,
): Violation[] {
  const violations: Violation[] = [];
  const add = (code: ViolationCode, message: string, chunk?: number): void => {
    violations.push(chunk === undefined ? { code, message } : { code, message, chunk });
  };

  const length = doc.text.length;

  // A document with no text must give no chunks, and there is nothing else to check.
  if (strip(doc.text) === "") {
    if (chunks.length > 0) {
      add("nonempty-for-empty", `${chunks.length.toString()} chunk(s) for a document with no text`);
    }
    return violations;
  }
  if (chunks.length === 0) {
    add("uncovered-edge", "no chunks at all for a document that has text");
    return violations;
  }

  const validSpan = (chunk: Chunk): boolean => {
    const { charStart: start, charEnd: end } = chunk.metadata;
    return (
      Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= length && start < end
    );
  };

  // Each chunk on its own.
  const seen = new Set<string>();
  chunks.forEach((chunk, i) => {
    const { charStart: start, charEnd: end } = chunk.metadata;
    if (!validSpan(chunk)) {
      add(
        "span-out-of-range",
        `span [${start.toString()}, ${end.toString()}) is not inside the document`,
        i,
      );
      return; // the other checks need a valid span
    }

    if (strip(chunk.text) !== strip(doc.text.slice(start, end))) {
      add("text-differs-from-source", "text differs from its passage by more than whitespace", i);
    }
    if (chunk.metadata.docId !== doc.id) add("wrong-doc-id", `docId is ${chunk.metadata.docId}`, i);
    if (chunk.metadata.strategy !== chunkerName) {
      add("wrong-strategy", `strategy is "${chunk.metadata.strategy}", not "${chunkerName}"`, i);
    }

    const [pageStart, pageEnd] = expectedPages(doc, start, end);
    if (chunk.metadata.pageStart !== pageStart || chunk.metadata.pageEnd !== pageEnd) {
      add(
        "wrong-pages",
        `pages ${chunk.metadata.pageStart.toString()}-${chunk.metadata.pageEnd.toString()}, expected ${pageStart.toString()}-${pageEnd.toString()}`,
        i,
      );
    }

    const path = expectedSectionPath(doc.sections, start);
    if (chunk.metadata.sectionPath.join("\n") !== path.join("\n")) {
      add(
        "wrong-section-path",
        `section path [${chunk.metadata.sectionPath.join(" > ")}], expected [${path.join(" > ")}]`,
        i,
      );
    }

    const id = makeChunkId({
      docId: doc.id,
      strategy: chunkerName,
      charStart: start,
      charEnd: end,
      text: chunk.text,
    });
    if (chunk.id !== id)
      add("wrong-id", "id is not makeChunkId of the chunk's document, strategy, span and text", i);
    if (seen.has(chunk.id)) add("duplicate-id", `id ${chunk.id} appears more than once`, i);
    seen.add(chunk.id);
  });

  // Between neighbours: order, and no gaps. Overlap is fine.
  for (let i = 1; i < chunks.length; i++) {
    const previous = chunks[i - 1];
    const current = chunks[i];
    if (
      previous === undefined ||
      current === undefined ||
      !validSpan(previous) ||
      !validSpan(current)
    ) {
      continue;
    }
    const before = previous.metadata;
    const after = current.metadata;
    if (after.charStart < before.charStart || after.charEnd <= before.charEnd) {
      add(
        "out-of-order",
        `chunk ${(i - 1).toString()} ends at ${before.charEnd.toString()}, chunk ${i.toString()} ends at ${after.charEnd.toString()}`,
        i,
      );
    } else if (
      after.charStart > before.charEnd &&
      strip(doc.text.slice(before.charEnd, after.charStart)) !== ""
    ) {
      add(
        "gap",
        `text between ${before.charEnd.toString()} and ${after.charStart.toString()} is in no chunk`,
        i,
      );
    }
  }

  // The two ends of the document.
  const first = chunks[0];
  const last = chunks.at(-1);
  if (
    first !== undefined &&
    validSpan(first) &&
    strip(doc.text.slice(0, first.metadata.charStart)) !== ""
  ) {
    add(
      "uncovered-edge",
      `text before the first chunk (position ${first.metadata.charStart.toString()}) is in no chunk`,
      0,
    );
  }
  if (
    last !== undefined &&
    validSpan(last) &&
    strip(doc.text.slice(last.metadata.charEnd)) !== ""
  ) {
    add(
      "uncovered-edge",
      `text after the last chunk (position ${last.metadata.charEnd.toString()}) is in no chunk`,
      chunks.length - 1,
    );
  }

  return violations;
}

/**
 * Runs the chunker on a document, twice, and checks everything: the contract itself, that both runs
 * agree, and that the document was left alone.
 */
export async function runChunkerChecks(
  chunker: Chunker,
  doc: ParsedDocument,
): Promise<Violation[]> {
  const documentBefore = JSON.stringify(doc);
  const first = await chunker.chunk(doc);
  const second = await chunker.chunk(doc);

  const violations = checkChunker(doc, first, chunker.name);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    violations.push({
      code: "not-deterministic",
      message: "two runs on the same document gave different chunks",
    });
  }
  if (JSON.stringify(doc) !== documentBefore) {
    violations.push({
      code: "mutated-document",
      message: "the document was changed by the chunker",
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------------------------
// Fixture documents
// ---------------------------------------------------------------------------------------------

export interface ChunkerFixture {
  readonly name: string;
  readonly doc: ParsedDocument;
}

/** A section covering `[start, end)`, with the page range worked out from the document. */
function sectionOf(
  doc: ParsedDocument,
  title: string,
  level: number,
  end: number,
  children: Section[] = [],
): Section {
  const start = doc.text.indexOf(title);
  const pageOf = (position: number): number =>
    doc.pages.findLast((page) => page.span.start <= position)?.number ?? 1;
  return {
    title,
    level,
    pageStart: pageOf(start),
    pageEnd: pageOf(end - 1),
    span: { start, end },
    titleSpan: { start, end: start + title.length },
    children,
  };
}

function withSections(): ParsedDocument {
  const doc = makeDocument([
    [
      "Chapter One",
      "Alpha paragraph first line.\nStill alpha, second line.",
      "1.1 Sub",
      "Beta paragraph text here.",
      "Gamma paragraph text here.",
    ].join("\n\n"),
    [
      "Delta paragraph on page two.",
      "Chapter Two",
      "Epsilon paragraph text.",
      "Zeta paragraph last.",
    ].join("\n\n"),
  ]);
  const chapterTwo = doc.text.indexOf("Chapter Two");
  const endOfChapterOne = doc.text.slice(0, chapterTwo).trimEnd().length;
  return {
    ...doc,
    sections: [
      sectionOf(doc, "Chapter One", 1, endOfChapterOne, [
        sectionOf(doc, "1.1 Sub", 2, endOfChapterOne),
      ]),
      sectionOf(doc, "Chapter Two", 1, doc.text.length),
    ],
  };
}

/**
 * The documents every chunker is run on: the edge cases a chunker is likely to get wrong, and a
 * document with sections and several pages for the metadata checks.
 */
export function chunkerFixtures(): ChunkerFixture[] {
  const nbsp = String.fromCodePoint(0xa0);
  const paragraphs = Array.from(
    { length: 60 },
    (_, i) =>
      `Paragraph ${(i + 1).toString()} talks about topic ${(i % 7).toString()} in a few plain words.`,
  );

  return [
    { name: "an empty document", doc: makeDocument([]) },
    { name: "a document with only whitespace", doc: makeDocument(["  \n\n  \t "]) },
    { name: "one short line", doc: makeDocument(["Just one short line."]) },
    {
      name: "several pages, no sections",
      doc: makeDocument([
        "First page, first paragraph.\n\nFirst page, second paragraph.",
        "Second page, first paragraph.\n\nSecond page, second paragraph.",
        "Third page, only paragraph.",
      ]),
    },
    { name: "sections and subsections over two pages", doc: withSections() },
    {
      name: "a long document over six pages",
      doc: makeDocument(
        Array.from({ length: 6 }, (_, page) =>
          paragraphs.slice(page * 10, page * 10 + 10).join("\n\n"),
        ),
      ),
    },
    {
      name: "unicode and odd whitespace",
      doc: makeDocument([
        `Caf${String.fromCodePoint(0xe9)}\tau  lait${nbsp}noir.\n\n  Indented   paragraph with   spaces.  \n\nLast one.`,
      ]),
    },
    {
      name: "a blank page in the middle",
      doc: makeDocument(["First page text.\n\nSecond paragraph.", "", "Third page text."]),
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// For each chunker's own test file
// ---------------------------------------------------------------------------------------------

/**
 * Registers the contract tests for a chunker. Call it from the chunker's test file:
 *
 *   describeChunkerContract("fixed-size", () => new FixedSizeChunker(tokenizer, 400, 60));
 *
 * `make` is called for every test, so tests never share a chunker.
 */
export function describeChunkerContract(label: string, make: () => Chunker): void {
  describe(`Chunker contract: ${label}`, () => {
    it("has a name that can be used in config (kebab-case)", () => {
      expect(make().name).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
    });

    it.each(chunkerFixtures())("meets the contract on $name", async ({ doc }) => {
      const violations = await runChunkerChecks(make(), doc);
      expect(violations, formatViolations(violations)).toEqual([]);
    });
  });
}
