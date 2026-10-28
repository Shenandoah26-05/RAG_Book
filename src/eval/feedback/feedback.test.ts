import { describe, expect, it } from "vitest";
import { RagError } from "../../shared/index.js";
import { makeDocId } from "../../shared/index.js";
import { makeDocument } from "../../testing/make-document.testing.js";
import { checkDatasetAgainstDocument } from "../dataset/validate-dataset.js";
import type { DatasetMeta, Question } from "../dataset/schema.js";
import { latestPerAnswer, parseCandidates } from "./candidates.js";
import type { Candidate } from "./candidates.js";
import { promoteCandidates, REFUSAL_REFERENCE } from "./promote.js";

const doc = makeDocument([
  "Chapter 1\nBereavement fare refunds must be\nrequested before travel.",
  "Refund requests are processed within 30 business days.\nRefund requests are processed within 30 business days.",
  "Pets travel in the cabin.",
]);
const meta: DatasetMeta = {
  version: "t",
  source: { title: doc.title, sha256: doc.sha256, pageCount: doc.pageCount },
};
const BOOK = makeDocId(doc.sha256);
const OTHER = makeDocId("f".repeat(64));

const base: Question[] = [
  {
    id: "q007",
    question: "Where do pets travel on the plane?",
    kind: "factual",
    answer: "In the cabin.",
    gold: [{ page: 3, quote: "Pets travel in the cabin." }],
  },
];

const pets: Question = base[0] ?? {
  id: "q000",
  question: "",
  kind: "factual",
  answer: "",
  gold: [],
};

const citation = (index: number, extra: Partial<Candidate["citations"][number]> = {}) => ({
  index,
  chunkId: "c".repeat(64),
  docId: BOOK,
  pageStart: 1,
  pageEnd: 1,
  charStart: 0,
  charEnd: 10,
  quote: "Bereavement fare refunds must be requested before travel.",
  ...extra,
});

let counter = 0;
const rated = (extra: Partial<Candidate> = {}): Candidate => ({
  answerId: `answer-${(counter++).toString()}`,
  savedAt: "2026-10-28T10:00:00.000Z",
  rating: "up",
  question: `When must a refund be requested ${counter.toString()}?`,
  answer: "Before travel [1].",
  docId: BOOK,
  citations: [citation(1)],
  system: { index: "recursive__ollama", model: "ollama:llama3.2" },
  ...extra,
});

const promote = (
  candidates: Candidate[],
  over: Partial<Parameters<typeof promoteCandidates>[0]> = {},
) => promoteCandidates({ base, meta, doc, candidates, ...over });

describe("parseCandidates", () => {
  const good = rated();

  it("reads one candidate per line, and ignores blank lines and extra fields", () => {
    const text = `${JSON.stringify(good)}\n\n${JSON.stringify({ ...good, answerId: "b", future: 1 })}\n`;
    const { candidates, malformed } = parseCandidates(text);
    expect(candidates.map((c) => c.answerId)).toEqual([good.answerId, "b"]);
    expect(malformed).toEqual([]);
  });

  it("reports a line that is not usable and keeps the others", () => {
    const text = [
      JSON.stringify(good),
      '{"answerId": "half written',
      JSON.stringify({ ...good, rating: "meh" }),
      JSON.stringify({ ...good, answerId: "z" }),
    ].join("\n");
    const { candidates, malformed } = parseCandidates(text);
    expect(candidates).toHaveLength(2);
    expect(malformed.map((m) => m.line)).toEqual([2, 3]);
    expect(malformed[0]?.message).toBe("not valid JSON");
    expect(malformed[1]?.message).toContain("rating");
  });
});

describe("latestPerAnswer", () => {
  it("keeps the last entry of an answer rated more than once, at the place of its last rating", () => {
    const a1 = rated({ answerId: "a", rating: "up" });
    const b = rated({ answerId: "b" });
    const a2 = rated({ answerId: "a", rating: "down", note: "changed my mind" });
    expect(latestPerAnswer([a1, b, a2])).toEqual([b, a2]);
  });
});

describe("promoteCandidates", () => {
  it("promotes an answer rated up: the cited passage becomes the gold, and the next id is used", () => {
    const { added, questions, review, skipped } = promote([rated()]);
    expect(added).toEqual([
      {
        id: "q008",
        question: expect.stringContaining("When must a refund be requested") as string,
        kind: "factual",
        answer: "Before travel.",
        gold: [{ page: 1, quote: "Bereavement fare refunds must be requested before travel." }],
      },
    ]);
    expect(questions).toEqual([...base, ...added]);
    expect(review).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("makes a multi-part question of an answer whose sources are on different pages", () => {
    const { added } = promote([
      rated({
        answer: "Before travel [1], and within 30 days [2].",
        citations: [
          citation(1),
          citation(2, { pageStart: 3, pageEnd: 3, quote: "Pets travel in the cabin." }),
        ],
      }),
    ]);
    expect(added[0]?.kind).toBe("multi-part");
    expect(added[0]?.gold.map((g) => g.page)).toEqual([1, 3]);
  });

  it("uses only the sources the answer cites", () => {
    const { added } = promote([
      rated({
        answer: "Pets travel in the cabin [2].",
        citations: [
          citation(1),
          citation(2, { pageStart: 3, pageEnd: 3, quote: "Pets travel in the cabin." }),
        ],
      }),
    ]);
    expect(added[0]?.gold).toEqual([{ page: 3, quote: "Pets travel in the cabin." }]);
  });

  it("keeps a declined question rated up as an unanswerable one", () => {
    const { added } = promote([
      rated({
        question: "Who wrote the cabin rules?",
        answer: "",
        refusal: "nothing good enough",
        citations: [],
      }),
    ]);
    expect(added).toEqual([
      {
        id: "q008",
        question: "Who wrote the cabin rules?",
        kind: "unanswerable",
        answer: REFUSAL_REFERENCE,
        gold: [],
      },
    ]);
  });

  it("sends an answer rated down to review, with the note and what it cited, and does not label it", () => {
    const down = rated({ rating: "down", note: "wrong deadline" });
    const { added, review } = promote([down]);
    expect(added).toEqual([]);
    expect(review).toEqual([
      {
        answerId: down.answerId,
        question: down.question,
        rating: "down",
        note: "wrong deadline",
        given: "Before travel [1].",
        sources: [{ page: "1", quote: expect.stringContaining("Bereavement") as string }],
        reason: expect.stringContaining("rated down") as string,
      },
    ]);
  });

  it("goes by the last rating of an answer", () => {
    const first = rated({ answerId: "same", rating: "down" });
    const last = rated({ answerId: "same", rating: "up", question: first.question });
    const { added, review } = promote([first, last]);
    expect(added).toHaveLength(1);
    expect(review).toEqual([]);
  });

  it.each([
    ["another book", { docId: OTHER, citations: [citation(1, { docId: OTHER })] }, "another book"],
    ["a question that does not say its book", { docId: undefined, citations: [] }, "which book"],
    ["an answer that cites nothing", { answer: "Before travel." }, "cites no source"],
    [
      "an answer citing a source it was not given",
      { answer: "Before travel [4]." },
      "cites no source",
    ],
    ["no answer at all", { answer: " [1] " }, "no answer"],
    ["a question too short to be one", { question: "Why?" }, "not usable"],
  ])("skips %s, and says why", (_name, change, reason) => {
    const { added, skipped, review } = promote([rated(change)]);
    expect(added).toEqual([]);
    expect(review).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toContain(reason);
  });

  it("skips a question the dataset already has, however it is written, and a repeat among the candidates", () => {
    const { added, skipped } = promote([
      rated({ question: "  where do PETS travel on the plane  " }),
      rated({ question: "How fast are refunds paid?" }),
      rated({ question: "how fast are refunds paid ?" }),
    ]);
    expect(added.map((q) => q.question)).toEqual(["How fast are refunds paid?"]);
    expect(skipped.map((s) => s.reason)).toEqual([
      "the question is already in the dataset",
      "the question is already in the dataset",
    ]);
  });

  it.each([
    ["on two pages", { pageStart: 1, pageEnd: 2 }],
    ["not on its page", { quote: "Dogs ride in the hold, never in the cabin." }],
    [
      "more than once on its page",
      { pageStart: 2, pageEnd: 2, quote: "Refund requests are processed within 30 business days." },
    ],
    ["too short to label with", { quote: "Pets" }],
  ])("sends a good answer to review when its only source is %s", (_name, change) => {
    const { added, review } = promote([rated({ citations: [citation(1, change)] })]);
    expect(added).toEqual([]);
    expect(review).toHaveLength(1);
    expect(review[0]?.reason).toContain("no cited passage");
  });

  it("labels with the sources that can be found and leaves out the ones that cannot", () => {
    const { added } = promote([
      rated({
        answer: "Before travel [1]; pets travel in the cabin [2].",
        citations: [
          citation(1, { quote: "Not on the page at all." }),
          citation(2, { pageStart: 3, pageEnd: 3, quote: "Pets travel in the cabin." }),
        ],
      }),
    ]);
    expect(added[0]?.gold).toEqual([{ page: 3, quote: "Pets travel in the cabin." }]);
  });

  it("never reuses an id, and numbers from the highest in the base", () => {
    const { added } = promote(
      [rated({ question: "First new question?" }), rated({ question: "Second new question?" })],
      {
        base: [
          { ...pets, id: "q003" },
          { ...pets, id: "q041", question: "Another one entirely?" },
        ],
      },
    );
    expect(added.map((q) => q.id)).toEqual(["q042", "q043"]);
  });

  it("stops when the ids run out", () => {
    const full: Question = { ...pets, id: "q999" };
    expect(() => promote([rated()], { base: [full] })).toThrow(RagError);
  });

  it("does not change the base", () => {
    const before = JSON.stringify(base);
    promote([rated()]);
    expect(JSON.stringify(base)).toBe(before);
  });

  it("gives a dataset whose gold quotes all pass the dataset's own check against the book", () => {
    const { questions } = promote([
      rated(),
      rated({
        question: "Where do pets sit?",
        answer: "In the cabin [1].",
        citations: [citation(1, { pageStart: 3, pageEnd: 3, quote: "Pets travel in the cabin." })],
      }),
      rated({ rating: "down" }),
    ]);
    expect(checkDatasetAgainstDocument(questions, meta, doc)).toEqual([]);
  });
});
