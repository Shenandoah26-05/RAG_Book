import { describe, expect, it } from "vitest";
import type { AssembledPrompt, ChatDelta, Citation, RetrievedChunk } from "../core/index.js";
import { Trace } from "../shared/index.js";
import { makeCandidates } from "../testing/reranker-contract.testing.js";
import type { AnswerPipeline } from "./answer-pipeline.js";
import { citedNumbers, GroundedPipeline, NOT_FOUND_MESSAGE } from "./grounded-pipeline.js";
import type { AskOptions, RagAnswer } from "./rag-pipeline.js";
import { readAnswer } from "./rag-pipeline.js";

const text = (t: string): ChatDelta => ({ kind: "text", text: t });
const END: ChatDelta = { kind: "end", reason: "stop" };

function citation(index: number, chunk: RetrievedChunk): Citation {
  const { docId, pageStart, pageEnd, charStart, charEnd } = chunk.chunk.metadata;
  return {
    index,
    chunkId: chunk.chunk.id,
    docId,
    pageStart,
    pageEnd,
    charStart,
    charEnd,
    quote: chunk.chunk.text,
  };
}

interface Fake {
  readonly pipeline: AnswerPipeline;
  /** True once the model's stream has been asked for anything. */
  readonly state: { streamStarted: boolean; asked: { question: string; options: AskOptions }[] };
}

/** A wrapped pipeline whose prompt holds sources with the given scores, and whose model says `deltas`. */
function fake(scores: readonly number[], deltas: readonly ChatDelta[], fail?: Error): Fake {
  const state: Fake["state"] = { streamStarted: false, asked: [] };
  const included = makeCandidates(scores.map((_, i) => `source ${(i + 1).toString()}`)).map(
    (r, i) => ({ ...r, score: scores[i] ?? 0 }),
  );
  const pipeline: AnswerPipeline = {
    describe: () => ({
      transformer: "identity",
      retriever: "dense",
      reranker: "noop",
      llm: "fake:llm",
    }),
    ask: (question, options = {}) => {
      state.asked.push({ question, options });
      const prompt: AssembledPrompt = {
        system: "system",
        user: question,
        promptVersion: "rag-system@v2",
        included,
        citations: included.map((r, i) => citation(i + 1, r)),
        dropped: [],
        sourceTokens: 10,
        budget: 100,
      };
      async function* stream(): AsyncGenerator<ChatDelta> {
        await Promise.resolve();
        state.streamStarted = true;
        for (const delta of deltas) yield delta;
        if (fail !== undefined) throw fail;
      }
      const answer: RagAnswer = {
        stream: stream(),
        citations: prompt.citations,
        prompt,
        trace: new Trace(),
      };
      return Promise.resolve(answer);
    },
  };
  return { pipeline, state };
}

const grounded = (f: Fake, minScore = 0) => new GroundedPipeline({ inner: f.pipeline, minScore });

describe("citedNumbers", () => {
  it.each([
    ["Cats purr [1].", [1]],
    ["Both [2][3] and again [2].", [2, 3]],
    ["Grouped [1, 4] marks", [1, 4]],
    ["No citations here.", []],
    ["A year [1999] looks like a mark", [1999]],
    ["Not marks: [a] [] (1) [1.5]", []],
  ])("%j -> %j", (reply, expected) => {
    expect(citedNumbers(reply)).toEqual(expected);
  });
});

describe("GroundedPipeline: honest citations", () => {
  it("passes the reply through unchanged and reports the sources it cites", async () => {
    const f = fake([0.9, 0.8], [text("Cats purr "), text("[1] and sleep [2]."), END]);
    const answer = await grounded(f).ask("q");
    const seen: ChatDelta[] = [];
    for await (const delta of answer.stream) seen.push(delta);
    expect(seen).toEqual([text("Cats purr "), text("[1] and sleep [2]."), END]);
    expect(await answer.grounding).toEqual({
      answered: true,
      cited: [1, 2],
      unknownCitations: [],
      complete: true,
    });
  });

  it.each([
    ["a number above the sources", "See [3].", [3]],
    ["zero", "See [0] and [1].", [0]],
    ["several, in groups", "See [1][5] and [2, 9].", [5, 9]],
    ["the same wrong number twice", "[4] and [4]", [4]],
  ])("flags %s", async (_name, reply, unknown) => {
    const f = fake([0.9, 0.8], [text(reply), END]);
    const answer = await grounded(f).ask("q");
    await readAnswer(answer);
    expect((await answer.grounding).unknownCitations).toEqual(unknown);
  });

  it("sees a mark that is split across two pieces of the stream", async () => {
    const f = fake([0.9, 0.8], [text("See ["), text("7"), text("]."), END]);
    const answer = await grounded(f).ask("q");
    await readAnswer(answer);
    expect((await answer.grounding).unknownCitations).toEqual([7]);
  });

  it("is fine with an answer that cites nothing", async () => {
    const f = fake([0.9], [text("Cats purr."), END]);
    const answer = await grounded(f).ask("q");
    await readAnswer(answer);
    expect(await answer.grounding).toMatchObject({ cited: [], unknownCitations: [] });
  });

  it("records the check in the trace once the reply is read", async () => {
    const f = fake([0.9, 0.8], [text("[1] [9]"), END]);
    const answer = await grounded(f).ask("q");
    expect(answer.trace.stages.map((s) => s.stage)).toEqual(["ground"]);
    await readAnswer(answer);
    const stage = answer.trace.stages.find((s) => s.stage === "check-citations");
    expect(stage?.summary).toEqual({ cited: 2, unknown: 1, complete: true });
  });

  it("reports a partial check when the reader stops early", async () => {
    const f = fake([0.9, 0.8], [text("[1] first "), text("[9] second "), END]);
    const answer = await grounded(f).ask("q");
    for await (const delta of answer.stream) {
      if (delta.kind === "text") break;
    }
    expect(await answer.grounding).toEqual({
      answered: true,
      cited: [1],
      unknownCitations: [],
      complete: false,
    });
  });

  it("settles the report, and still throws, when the model fails mid-reply", async () => {
    const f = fake([0.9], [text("[1] and [8]")], new Error("connection lost"));
    const answer = await grounded(f).ask("q");
    await expect(readAnswer(answer)).rejects.toThrow("connection lost");
    expect(await answer.grounding).toMatchObject({ unknownCitations: [8], complete: false });
  });
});

describe("GroundedPipeline: not found", () => {
  it("refuses without calling the model when no source reached the prompt", async () => {
    const f = fake([], [text("I made something up [1]."), END]);
    const answer = await grounded(f).ask("q");
    expect(await readAnswer(answer)).toBe(NOT_FOUND_MESSAGE);
    expect(f.state.streamStarted).toBe(false);
    expect(answer.citations).toEqual([]);
    expect(await answer.grounding).toEqual({
      answered: false,
      refusal: "no-sources",
      cited: [],
      unknownCitations: [],
      complete: true,
    });
  });

  it("ends the refusal like any reply: text, then one end event", async () => {
    const answer = await grounded(fake([], [])).ask("q");
    const seen: ChatDelta[] = [];
    for await (const delta of answer.stream) seen.push(delta);
    expect(seen).toEqual([text(NOT_FOUND_MESSAGE), END]);
  });

  it("refuses when the best source scores below minScore", async () => {
    const f = fake([0.2, 0.1], [text("Probably [1]."), END]);
    const answer = await grounded(f, 0.3).ask("q");
    expect(await readAnswer(answer)).toBe(NOT_FOUND_MESSAGE);
    expect(f.state.streamStarted).toBe(false);
    expect(await answer.grounding).toMatchObject({ answered: false, refusal: "low-score" });
  });

  it("answers when the best source scores exactly minScore, or more", async () => {
    for (const best of [0.3, 0.45]) {
      const f = fake([best, 0.1], [text("Cats purr [1]."), END]);
      const answer = await grounded(f, 0.3).ask("q");
      expect(await readAnswer(answer)).toBe("Cats purr [1].");
      expect(f.state.streamStarted).toBe(true);
    }
  });

  it("goes by the best source, wherever it sits in the prompt", async () => {
    // a sandwich ordering puts the strongest sources first and last, not necessarily first
    const f = fake([0.1, 0.5, 0.2], [text("ok [2]"), END]);
    expect(await readAnswer(await grounded(f, 0.4).ask("q"))).toBe("ok [2]");
  });

  it("never refuses on score when minScore is 0, however low the scores are", async () => {
    const f = fake([0.001], [text("Weak but answered [1]."), END]);
    expect(await readAnswer(await grounded(f, 0).ask("q"))).toBe("Weak but answered [1].");
  });

  it("says in the trace whether it answered", async () => {
    const refused = await grounded(fake([0.2], [END]), 0.3).ask("q");
    expect(refused.trace.stages.find((s) => s.stage === "ground")?.summary).toEqual({
      answered: false,
      refusal: "low-score",
      bestScore: 0.2,
      minScore: 0.3,
    });
    const answered = await grounded(fake([0.9], [END]), 0.3).ask("q");
    expect(answered.trace.stages.find((s) => s.stage === "ground")?.summary).toEqual({
      answered: true,
      refusal: null,
      bestScore: 0.9,
      minScore: 0.3,
    });
  });
});

describe("GroundedPipeline: as a pipeline", () => {
  it("hands the question and options to the wrapped pipeline unchanged", async () => {
    const f = fake([0.9], [END]);
    const options: AskOptions = { k: 3, filter: [{ kind: "pageRange", from: 2 }] };
    await grounded(f).ask("what is a chunk", options);
    expect(f.state.asked).toEqual([{ question: "what is a chunk", options }]);
  });

  it("describes the wrapped pipeline", () => {
    expect(grounded(fake([], [])).describe()).toEqual({
      transformer: "identity",
      retriever: "dense",
      reranker: "noop",
      llm: "fake:llm",
    });
  });

  it.each([-0.1, Number.NaN])("rejects minScore %s as INVALID_ARGUMENT", (minScore) => {
    expect(() => grounded(fake([], []), minScore)).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }) as Error,
    );
  });
});
