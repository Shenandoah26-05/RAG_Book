import { describe, expect, it } from "vitest";
import {
  highlightRequestSchema,
  highlightResponseSchema,
  MAX_HIGHLIGHT_CHARS,
} from "./highlights.js";
import {
  askFilterSchema,
  bookRequestSchema,
  bookResponseSchema,
  askRequestSchema,
  chunkRequestSchema,
  chunkResponseSchema,
  errorResponseSchema,
  feedbackRequestSchema,
  MAX_FEEDBACK_NOTE_CHARS,
  MAX_HISTORY_TURNS,
  MAX_K,
  MAX_SELECTION_CHARS,
  MAX_QUESTION_CHARS,
  pageRequestSchema,
  pageResponseSchema,
  wireCandidateSchema,
  wireInspectionSchema,
  selectionSchema,
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

  it("takes inspect, and leaves it out of a request that does not set it", () => {
    expect(askRequestSchema.parse({ question: "q?", inspect: true }).inspect).toBe(true);
    expect(askRequestSchema.parse({ question: "q?" })).not.toHaveProperty("inspect");
  });

  it.each([
    [{}, "question"],
    [{ question: "q?", inspect: "yes" }, "inspect"],
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

describe("the selected passage of a question", () => {
  it("takes the words and the page, and trims the words", () => {
    expect(selectionSchema.parse({ text: "  a passage \n", page: 4 })).toEqual({
      text: "a passage",
      page: 4,
    });
    expect(selectionSchema.parse({ text: "a passage" })).toEqual({ text: "a passage" });
  });

  it("is optional in a question", () => {
    expect(askRequestSchema.parse({ question: "q?" })).toEqual({ question: "q?" });
    expect(
      askRequestSchema.parse({ question: "q?", selection: { text: "the passage", page: 2 } }),
    ).toEqual({ question: "q?", selection: { text: "the passage", page: 2 } });
  });

  it.each([
    [{ text: "" }],
    [{ text: "   " }],
    [{ text: "x".repeat(MAX_SELECTION_CHARS + 1) }],
    [{ text: "ok", page: 0 }],
    [{ text: "ok", page: 1.5 }],
    [{ text: "ok", unknown: true }],
    [{}],
  ])("rejects %j", (selection) => {
    expect(selectionSchema.safeParse(selection).success).toBe(false);
  });

  it("accepts exactly the longest allowed passage", () => {
    expect(selectionSchema.safeParse({ text: "x".repeat(MAX_SELECTION_CHARS) }).success).toBe(true);
  });
});

describe("highlights", () => {
  it("reads a passage from the query: whole numbers, in order, not too long", () => {
    expect(highlightRequestSchema.parse({ from: "5", to: "15" })).toEqual({ from: 5, to: 15 });
    for (const bad of [
      { from: "5" },
      { from: "a", to: "9" },
      { from: "9", to: "3" },
      { from: "4", to: "4" },
      { from: "0", to: String(MAX_HIGHLIGHT_CHARS + 1) },
      { from: "-1", to: "4" },
    ]) {
      expect(highlightRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(
      highlightRequestSchema.safeParse({ from: "0", to: String(MAX_HIGHLIGHT_CHARS) }).success,
    ).toBe(true);
  });

  it("checks boxes: a positive width and height", () => {
    const docId = "a1b2c3d4-e5f6-5a7b-8c9d-0e1f2a3b4c5d";
    const page = (box: object) => ({ docId, pages: [{ number: 1, boxes: [box] }] });
    expect(
      highlightResponseSchema.safeParse(page({ x: 1, y: 2, width: 3, height: 4 })).success,
    ).toBe(true);
    expect(
      highlightResponseSchema.safeParse(page({ x: 1, y: 2, width: 0, height: 4 })).success,
    ).toBe(false);
  });
});

describe("feedbackRequestSchema", () => {
  const ANSWER = "3f2b8a1e-7c4d-4e9a-b5d6-1a2c3e4f5a6b";
  const base = {
    answerId: ANSWER,
    rating: "down",
    question: "What is a vector?",
    answer: "",
    citations: [],
  };

  it("takes a rating of an answer with nothing else", () => {
    expect(feedbackRequestSchema.parse(base)).toEqual(base);
  });

  it("trims the note and the question", () => {
    expect(
      feedbackRequestSchema.parse({ ...base, note: "  wrong page ", question: " Why? " }),
    ).toMatchObject({ note: "wrong page", question: "Why?" });
  });

  it.each([
    ["a document id as the answer id", { answerId: DOC }],
    ["a rating that is not up or down", { rating: "sideways" }],
    ["more sources than an answer can have", { citations: Array(51).fill({}) }],
    ["a note over the limit", { note: "x".repeat(MAX_FEEDBACK_NOTE_CHARS + 1) }],
    ["an unknown field", { extra: 1 }],
  ])("refuses %s", (_name, change) => {
    expect(feedbackRequestSchema.safeParse({ ...base, ...change }).success).toBe(false);
describe("the inspection (RAG-105)", () => {
  const candidate = {
    chunkId: CHUNK,
    pageStart: 3,
    pageEnd: 4,
    sectionPath: ["Embeddings", "Similarity"],
    snippet: "Cosine similarity compares direction.",
    rank: 2,
    score: 0.031,
    retriever: "hybrid",
    foundBy: [{ retriever: "dense", rank: 1, score: 0.9 }],
    finalRank: 1,
    finalScore: 7.5,
    fate: "used",
    source: 1,
  };
  const prompt = {
    version: "rag-system@v2",
    system: "SYSTEM",
    user: "What is similarity?",
    sourceTokens: 80,
    budget: 100,
    sent: true,
  };

  it("takes a candidate, and one the reranker dropped", () => {
    expect(wireCandidateSchema.safeParse(candidate).success).toBe(true);
    const cut = { ...candidate, finalRank: null, finalScore: null, fate: "cut" };
    expect(wireCandidateSchema.safeParse({ ...cut, source: undefined }).success).toBe(true);
  });

  it.each([
    ["an unknown fate", { fate: "lost" }],
    ["a rank of 0", { rank: 0 }],
    ["a bad chunk id", { chunkId: "nope" }],
    ["a foundBy with no rank", { foundBy: [{ retriever: "dense", score: 1 }] }],
    ["a field it does not know", { extra: 1 }],
  ])("rejects %s", (_name, change) => {
    expect(wireCandidateSchema.safeParse({ ...candidate, ...change }).success).toBe(false);
  });

  it("takes an inspection with no candidates, as when nothing was found", () => {
    expect(wireInspectionSchema.safeParse({ candidates: [], prompt }).success).toBe(true);
  });

  it("rejects a prompt that does not say whether it was sent", () => {
    const unsent: Partial<typeof prompt> = { ...prompt };
    delete unsent.sent;
    expect(wireInspectionSchema.safeParse({ candidates: [], prompt: unsent }).success).toBe(false);
  });
});
