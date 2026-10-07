import { describe, expect, it } from "vitest";
import type { ChunkId, Chunk, Chunker, DocId, ParsedDocument } from "../../core/index.js";
import { makeChunkId } from "../../core/index.js";
import {
  checkChunker,
  chunkerFixtures,
  describeChunkerContract,
  formatViolations,
  runChunkerChecks,
} from "../../testing/chunker-contract.testing.js";
import type { ViolationCode } from "../../testing/chunker-contract.testing.js";
import { createChunk } from "./chunk-builder.js";

// ---------------------------------------------------------------------------------------------
// Two small reference chunkers. They exist only to show that the contract accepts a correct
// chunker (and to give the broken ones below something to be broken from). They are not strategies
// the project uses; the real ones are RAG-022 onwards.
// ---------------------------------------------------------------------------------------------

/** One chunk per paragraph (text between blank lines), with whitespace collapsed in the text. */
class ParagraphChunker implements Chunker {
  readonly name = "reference-paragraph";

  chunk(doc: ParsedDocument): Promise<readonly Chunk[]> {
    const chunks: Chunk[] = [];
    let offset = 0;
    // splitting on a capturing group keeps the blank lines, so the offsets stay exact
    for (const part of doc.text.split(/(\n[ \t]*\n)/)) {
      const trimmed = part.trim();
      if (trimmed !== "" && !/^\n[ \t]*\n$/.test(part)) {
        const start = offset + (part.length - part.trimStart().length);
        const text = trimmed.replace(/\s+/g, " ");
        chunks.push(createChunk(doc, this.name, { start, end: start + trimmed.length }, text));
      }
      offset += part.length;
    }
    return Promise.resolve(chunks);
  }
}

/** Fixed windows of characters that overlap, so chunks start and end anywhere and cross pages. */
class WindowChunker implements Chunker {
  readonly name = "reference-window";

  chunk(doc: ParsedDocument): Promise<readonly Chunk[]> {
    const size = 160;
    const step = 120;
    const chunks: Chunk[] = [];
    for (let start = 0; start < doc.text.length; start += step) {
      const end = Math.min(start + size, doc.text.length);
      if (doc.text.slice(start, end).trim() !== "") {
        chunks.push(createChunk(doc, this.name, { start, end }));
      }
      if (end === doc.text.length) break;
    }
    return Promise.resolve(chunks);
  }
}

// The contract, run on both. This is exactly what a real chunker's test file will do.
describeChunkerContract("reference paragraph chunker", () => new ParagraphChunker());
describeChunkerContract("reference window chunker (overlapping chunks)", () => new WindowChunker());

// ---------------------------------------------------------------------------------------------
// The contract must also catch what it is meant to catch
// ---------------------------------------------------------------------------------------------

const docNamed = (name: string): ParsedDocument => {
  const found = chunkerFixtures().find((f) => f.name === name);
  if (found === undefined) throw new Error(`no fixture named "${name}"`);
  return found.doc;
};

const SECTIONS_DOC = docNamed("sections and subsections over two pages");

/** A chunker that gives the good chunker's output after `mutate` has damaged it. */
const brokenFrom = (
  good: Chunker,
  mutate: (chunks: readonly Chunk[], doc: ParsedDocument) => readonly Chunk[],
): Chunker => ({
  name: good.name,
  chunk: async (doc) => mutate(await good.chunk(doc), doc),
});

const withMetadata = (chunk: Chunk, changes: Partial<Chunk["metadata"]>): Chunk => ({
  ...chunk,
  metadata: { ...chunk.metadata, ...changes },
});

const codesOf = async (chunker: Chunker, doc: ParsedDocument): Promise<ViolationCode[]> =>
  (await runChunkerChecks(chunker, doc)).map((violation) => violation.code);

describe("the contract catches broken chunkers", () => {
  const good = new ParagraphChunker();

  it("starts from a document that gives several paragraphs, or the cases below prove nothing", async () => {
    expect((await good.chunk(SECTIONS_DOC)).length).toBeGreaterThanOrEqual(6);
  });

  const cases: readonly [
    ViolationCode,
    string,
    (chunks: readonly Chunk[], doc: ParsedDocument) => readonly Chunk[],
  ][] = [
    [
      "text-differs-from-source",
      "adds words to a chunk's text",
      (c) => c.map((x, i) => (i === 1 ? { ...x, text: `${x.text} and some extra words` } : x)),
    ],
    [
      "span-out-of-range",
      "has a span that ends past the document",
      (c, doc) =>
        c.map((x, i) => (i === 0 ? withMetadata(x, { charEnd: doc.text.length + 5 }) : x)),
    ],
    ["out-of-order", "returns the chunks in reverse", (c) => [...c].reverse()],
    ["gap", "leaves out a paragraph in the middle", (c) => c.filter((_, i) => i !== 2)],
    ["uncovered-edge", "leaves out the last paragraph", (c) => c.slice(0, -1)],
    [
      "wrong-doc-id",
      "gives the wrong document id",
      (c) => c.map((x) => withMetadata(x, { docId: "other" as DocId })),
    ],
    [
      "wrong-strategy",
      "writes another strategy name",
      (c) => c.map((x) => withMetadata(x, { strategy: "something-else" })),
    ],
    [
      "wrong-pages",
      "puts a chunk on the wrong page",
      (c) =>
        c.map((x, i) =>
          i === 0
            ? withMetadata(x, {
                pageStart: x.metadata.pageStart + 1,
                pageEnd: x.metadata.pageEnd + 1,
              })
            : x,
        ),
    ],
    [
      "wrong-section-path",
      "gives an empty section path",
      (c) => c.map((x) => withMetadata(x, { sectionPath: [] })),
    ],
    [
      "wrong-id",
      "gives every chunk a made-up id",
      (c) => c.map((x, i) => ({ ...x, id: `made-up-${i.toString()}` as ChunkId })),
    ],
    [
      "duplicate-id",
      "gives two chunks the same id",
      (c) => c.map((x, i) => (i === 1 ? { ...x, id: c[0]?.id ?? x.id } : x)),
    ],
  ];

  it.each(cases)("%s: a chunker that %s", async (code, _description, mutate) => {
    const violations = await codesOf(brokenFrom(good, mutate), SECTIONS_DOC);
    expect(violations).toContain(code);
  });

  it("not-deterministic: a chunker whose second run differs from its first", async () => {
    let calls = 0;
    const flaky: Chunker = {
      name: good.name,
      chunk: async (doc) => {
        calls += 1;
        const chunks = await good.chunk(doc);
        return calls % 2 === 0 ? chunks.slice(1) : chunks;
      },
    };
    expect(await codesOf(flaky, SECTIONS_DOC)).toContain("not-deterministic");
  });

  it("mutated-document: a chunker that changes the document it is given", async () => {
    const vandal: Chunker = {
      name: good.name,
      chunk: (doc) => {
        (doc as { text: string }).text += " ";
        return good.chunk(doc);
      },
    };
    expect(await codesOf(vandal, docNamed("one short line"))).toContain("mutated-document");
  });

  it("nonempty-for-empty: a chunker that returns a chunk for a document with no text", async () => {
    const empty = docNamed("an empty document");
    const eager: Chunker = {
      name: good.name,
      chunk: (doc) =>
        Promise.resolve([
          {
            id: makeChunkId({
              docId: doc.id,
              strategy: good.name,
              charStart: 0,
              charEnd: 1,
              text: "x",
            }),
            text: "x",
            metadata: {
              docId: doc.id,
              pageStart: 1,
              pageEnd: 1,
              sectionPath: [],
              charStart: 0,
              charEnd: 1,
              strategy: good.name,
            },
          },
        ]),
    };
    expect(await codesOf(eager, empty)).toContain("nonempty-for-empty");
  });

  it("reports every problem, not just the first", async () => {
    const wrecked = brokenFrom(good, (c) =>
      [...c].reverse().map((x) => ({ ...x, id: "same" as ChunkId })),
    );
    const codes = await codesOf(wrecked, SECTIONS_DOC);
    expect(codes).toEqual(expect.arrayContaining(["out-of-order", "wrong-id", "duplicate-id"]));
  });
});

// ---------------------------------------------------------------------------------------------
// What the contract must allow
// ---------------------------------------------------------------------------------------------

describe("the contract allows what it should", () => {
  const doc = SECTIONS_DOC;

  it("allows chunks that overlap", async () => {
    expect(await runChunkerChecks(new WindowChunker(), doc)).toEqual([]);
  });

  it("allows a text with whitespace collapsed or trimmed (the paragraph chunker does both)", async () => {
    const chunks = await new ParagraphChunker().chunk(doc);
    expect(
      chunks.some((c) => c.text !== doc.text.slice(c.metadata.charStart, c.metadata.charEnd)),
    ).toBe(true);
    expect(checkChunker(doc, chunks, "reference-paragraph")).toEqual([]);
  });

  it("allows whitespace between two chunks, but not other text", () => {
    const text = makeTwoWordDoc();
    const a = createChunk(text, "x", { start: 0, end: 3 });
    const b = createChunk(text, "x", { start: 8, end: 11 });
    expect(checkChunker(text, [a, b], "x")).toEqual([]); // "abc" then "def": only spaces between

    const wide = makeTwoWordDoc("abc   MID   def");
    const left = createChunk(wide, "x", { start: 0, end: 3 });
    const right = createChunk(wide, "x", { start: 12, end: 15 });
    expect(checkChunker(wide, [left, right], "x").map((v) => v.code)).toContain("gap");
  });

  it("gives no chunks for a document with no text, and asks for none", () => {
    expect(checkChunker(docNamed("an empty document"), [], "x")).toEqual([]);
    expect(checkChunker(docNamed("a document with only whitespace"), [], "x")).toEqual([]);
  });

  it("asks for chunks when there is text", () => {
    expect(checkChunker(docNamed("one short line"), [], "x").map((v) => v.code)).toEqual([
      "uncovered-edge",
    ]);
  });
});

describe("formatViolations", () => {
  it("writes one readable line per violation", () => {
    expect(
      formatViolations([
        { code: "gap", message: "text is missing", chunk: 2 },
        { code: "nonempty-for-empty", message: "too many" },
      ]),
    ).toBe("gap (chunk 2): text is missing\nnonempty-for-empty: too many");
  });
});

/** A document whose text is exactly `text` on one page. */
function makeTwoWordDoc(text = "abc     def"): ParsedDocument {
  const base = docNamed("one short line");
  return {
    ...base,
    text,
    pages: [{ number: 1, text, span: { start: 0, end: text.length }, items: [] }],
    sections: [],
  };
}
