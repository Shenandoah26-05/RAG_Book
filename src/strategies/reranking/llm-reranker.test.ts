import { describe, expect, it } from "vitest";
import type { ChatDelta, ChatMessage, ChatOptions, LlmProvider } from "../../core/index.js";
import { createJsonLogger, RagError } from "../../shared/index.js";
import {
  describeRerankerContract,
  makeCandidates,
} from "../../testing/reranker-contract.testing.js";
import { LlmReranker } from "./llm-reranker.js";
import { parseRerankPrompt } from "./rerank-prompt.js";

const prompt = parseRerankPrompt(
  "rerank-relevance.v1.txt",
  "Q: {{question}}\nP: {{passage}}\nJSON.",
);
const query = { text: "What is a vector?" };
const texts = [
  "alpha passage",
  "bravo passage",
  "charlie passage",
  "delta passage",
  "echo passage",
];

interface Call {
  readonly messages: readonly ChatMessage[];
  readonly options: ChatOptions | undefined;
}
type Answer = string | Error | undefined;

/** A language model that answers from a script, and records how it was asked. */
function fakeLlm(
  answer: (call: Call, number: number) => Answer | Promise<Answer>,
  options: { delayMs?: number } = {},
): LlmProvider & { calls: Call[]; peak: number; aborted: number } {
  const state = { calls: [] as Call[], peak: 0, aborted: 0, running: 0 };
  return {
    modelId: "fake:judge",
    get calls() {
      return state.calls;
    },
    get peak() {
      return state.peak;
    },
    get aborted() {
      return state.aborted;
    },
    chat(messages, chatOptions) {
      const call: Call = { messages, options: chatOptions };
      return (async function* (): AsyncGenerator<ChatDelta> {
        const number = state.calls.length;
        state.calls.push(call);
        state.running += 1;
        state.peak = Math.max(state.peak, state.running);
        try {
          if (options.delayMs !== undefined) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, options.delayMs);
              chatOptions?.signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                state.aborted += 1;
                reject(chatOptions.signal?.reason as Error);
              });
            });
          }
          const reply = await answer(call, number);
          if (reply instanceof Error) throw reply;
          if (reply !== undefined && reply !== "") yield { kind: "text", text: reply };
          yield { kind: "end", reason: "stop" };
        } finally {
          state.running -= 1;
        }
      })();
    },
  };
}

/** Scores by which passage the prompt contains: `scores["bravo passage"]` is that passage's score. */
const scoring =
  (scores: Record<string, number>) =>
  (call: Call): string => {
    const content = call.messages[0]?.content ?? "";
    const found = Object.entries(scores).find(([text]) => content.includes(`P: ${text}\n`));
    return JSON.stringify({ score: found?.[1] ?? 0 });
  };

const ids = (results: readonly { chunk: { text: string } }[]): string[] =>
  results.map((r) => r.chunk.text);

describeRerankerContract("LlmReranker", () =>
  Promise.resolve({
    reranker: new LlmReranker({
      llm: fakeLlm(scoring({ "bravo passage": 9, "delta passage": 7, "alpha passage": 2 })),
      prompt,
    }),
    query,
    candidates: makeCandidates(texts),
  }),
);

describe("LlmReranker: ordering", () => {
  it("returns the candidates ordered by the model's score, which becomes their score", async () => {
    const candidates = makeCandidates(texts);
    const reranker = new LlmReranker({
      llm: fakeLlm(
        scoring({
          "alpha passage": 2,
          "bravo passage": 9,
          "charlie passage": 5.5,
          "delta passage": 7,
          "echo passage": 0,
        }),
      ),
      prompt,
    });
    const results = await reranker.rerank(query, candidates, { k: 5 });
    expect(ids(results)).toEqual([
      "bravo passage",
      "delta passage",
      "charlie passage",
      "alpha passage",
      "echo passage",
    ]);
    expect(results.map((r) => r.score)).toEqual([9, 7, 5.5, 2, 0]);
    expect(results.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
    // the chunk itself and where it was found are untouched
    expect(results[0]?.chunk).toBe(candidates[1]?.chunk);
    expect(results.every((r) => r.retriever === "dense")).toBe(true);
  });

  it("keeps the best k only", async () => {
    const reranker = new LlmReranker({
      llm: fakeLlm(scoring({ "echo passage": 10, "delta passage": 8, "alpha passage": 1 })),
      prompt,
    });
    const results = await reranker.rerank(query, makeCandidates(texts), { k: 2 });
    expect(ids(results)).toEqual(["echo passage", "delta passage"]);
  });

  it("puts equal scores in the retriever's order", async () => {
    const reranker = new LlmReranker({ llm: fakeLlm(() => '{"score": 5}'), prompt });
    const results = await reranker.rerank(query, makeCandidates(texts), { k: 5 });
    expect(ids(results)).toEqual(texts);
  });

  it("reads scores out of fenced or chatty replies", async () => {
    const replies = ['```json\n{"score": 9}\n```', 'Sure: {"score": 1}', '{"score": 5}'];
    const reranker = new LlmReranker({
      llm: fakeLlm((_call, n) => replies[n]),
      prompt,
      concurrency: 1,
    });
    const results = await reranker.rerank(query, makeCandidates(texts.slice(0, 3)), { k: 3 });
    expect(ids(results)).toEqual(["alpha passage", "charlie passage", "bravo passage"]);
  });
});

describe("LlmReranker: the request", () => {
  it("asks once per candidate with the question and the passage, temperature 0 and a short reply", async () => {
    const llm = fakeLlm(() => '{"score": 5}');
    await new LlmReranker({ llm, prompt }).rerank(query, makeCandidates(texts.slice(0, 3)), {
      k: 3,
    });

    expect(llm.calls).toHaveLength(3);
    const first = llm.calls[0];
    expect(first?.messages).toEqual([
      { role: "user", content: "Q: What is a vector?\nP: alpha passage\nJSON." },
    ]);
    expect(first?.options).toMatchObject({ temperature: 0, maxOutputTokens: 60 });
    expect(first?.options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("limits how many requests are in flight, using the whole limit", async () => {
    const llm = fakeLlm(() => '{"score": 5}', { delayMs: 5 });
    await new LlmReranker({ llm, prompt, concurrency: 2 }).rerank(
      query,
      makeCandidates(["a1", "b1", "c1", "d1", "e1", "f1"]),
      { k: 6 },
    );
    expect(llm.peak).toBe(2);
    expect(llm.calls).toHaveLength(6);
  });

  it("allows 4 at once by default", async () => {
    const llm = fakeLlm(() => '{"score": 5}', { delayMs: 5 });
    await new LlmReranker({ llm, prompt }).rerank(
      query,
      makeCandidates(Array.from({ length: 10 }, (_, i) => `p${i.toString()}`)),
      { k: 10 },
    );
    expect(llm.peak).toBe(4);
  });

  it("makes no request for no candidates, and none for invalid arguments", async () => {
    const llm = fakeLlm(() => '{"score": 5}');
    const reranker = new LlmReranker({ llm, prompt });
    expect(await reranker.rerank(query, [], { k: 3 })).toEqual([]);
    for (const bad of [{ k: 0 }, { k: 1.5 }, { k: Number.NaN }]) {
      await expect(reranker.rerank(query, makeCandidates(texts), bad)).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }
    await expect(
      reranker.rerank({ text: "   " }, makeCandidates(texts), { k: 3 }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(llm.calls).toHaveLength(0);
  });

  it("rejects a concurrency that is not a whole number of 1 or more", () => {
    for (const concurrency of [0, -2, 1.5, Number.NaN]) {
      expect(() => new LlmReranker({ llm: fakeLlm(() => ""), prompt, concurrency })).toThrow(
        RagError,
      );
    }
  });
});

describe("LlmReranker: invalid answers", () => {
  it("asks again once, showing the model its own reply and the format", async () => {
    const llm = fakeLlm((_call, n) => (n === 0 ? "I think it is quite relevant." : '{"score": 8}'));
    const results = await new LlmReranker({ llm, prompt }).rerank(
      query,
      makeCandidates(["only passage"]),
      { k: 1 },
    );
    expect(results[0]?.score).toBe(8);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(llm.calls[1]?.messages[1]?.content).toBe("I think it is quite relevant.");
    expect(llm.calls[1]?.messages[2]?.content).toMatch(/\{"score": 7\}/);
  });

  it("falls back when the second try is also invalid (empty, then out of range)", async () => {
    const replies = ["", '{"score": 42}', '{"score": 6}'];
    const llm = fakeLlm((_call, n) => replies[n]);
    const results = await new LlmReranker({ llm, prompt, concurrency: 1 }).rerank(
      query,
      makeCandidates(["p1"]),
      { k: 1 },
    );
    // two invalid answers means no score, so the retriever's own score (0.9) is what comes back
    expect(llm.calls).toHaveLength(2);
    expect(results[0]?.score).toBeCloseTo(0.9, 6);
  });
});

describe("LlmReranker: falling back", () => {
  const capture = (): { lines: string[]; logger: ReturnType<typeof createJsonLogger> } => {
    const lines: string[] = [];
    return {
      lines,
      logger: createJsonLogger({ write: (line) => lines.push(line), level: "debug" }),
    };
  };

  it("keeps the retriever's order and scores when a candidate gets two invalid answers, and logs it", async () => {
    const { lines, logger } = capture();
    const candidates = makeCandidates(texts);
    const llm = fakeLlm((call) =>
      call.messages[0]?.content.includes("charlie") === true ? "no idea" : '{"score": 9}',
    );
    const results = await new LlmReranker({ llm, prompt, logger }).rerank(query, candidates, {
      k: 3,
    });

    expect(results).toEqual(candidates.slice(0, 3));
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: "warn",
      message: "llm rerank failed, keeping the retriever's order",
      model: "fake:judge",
      candidates: 5,
    });
    expect(entry["reason"]).toMatch(/no valid score after a second try/);
    expect(entry["prompt"]).toBe("rerank-relevance@v1");
  });

  it("falls back, with the error's code in the log, when the server fails", async () => {
    const { lines, logger } = capture();
    const candidates = makeCandidates(texts);
    const llm = fakeLlm(() => new RagError("PROVIDER_UNAVAILABLE", "Ollama is not running"));
    const results = await new LlmReranker({ llm, prompt, logger }).rerank(query, candidates, {
      k: 2,
    });
    expect(results).toEqual(candidates.slice(0, 2));
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      reason: "PROVIDER_UNAVAILABLE: Ollama is not running",
    });
  });

  it("stops asking and cancels the requests in flight once the server fails", async () => {
    const llm = fakeLlm(
      (_call, n) => (n === 0 ? new RagError("PROVIDER_UNAVAILABLE", "down") : '{"score": 5}'),
      { delayMs: 5 },
    );
    // the delay makes call 0 fail after the others have started; they are then aborted, not awaited
    const { lines, logger } = capture();
    const candidates = makeCandidates(["a1", "b1", "c1", "d1", "e1", "f1", "g1", "h1"]);
    const results = await new LlmReranker({ llm, prompt, concurrency: 3, logger }).rerank(
      query,
      candidates,
      { k: 3 },
    );
    expect(results).toEqual(candidates.slice(0, 3));
    expect(llm.calls.length).toBeLessThan(candidates.length);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      reason: "PROVIDER_UNAVAILABLE: down",
    });
  });

  it("reports the first failure, not the cancellations it caused", async () => {
    const { lines, logger } = capture();
    let first = true;
    const llm = fakeLlm(
      () => {
        if (first) {
          first = false;
          return new RagError("PROVIDER_UNAVAILABLE", "model not found");
        }
        return '{"score": 1}';
      },
      { delayMs: 2 },
    );
    await new LlmReranker({ llm, prompt, concurrency: 4, logger }).rerank(
      query,
      makeCandidates(texts),
      { k: 3 },
    );
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      reason: "PROVIDER_UNAVAILABLE: model not found",
    });
  });

  it("does not log when everything is scored", async () => {
    const { lines, logger } = capture();
    await new LlmReranker({ llm: fakeLlm(() => '{"score": 3}'), prompt, logger }).rerank(
      query,
      makeCandidates(texts),
      { k: 3 },
    );
    expect(lines).toEqual([]);
  });
});
