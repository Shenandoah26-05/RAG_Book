import type { AskEvent, WireCitation } from "@rag-book/api-contract";
import { MAX_TURN_CHARS } from "@rag-book/api-contract";
import { describe, expect, it } from "vitest";
import { toCssRect } from "../highlight/geometry.js";
import { inspection, inspectionEvent } from "../inspector/fixtures.js";
import type { PageView } from "../highlight/geometry.js";
import { markPassage } from "../highlight/text-range.js";
import { splitAnswer } from "./answer-text.js";
import { chatReducer, historyOf, initialChat } from "./chat-state.js";
import type { ChatAction, ChatState, ChatTurn } from "./chat-state.js";

describe("splitAnswer", () => {
  it("cuts text and citation marks, in order", () => {
    expect(splitAnswer("RAG is common [1]. It grew [2][3] fast.")).toEqual([
      { kind: "text", text: "RAG is common " },
      { kind: "cite", raw: "[1]", numbers: [1] },
      { kind: "text", text: ". It grew " },
      { kind: "cite", raw: "[2]", numbers: [2] },
      { kind: "cite", raw: "[3]", numbers: [3] },
      { kind: "text", text: " fast." },
    ]);
  });

  it("reads several numbers in one mark, with or without spaces", () => {
    expect(splitAnswer("x [1, 3] y [2,4]")).toEqual([
      { kind: "text", text: "x " },
      { kind: "cite", raw: "[1, 3]", numbers: [1, 3] },
      { kind: "text", text: " y " },
      { kind: "cite", raw: "[2,4]", numbers: [2, 4] },
    ]);
  });

  it("gives the answer back exactly when the segments are joined", () => {
    const answer = "A [1] b [2, 3]c [12]\nline [x] [] [1.5] [ 1 ] end";
    const joined = splitAnswer(answer)
      .map((s) => (s.kind === "text" ? s.text : s.raw))
      .join("");
    expect(joined).toBe(answer);
  });

  it("leaves what is not a mark as text: words in brackets, empty brackets, decimals, spaces", () => {
    for (const text of ["[x]", "[]", "[1.5]", "[ 1 ]", "[1;2]", "(1)", "[1"]) {
      expect(splitAnswer(text), text).toEqual([{ kind: "text", text }]);
    }
  });

  it("treats a mark still being written as text until its bracket closes", () => {
    expect(splitAnswer("It is 51% [")).toEqual([{ kind: "text", text: "It is 51% [" }]);
    expect(splitAnswer("It is 51% [1")).toEqual([{ kind: "text", text: "It is 51% [1" }]);
    expect(splitAnswer("It is 51% [1]")).toEqual([
      { kind: "text", text: "It is 51% " },
      { kind: "cite", raw: "[1]", numbers: [1] },
    ]);
  });

  it("is empty for an empty answer", () => {
    expect(splitAnswer("")).toEqual([]);
  });
});

const cite = (index: number): WireCitation => ({
  index,
  chunkId: "c".repeat(64),
  docId: "a1b2c3d4-e5f6-5a7b-8c9d-0e1f2a3b4c5d",
  pageStart: 2,
  pageEnd: 2,
  charStart: 0,
  charEnd: 5,
  quote: "quote",
});

const run = (actions: readonly ChatAction[], from: ChatState = initialChat): ChatState =>
  actions.reduce(chatReducer, from);
const event = (id: number, e: AskEvent): ChatAction => ({ type: "event", id, event: e });
const done = (extra: object = {}): AskEvent => ({
  event: "done",
  data: { answered: true, cited: [1], unknownCitations: [], complete: true, ...extra },
});

describe("chatReducer", () => {
  it("starts a turn when a question is asked", () => {
    const state = run([{ type: "ask", id: 1, answerId: "answer-1", question: "Why?" }]);
    expect(state.turns).toEqual([
      {
        id: 1,
        answerId: "answer-1",
        question: "Why?",
        answer: "",
        status: "streaming",
        citations: [],
        unknownCitations: [],
        complete: true,
      },
    ]);
  });

  it("joins the tokens, then takes the sources, the trace and the checks", () => {
    const trace = { totalMs: 5, stages: [] };
    const state = run([
      { type: "ask", id: 1, answerId: "answer-1", question: "Why?" },
      event(1, { event: "token", data: { text: "Because " } }),
      event(1, { event: "token", data: { text: "[1]." } }),
      event(1, { event: "citations", data: { citations: [cite(1)] } }),
      event(1, { event: "trace", data: { trace } }),
      event(1, done({ unknownCitations: [4] })),
    ]);
    expect(state.turns[0]).toMatchObject({
      answer: "Because [1].",
      status: "done",
      citations: [cite(1)],
      unknownCitations: [4],
      complete: true,
      trace,
    });
  });

  it("keeps the inspection of an answer that asked for one", () => {
    const state = run([
      { type: "ask", id: 1, question: "Why?" },
      event(1, inspectionEvent()),
      event(1, done()),
    ]);
    expect(state.turns[0]?.inspection).toEqual(inspection());
  });

  it("has no inspection on an answer that did not ask for one", () => {
    const state = run([{ type: "ask", id: 1, question: "Why?" }, event(1, done())]);
    expect(state.turns[0]).not.toHaveProperty("inspection");
  });

  it("ignores an inspection that arrives after Stop", () => {
    const state = run([
      { type: "ask", id: 1, question: "Why?" },
      { type: "stopped", id: 1 },
      event(1, inspectionEvent()),
    ]);
    expect(state.turns[0]).not.toHaveProperty("inspection");
  });

  it("keeps the refusal reason when the book would not answer", () => {
    const state = run([
      { type: "ask", id: 1, answerId: "answer-1", question: "Why?" },
      event(1, done({ answered: false, refusal: "no-sources" })),
    ]);
    expect(state.turns[0]).toMatchObject({ status: "done", refusal: "no-sources" });
  });

  it("is stopped, not done, when the stream says it was cut short", () => {
    const state = run([
      { type: "ask", id: 1, answerId: "answer-1", question: "Why?" },
      event(1, done({ complete: false })),
    ]);
    expect(state.turns[0]).toMatchObject({ status: "stopped", complete: false });
  });

  it("fails with the message of an error event or of the request", () => {
    const viaEvent = run([
      { type: "ask", id: 1, answerId: "answer-1", question: "a" },
      event(1, { event: "error", data: { code: "PROVIDER_UNAVAILABLE", message: "model down" } }),
    ]);
    expect(viaEvent.turns[0]).toMatchObject({ status: "failed", error: "model down" });
    const viaRequest = run([
      { type: "ask", id: 1, answerId: "answer-1", question: "a" },
      { type: "failed", id: 1, message: "Cannot reach the API" },
    ]);
    expect(viaRequest.turns[0]).toMatchObject({ status: "failed", error: "Cannot reach the API" });
  });

  it("keeps what had arrived when the reader stops the answer", () => {
    const state = run([
      { type: "ask", id: 1, answerId: "answer-1", question: "a" },
      event(1, { event: "token", data: { text: "Half an ans" } }),
      { type: "stopped", id: 1 },
    ]);
    expect(state.turns[0]).toMatchObject({
      answer: "Half an ans",
      status: "stopped",
      complete: false,
    });
  });

  it("ignores events that arrive after the turn is over", () => {
    const state = run([
      { type: "ask", id: 1, answerId: "answer-1", question: "a" },
      event(1, { event: "token", data: { text: "Hi" } }),
      { type: "stopped", id: 1 },
      event(1, { event: "token", data: { text: " there" } }),
      event(1, done()),
      { type: "failed", id: 1, message: "late" },
    ]);
    expect(state.turns[0]).toMatchObject({ answer: "Hi", status: "stopped" });
    expect(state.turns[0]).not.toHaveProperty("error");
  });

  it("keeps turns apart by id", () => {
    const state = run([
      { type: "ask", id: 1, answerId: "answer-1", question: "first" },
      event(1, { event: "token", data: { text: "one" } }),
      event(1, done()),
      { type: "ask", id: 2, answerId: "answer-2", question: "second" },
      event(2, { event: "token", data: { text: "two" } }),
    ]);
    expect(state.turns.map((t) => [t.answer, t.status])).toEqual([
      ["one", "done"],
      ["two", "streaming"],
    ]);
  });

  it("removes a turn, and clears everything", () => {
    const two = run([
      { type: "ask", id: 1, answerId: "answer-1", question: "a" },
      { type: "ask", id: 2, answerId: "answer-2", question: "b" },
    ]);
    expect(chatReducer(two, { type: "remove", id: 1 }).turns.map((t) => t.id)).toEqual([2]);
    expect(chatReducer(two, { type: "clear" })).toEqual(initialChat);
  });
});

const turn = (id: number, extra: Partial<ChatTurn> = {}): ChatTurn => ({
  id,
  answerId: `answer-${id.toString()}`,
  question: `question ${id.toString()}`,
  answer: `answer ${id.toString()}`,
  status: "done",
  citations: [],
  unknownCitations: [],
  complete: true,
  ...extra,
});

describe("historyOf", () => {
  it("sends the earlier answers that finished, oldest first", () => {
    expect(historyOf([turn(1), turn(2)])).toEqual([
      { question: "question 1", answer: "answer 1" },
      { question: "question 2", answer: "answer 2" },
    ]);
  });

  it("leaves out turns that failed, were stopped, are still arriving, were refused or are empty", () => {
    const turns = [
      turn(1, { status: "failed" }),
      turn(2, { status: "stopped" }),
      turn(3, { status: "streaming" }),
      turn(4, { refusal: "no-sources" }),
      turn(5, { answer: "" }),
      turn(6),
    ];
    expect(historyOf(turns).map((h) => h.question)).toEqual(["question 6"]);
  });

  it("keeps only the last few", () => {
    const turns = Array.from({ length: 9 }, (_, i) => turn(i + 1));
    expect(historyOf(turns, 3).map((h) => h.question)).toEqual([
      "question 7",
      "question 8",
      "question 9",
    ]);
    expect(historyOf(turns)).toHaveLength(6);
  });

  it("cuts a long turn to what the API accepts", () => {
    const [only] = historyOf([turn(1, { answer: "x".repeat(MAX_TURN_CHARS + 500) })]);
    expect(only?.answer).toHaveLength(MAX_TURN_CHARS);
  });
});

describe("toCssRect", () => {
  const view: PageView = { scale: 1.5, originX: 0, originY: 0, heightPoints: 800, overlay: true };

  it("flips the vertical axis: PDF measures up from the bottom, the screen down from the top", () => {
    // a box 12 tall whose bottom is at y = 700 has its top at 712, which is 88 points from the top
    expect(toCssRect({ x: 100, y: 700, width: 200, height: 12 }, view)).toEqual({
      left: 150,
      top: 132, // (800 - 712) * 1.5
      width: 300,
      height: 18,
    });
  });

  it("puts a box at the bottom of the page at the bottom of the drawing", () => {
    // bottom 0, height 10: its top edge is 10 points up, so 790 points from the top
    expect(toCssRect({ x: 0, y: 0, width: 10, height: 10 }, { ...view, scale: 1 })).toEqual({
      left: 0,
      top: 790,
      width: 10,
      height: 10,
    });
  });

  it("allows for a page whose origin is not 0, 0", () => {
    const shifted: PageView = { ...view, scale: 1, originX: 20, originY: 30, heightPoints: 700 };
    // x is 20 from the left edge; y 130 is 100 above the bottom edge, top 112 above it: 588 down
    expect(toCssRect({ x: 40, y: 130, width: 5, height: 12 }, shifted)).toEqual({
      left: 20,
      top: 588,
      width: 5,
      height: 12,
    });
  });
});

describe("markPassage", () => {
  // a page whose text begins at 100 in the whole document
  const page = "The quick brown fox jumps.";

  it("marks the part of the page inside the passage", () => {
    // characters 104 to 109 of the document are 4 to 9 of the page: "quick"
    expect(markPassage(page, 100, 104, 109)).toEqual({
      before: "The ",
      marked: "quick",
      after: " brown fox jumps.",
    });
  });

  it("starts at the top of the page when the passage began on an earlier page", () => {
    expect(markPassage(page, 100, 50, 108)).toEqual({
      before: "",
      marked: "The quic",
      after: "k brown fox jumps.",
    });
  });

  it("ends at the bottom of the page when the passage goes on to the next", () => {
    expect(markPassage(page, 100, 119, 500)).toEqual({
      before: "The quick brown fox",
      marked: " jumps.",
      after: "",
    });
  });

  it("marks nothing on a page the passage does not touch", () => {
    for (const [from, to] of [
      [0, 100],
      [126, 200],
      [110, 110],
    ] as const) {
      expect(markPassage(page, 100, from, to), `${from.toString()}-${to.toString()}`).toEqual({
        before: page,
        marked: "",
        after: "",
      });
    }
  });
});

describe("rating an answer", () => {
  const finished = (): ChatState =>
    run([
      { type: "ask", id: 1, answerId: "answer-1", question: "Why?" },
      { type: "event", id: 1, event: { event: "token", data: { text: "Because." } } },
      {
        type: "event",
        id: 1,
        event: {
          event: "done",
          data: { answered: true, cited: [], unknownCitations: [], complete: true },
        },
      },
    ]);

  it("keeps the rating on the finished answer, and the last one replaces the one before", () => {
    const state = run(
      [
        { type: "rating", id: 1, feedback: { rating: "up", status: "saving" } },
        { type: "rating", id: 1, feedback: { rating: "up", status: "saved" } },
        { type: "rating", id: 1, feedback: { rating: "down", note: "wrong", status: "saved" } },
      ],
      finished(),
    );
    expect(state.turns[0]?.feedback).toEqual({ rating: "down", note: "wrong", status: "saved" });
  });

  it("keeps the failure, to be shown", () => {
    const state = run(
      [{ type: "rating", id: 1, feedback: { rating: "up", status: "failed", error: "no" } }],
      finished(),
    );
    expect(state.turns[0]?.feedback).toMatchObject({ status: "failed", error: "no" });
  });

  it("does not rate an answer that is still arriving, one that failed, or one that is not there", () => {
    const streaming = run([{ type: "ask", id: 1, answerId: "answer-1", question: "Why?" }]);
    const rating = { rating: "up", status: "saving" } as const;
    expect(chatReducer(streaming, { type: "rating", id: 1, feedback: rating })).toEqual(streaming);
    const failed = run([{ type: "failed", id: 1, message: "x" }], streaming);
    expect(chatReducer(failed, { type: "rating", id: 1, feedback: rating })).toEqual(failed);
    expect(chatReducer(finished(), { type: "rating", id: 9, feedback: rating })).toEqual(
      finished(),
    );
  });

  it("gives each answer its own id, and keeps it when the answer is rated", () => {
    const state = run(
      [
        { type: "ask", id: 2, answerId: "answer-2", question: "And?" },
        { type: "rating", id: 1, feedback: { rating: "up", status: "saved" } },
      ],
      finished(),
    );
    expect(state.turns.map((t) => t.answerId)).toEqual(["answer-1", "answer-2"]);
  });
});
