import { describe, expect, it } from "vitest";
import {
  askFilterSchema,
  bookRequestSchema,
  bookResponseSchema,
  askRequestSchema,
  chunkRequestSchema,
  chunkResponseSchema,
  errorResponseSchema,
  MAX_HISTORY_TURNS,
  MAX_K,
  MAX_QUESTION_CHARS,
  pageRequestSchema,
  pageResponseSchema,
  wireTraceSchema,
} from "./schemas.js";

const DOC = "3f2b8a1e-7c4d-5e9a-b5d6-1a2c3e4f5a6b";
const CHUNK = "ab".repeat(32);

describe("askRequestSchema", () => {
  it("takes a question alone", () => {
    expect(askRequestSchema.parse({ question: "What is a vector?" })).toEqual({
      question: "What is a vector?",
    });
  });

  it("trims the question", () => {
    expect(askRequestSchema.parse({ question: "  Why?  " }).question).toBe("Why?");
  });

  it("takes k, the history and a filter", () => {
    const request = {
      question: "And chapter 4?",
      k: 8,
      history: [{ question: "What is chunking?", answer: "Splitting a book." }],
      filter: { pages: { from: 4, to: 9 }, section: ["Chapter 4"] },
    };
    expect(askRequestSchema.parse(request)).toEqual(request);
  });

  it.each([
    [{}, "question"],
    [{ question: "   " }, "question"],
    [{ question: "x".repeat(MAX_QUESTION_CHARS + 1) }, "question"],
    [{ question: 5 }, "question"],
    [{ question: "q?", k: 0 }, "k"],
    [{ question: "q?", k: MAX_K + 1 }, "k"],
    [{ question: "q?", k: 1.5 }, "k"],
    [
      {
        question: "q?",
        history: Array.from({ length: MAX_HISTORY_TURNS + 1 }, () => ({
          question: "a",
          answer: "b",
        })),
      },
      "history",
    ],
    [{ question: "q?", history: [{ question: "a" }] }, "history"],
    [{ question: "q?", unknown: true }, "unknown"],
  ])("rejects %j", (input, where) => {
    const result = askRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(where);
  });
});

describe("askFilterSchema", () => {
  it("takes any combination of the parts", () => {
    expect(askFilterSchema.parse({})).toEqual({});
    expect(askFilterSchema.parse({ documents: [DOC], strategies: ["recursive"] })).toBeDefined();
  });

  it.each([
    [{ pages: {} }, "from"],
    [{ pages: { from: 9, to: 4 } }, "must not be after"],
    [{ pages: { from: 0 } }, "pages"],
    [{ pages: { from: 1.5 } }, "pages"],
    [{ section: [] }, "section"],
    [{ section: ["  "] }, "section"],
    [{ documents: [] }, "documents"],
    [{ documents: ["not-an-id"] }, "documents"],
    [{ chapter: "3" }, "chapter"],
  ])("rejects %j", (input, text) => {
    const result = askFilterSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(text);
  });
});

describe("path parameters", () => {
  it("reads a page number from the text of the path", () => {
    expect(pageRequestSchema.parse({ n: "12" })).toEqual({ n: 12 });
    expect(pageRequestSchema.parse({ n: "3", doc: DOC })).toEqual({ n: 3, doc: DOC });
  });

  it.each(["0", "-1", "1.5", "abc", "", "1e3x"])("rejects the page %j", (n) => {
    expect(pageRequestSchema.safeParse({ n }).success).toBe(false);
  });

  it("rejects a document that is not an id", () => {
    expect(pageRequestSchema.safeParse({ n: "1", doc: "../../etc" }).success).toBe(false);
  });

  it("takes a chunk id of 64 hex characters and nothing else", () => {
    expect(chunkRequestSchema.safeParse({ id: CHUNK }).success).toBe(true);
    for (const id of ["abc", CHUNK.toUpperCase(), `${CHUNK}0`, "../x", "g".repeat(64)]) {
      expect(chunkRequestSchema.safeParse({ id }).success, id).toBe(false);
    }
  });
});

describe("responses", () => {
  it("accepts the shape of a page", () => {
    expect(
      pageResponseSchema.safeParse({
        docId: DOC,
        title: "Book",
        number: 2,
        pageCount: 25,
        text: "Text.",
        span: { start: 10, end: 15 },
      }).success,
    ).toBe(true);
  });

  it("accepts a chunk with and without a parent", () => {
    const chunk = {
      id: CHUNK,
      docId: DOC,
      text: "t",
      pageStart: 1,
      pageEnd: 2,
      sectionPath: ["Chapter 1"],
      charStart: 0,
      charEnd: 1,
      strategy: "recursive",
    };
    expect(chunkResponseSchema.safeParse(chunk).success).toBe(true);
    expect(chunkResponseSchema.safeParse({ ...chunk, parentId: "cd".repeat(32) }).success).toBe(
      true,
    );
  });

  it("accepts a trace with and without usage, and rejects stray fields", () => {
    const stage = {
      stage: "retrieve",
      startMs: 0,
      durationMs: 4,
      status: "ok",
      summary: { found: 5, note: null },
    };
    expect(wireTraceSchema.safeParse({ totalMs: 4, stages: [stage] }).success).toBe(true);
    expect(
      wireTraceSchema.safeParse({
        totalMs: 4,
        stages: [stage],
        usage: { calls: 1, promptTokens: 2, outputTokens: 3, embeddedTokens: 0, modelMs: 5 },
      }).success,
    ).toBe(true);
    expect(wireTraceSchema.safeParse({ totalMs: 4, stages: [stage], secret: 1 }).success).toBe(
      false,
    );
  });

  it("accepts an error body, with and without issues, and knows only the contract's codes", () => {
    expect(
      errorResponseSchema.safeParse({
        error: {
          code: "INVALID_REQUEST",
          message: "bad",
          issues: [{ path: "k", message: "too big" }],
        },
      }).success,
    ).toBe(true);
    expect(errorResponseSchema.safeParse({ error: { code: "TEAPOT", message: "x" } }).success).toBe(
      false,
    );
  });
});

describe("the book, for the reader", () => {
  const entry = (title: string, children: unknown[] = []) => ({
    title,
    level: 1,
    pageStart: 1,
    pageEnd: 2,
    children,
  });
  const book = {
    docId: "a1b2c3d4-e5f6-5a7b-8c9d-0e1f2a3b4c5d",
    title: "Vectors",
    pageCount: 3,
    pdf: true,
    outline: [entry("One", [{ ...entry("One.A"), level: 2 }]), entry("Two")],
  };

  it("accepts a book with a nested outline, and an empty one", () => {
    expect(bookResponseSchema.safeParse(book).success).toBe(true);
    expect(bookResponseSchema.safeParse({ ...book, outline: [] }).success).toBe(true);
  });

  it("checks the nested entries too", () => {
    const bad = { ...book, outline: [entry("One", [{ ...entry("bad"), pageStart: 0 }])] };
    expect(bookResponseSchema.safeParse(bad).success).toBe(false);
  });

  it("refuses unknown fields and a missing pdf flag", () => {
    expect(bookResponseSchema.safeParse({ ...book, extra: 1 }).success).toBe(false);
    const withoutPdf = Object.fromEntries(Object.entries(book).filter(([key]) => key !== "pdf"));
    expect(bookResponseSchema.safeParse(withoutPdf).success).toBe(false);
  });

  it("takes an optional document id for the request", () => {
    expect(bookRequestSchema.safeParse({}).success).toBe(true);
    expect(bookRequestSchema.safeParse({ doc: book.docId }).success).toBe(true);
    expect(bookRequestSchema.safeParse({ doc: "nope" }).success).toBe(false);
  });
});
