import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RagError } from "../../shared/index.js";
import { makeDocument } from "../../testing/make-document.testing.js";
import {
  checkDatasetAgainstDocument,
  checkDatasetShape,
  countByKind,
  datasetMetaSchema,
  formatDatasetViolations,
  parseDataset,
  resolveGold,
} from "./index.js";
import type { DatasetMeta, Question } from "./index.js";

const doc = makeDocument([
  "Chapter 1\nBereavement fare refunds must be\nrequested before travel.",
  "Refund requests are processed within 30 business days.\nRefund requests are processed within 30 business days.",
  "Pets travel in the cabin.",
]);
const meta: DatasetMeta = {
  version: "t",
  source: { title: doc.title, sha256: doc.sha256, pageCount: doc.pageCount },
};

const q = (id: string, extra: Partial<Question> = {}): Question => ({
  id,
  question: `Question number ${id}?`,
  kind: "factual",
  answer: "An answer.",
  gold: [{ page: 3, quote: "Pets travel in the cabin." }],
  ...extra,
});
const unanswerable = (id: string): Question =>
  q(id, { kind: "unanswerable", gold: [], answer: "Not in the book." });

/** A dataset that meets every rule of the shape check. */
const fullSet = (): Question[] => [
  ...Array.from({ length: 30 }, (_, i) => q(`q${(i + 1).toString().padStart(3, "0")}`)),
  ...Array.from({ length: 5 }, (_, i) =>
    q(`q${(i + 31).toString().padStart(3, "0")}`, { kind: "multi-part" }),
  ),
  ...Array.from({ length: 5 }, (_, i) => unanswerable(`q${(i + 36).toString().padStart(3, "0")}`)),
];
const codes = (violations: readonly { code: string }[]): string[] => violations.map((v) => v.code);

describe("parseDataset", () => {
  const line = JSON.stringify(q("q001"));

  it("reads one question per line and skips blank lines", () => {
    expect(parseDataset(`${line}\n\n${JSON.stringify(q("q002"))}\r\n`).map((x) => x.id)).toEqual([
      "q001",
      "q002",
    ]);
  });

  it("names the line of a mistake", () => {
    expect(() => parseDataset(`${line}\nnot json`)).toThrow(/line 2 is not valid JSON/);
    expect(() => parseDataset(`${line}\n{"id":"q002"}`)).toThrow(/line 2 is not a valid question/);
  });

  it("is an INVALID_ARGUMENT error", () => {
    expect(() => parseDataset("{")).toThrow(RagError);
  });

  it.each([
    ["an unanswerable question with gold", { kind: "unanswerable" }],
    ["an answerable question without gold", { gold: [] }],
    ["a bad id", { id: "7" }],
    ["a quote too short to be unique", { gold: [{ page: 1, quote: "the" }] }],
    ["an unknown field", { extra: 1 }],
  ])("rejects %s", (_what, change) => {
    expect(() => parseDataset(JSON.stringify({ ...q("q001"), ...change }))).toThrow(RagError);
  });
});

describe("resolveGold", () => {
  it("returns the character range of the quote in the document text", () => {
    const result = resolveGold(doc, { page: 3, quote: "Pets travel in the cabin." });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(doc.text.slice(result.span.start, result.span.end)).toBe("Pets travel in the cabin.");
    }
  });

  it("matches across a line break, and returns the text as it is on the page", () => {
    const result = resolveGold(doc, { page: 1, quote: "must be requested before travel" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(doc.text.slice(result.span.start, result.span.end)).toBe(
        "must be\nrequested before travel",
      );
    }
  });

  it("takes quotes as plain text, not as a pattern", () => {
    const strange = makeDocument(["Costs 5.0 (approx) [a+b]? yes"]);
    expect(resolveGold(strange, { page: 1, quote: "5.0 (approx) [a+b]? yes" }).ok).toBe(true);
    expect(resolveGold(strange, { page: 1, quote: "5x0 (approx) [a+b]? yes" }).ok).toBe(false);
  });

  it("refuses a missing page, a missing quote and a quote that appears twice", () => {
    expect(resolveGold(doc, { page: 9, quote: "Pets travel in the cabin." })).toMatchObject({
      ok: false,
      code: "page-missing",
    });
    expect(resolveGold(doc, { page: 3, quote: "Dogs travel in the cabin." })).toMatchObject({
      ok: false,
      code: "quote-not-found",
    });
    expect(
      resolveGold(doc, {
        page: 2,
        quote: "Refund requests are processed within 30 business days.",
      }),
    ).toMatchObject({ ok: false, code: "quote-ambiguous" });
  });

  it("does not look at other pages", () => {
    expect(resolveGold(doc, { page: 1, quote: "Pets travel in the cabin." }).ok).toBe(false);
  });
});

describe("checkDatasetShape", () => {
  it("accepts a dataset that meets every rule", () => {
    expect(checkDatasetShape(fullSet(), meta)).toEqual([]);
  });

  it("asks for at least 40 questions and 5 unanswerable ones", () => {
    const found = codes(checkDatasetShape(fullSet().slice(0, 38), meta));
    expect(found).toContain("too-few-questions");
    expect(found).toContain("too-few-unanswerable");
  });

  it("asks for every kind", () => {
    const noMulti = fullSet().filter((x) => x.kind !== "multi-part");
    expect(checkDatasetShape(noMulti, meta).map((v) => v.message)).toContain(
      "no multi-part question",
    );
  });

  it("finds repeated ids and repeated questions", () => {
    const set = fullSet();
    set[1] = { ...q("q001"), question: set[0]?.question ?? "" };
    expect(codes(checkDatasetShape(set, meta))).toEqual(
      expect.arrayContaining(["duplicate-id", "duplicate-question"]),
    );
  });

  it("finds a gold page beyond the end of the book", () => {
    const set = fullSet();
    set[0] = q("q001", { gold: [{ page: 4, quote: "Pets travel in the cabin." }] });
    expect(codes(checkDatasetShape(set, meta))).toEqual(["page-out-of-range"]);
  });
});

describe("checkDatasetAgainstDocument", () => {
  it("passes when every quote is on its page", () => {
    expect(checkDatasetAgainstDocument([q("q001")], meta, doc)).toEqual([]);
  });

  it("reports each bad quote with its question id", () => {
    const bad = q("q002", { gold: [{ page: 3, quote: "Dogs travel in the cabin." }] });
    const found = checkDatasetAgainstDocument([q("q001"), bad], meta, doc);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: "quote-not-found", id: "q002" });
  });

  it("notices a different book", () => {
    const other = { ...makeDocument(["Something else entirely."]), sha256: "0".repeat(64) };
    expect(codes(checkDatasetAgainstDocument([q("q001")], meta, other))).toEqual([
      "wrong-document",
    ]);
  });
});

describe("helpers", () => {
  it("countByKind counts each kind", () => {
    expect(countByKind(fullSet())).toEqual({ factual: 30, "multi-part": 5, unanswerable: 5 });
  });

  it("formatDatasetViolations writes one line each", () => {
    expect(
      formatDatasetViolations([
        { code: "duplicate-id", id: "q001", message: "id used twice" },
        { code: "too-few-questions", message: "3 questions" },
      ]),
    ).toBe("duplicate-id (q001): id used twice\ntoo-few-questions: 3 questions");
  });
});

describe("the committed dataset evals/datasets/v1.jsonl", () => {
  // The book is not in the repository, so the quotes are checked by `pnpm eval:validate`.
  // This test needs no book: it keeps the file well formed and big enough.
  const questions = parseDataset(readFileSync("evals/datasets/v1.jsonl", "utf8"));
  const v1 = datasetMetaSchema.parse(
    JSON.parse(readFileSync("evals/datasets/v1.meta.json", "utf8")),
  );

  it("is well formed and meets the RAG-080 rules", () => {
    const violations = checkDatasetShape(questions, v1);
    expect(violations, formatDatasetViolations(violations)).toEqual([]);
  });

  it("has a reference answer for every question", () => {
    expect(questions.every((x) => x.answer.trim() !== "")).toBe(true);
  });
});
