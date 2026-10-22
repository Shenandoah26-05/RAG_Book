import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChatDelta, ChatMessage, ChatOptions, LlmProvider } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { fillJudgePrompt, JUDGE_PROMPT_FILES, parseJudgePrompt } from "./judge-prompt.js";
import type { JudgeMetric } from "./judge-prompt.js";
import { extractJson } from "./judge-reply.js";
import { LlmAnswerJudge } from "./llm-answer-judge.js";

const METRICS = ["faithfulness", "relevance", "correctness"] as const;

/** The real prompt files, so a placeholder typo in `prompts/` fails here. */
const realPrompts = Object.fromEntries(
  METRICS.map((metric) => [
    metric,
    parseJudgePrompt(
      metric,
      JUDGE_PROMPT_FILES[metric],
      readFileSync(
        new URL(`../../../prompts/${JUDGE_PROMPT_FILES[metric]}`, import.meta.url),
        "utf8",
      ),
    ),
  ]),
) as Record<JudgeMetric, ReturnType<typeof parseJudgePrompt>>;

interface Call {
  readonly messages: readonly ChatMessage[];
  readonly options: ChatOptions | undefined;
}

/** Which metric a request is about, read from the first line of its prompt. */
function metricOf(messages: readonly ChatMessage[]): JudgeMetric {
  const text = messages[0]?.content ?? "";
  if (text.startsWith("You check whether an answer is supported")) return "faithfulness";
  if (text.startsWith("You judge whether an answer addresses")) return "relevance";
  return "correctness";
}

/** A model that answers each request from a script and records how it was asked. */
function fakeLlm(
  reply: (metric: JudgeMetric, attempt: number) => string | Error,
): LlmProvider & { calls: Call[] } {
  const calls: Call[] = [];
  const attempts: Record<string, number> = {};
  return {
    modelId: "fake:judge",
    calls,
    chat(messages, options) {
      calls.push({ messages, options });
      const metric = metricOf(messages);
      attempts[metric] = (attempts[metric] ?? 0) + 1;
      const answer = reply(metric, attempts[metric]);
      return (async function* (): AsyncGenerator<ChatDelta> {
        await Promise.resolve();
        if (answer instanceof Error) throw answer;
        if (answer !== "") yield { kind: "text", text: answer };
        yield { kind: "end", reason: "stop" };
      })();
    },
  };
}

const input = {
  question: "What share of deployments use RAG?",
  answer: "51% use RAG [1]. It is also the oldest technique [2].",
  sources: ["51% of deployments use RAG, up from 31%.", "Fine-tuning is used by 9%."],
  reference: "51%, up from 31% a year earlier.",
};

const goodReplies = (metric: JudgeMetric): string =>
  metric === "faithfulness"
    ? '{"claims":[{"claim":"51% use RAG","supported":true},{"claim":"RAG is the oldest technique","supported":false}]}'
    : metric === "relevance"
      ? '{"reason":"states the share","verdict":"answers"}'
      : '{"reason":"has 51% but not the earlier share","verdict":"partial"}';

const judgeWith = (llm: LlmProvider) => new LlmAnswerJudge({ llm, prompts: realPrompts });

describe("LlmAnswerJudge", () => {
  it("scores faithfulness as supported claims over claims, and maps verdicts to 1, 0.5 and 0", async () => {
    const result = await judgeWith(fakeLlm(goodReplies)).judge(input);
    // one of two claims supported: 1 / 2
    expect(result.faithfulness.score).toBe(0.5);
    expect(result.faithfulness.claims).toHaveLength(2);
    expect(result.relevance).toEqual({ score: 1, reason: "states the share" });
    expect(result.correctness.score).toBe(0.5);
    expect(result.judgeModel).toBe("fake:judge");
    expect(result.promptVersions).toEqual([
      "judge-faithfulness@v1",
      "judge-relevance@v1",
      "judge-correctness@v1",
    ]);
  });

  it("maps the other verdicts", async () => {
    const result = await judgeWith(
      fakeLlm((metric) =>
        metric === "faithfulness"
          ? '{"claims":[{"claim":"a","supported":true}]}'
          : metric === "relevance"
            ? '{"reason":"x","verdict":"off-topic"}'
            : '{"reason":"x","verdict":"incorrect"}',
      ),
    ).judge(input);
    expect(result.faithfulness.score).toBe(1);
    expect(result.relevance.score).toBe(0);
    expect(result.correctness.score).toBe(0);
  });

  it("gives an answer with no claims no faithfulness score, not 0 or 1", async () => {
    const result = await judgeWith(
      fakeLlm((metric) => (metric === "faithfulness" ? '{"claims":[]}' : goodReplies(metric))),
    ).judge({ ...input, answer: "I could not find the answer to that in the book." });
    expect(result.faithfulness.score).toBeUndefined();
    expect(result.faithfulness.claims).toEqual([]);
  });

  it("shows the faithfulness judge the numbered sources and the answer, and the others no sources", async () => {
    const llm = fakeLlm(goodReplies);
    await judgeWith(llm).judge(input);
    const [faithfulness, relevance, correctness] = llm.calls.map(
      (c) => c.messages[0]?.content ?? "",
    );
    expect(faithfulness).toContain("[1] 51% of deployments use RAG, up from 31%.");
    expect(faithfulness).toContain("[2] Fine-tuning is used by 9%.");
    expect(faithfulness).toContain(input.answer);
    expect(relevance).not.toContain("Fine-tuning");
    expect(correctness).toContain(input.reference);
    expect(correctness).toContain(input.question);
    expect(faithfulness).not.toContain("{{");
    expect(correctness).not.toContain("{{");
  });

  it("says so when there are no sources", async () => {
    const llm = fakeLlm(goodReplies);
    await judgeWith(llm).judge({ ...input, sources: [] });
    expect(llm.calls[0]?.messages[0]?.content).toContain("(no sources)");
  });

  it("asks at temperature 0 with an output limit", async () => {
    const llm = fakeLlm(goodReplies);
    await judgeWith(llm).judge(input);
    expect(llm.calls).toHaveLength(3);
    for (const call of llm.calls) {
      expect(call.options?.temperature).toBe(0);
      expect(call.options?.maxOutputTokens).toBeGreaterThan(0);
    }
  });

  it("reads a reply wrapped in a code fence or a sentence", async () => {
    const result = await judgeWith(
      fakeLlm((metric) =>
        metric === "relevance"
          ? 'Sure! ```json\n{"reason":"on point","verdict":"answers"}\n```'
          : goodReplies(metric),
      ),
    ).judge(input);
    expect(result.relevance.score).toBe(1);
  });

  it("asks again with a reminder when a reply is invalid, and uses the second reply", async () => {
    const llm = fakeLlm((metric, attempt) =>
      metric === "correctness" && attempt === 1
        ? "I think it is mostly right."
        : goodReplies(metric),
    );
    const result = await judgeWith(llm).judge(input);
    expect(result.correctness.score).toBe(0.5);
    expect(llm.calls).toHaveLength(4);
    const retry = llm.calls[3]?.messages ?? [];
    expect(retry.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(retry[1]?.content).toBe("I think it is mostly right.");
  });

  it("does not accept a verdict outside the three, or a score as text", async () => {
    await expect(
      judgeWith(
        fakeLlm((metric) =>
          metric === "relevance" ? '{"reason":"x","verdict":"great"}' : goodReplies(metric),
        ),
      ).judge(input),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("throws, instead of guessing, after two invalid replies", async () => {
    const llm = fakeLlm((metric) => (metric === "faithfulness" ? "no idea" : goodReplies(metric)));
    const failure = judgeWith(llm).judge(input);
    await expect(failure).rejects.toBeInstanceOf(RagError);
    await expect(failure).rejects.toThrow("faithfulness");
    expect(llm.calls).toHaveLength(2);
  });

  it("lets a provider failure through", async () => {
    const down = new RagError("PROVIDER_UNAVAILABLE", "server down");
    await expect(judgeWith(fakeLlm(() => down)).judge(input)).rejects.toBe(down);
  });

  it("passes the abort signal to the model", async () => {
    const llm = fakeLlm(goodReplies);
    const controller = new AbortController();
    await judgeWith(llm).judge(input, controller.signal);
    expect(llm.calls.every((c) => c.options?.signal === controller.signal)).toBe(true);
  });

  it("rejects a blank question or answer without calling the model", async () => {
    const llm = fakeLlm(goodReplies);
    await expect(judgeWith(llm).judge({ ...input, answer: "  " })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(judgeWith(llm).judge({ ...input, question: "" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(llm.calls).toHaveLength(0);
  });

  it("is not tricked by an answer that contains a placeholder", async () => {
    const llm = fakeLlm(goodReplies);
    await judgeWith(llm).judge({ ...input, answer: "see {{question}} and {{reference}}" });
    expect(llm.calls[2]?.messages[0]?.content).toContain("see {{question}} and {{reference}}");
  });
});

describe("parseJudgePrompt", () => {
  it("takes the id and version from the file name", () => {
    expect(realPrompts.relevance).toMatchObject({ id: "judge-relevance", version: "v1" });
  });

  it("needs each placeholder exactly once", () => {
    expect(() =>
      parseJudgePrompt("relevance", "judge-relevance.v1.txt", "{{question}} only"),
    ).toThrow("{{answer}} exactly once, found 0");
    expect(() =>
      parseJudgePrompt("relevance", "judge-relevance.v1.txt", "{{question}} {{answer}} {{answer}}"),
    ).toThrow("found 2");
  });

  it("refuses a placeholder the metric does not fill in", () => {
    expect(() =>
      parseJudgePrompt(
        "relevance",
        "judge-relevance.v1.txt",
        "{{question}} {{answer}} {{sources}}",
      ),
    ).toThrow("{{sources}}");
  });

  it("refuses a file name without a version", () => {
    expect(() => parseJudgePrompt("relevance", "judge.txt", "{{question}} {{answer}}")).toThrow(
      "<id>.v<N>.txt",
    );
  });

  it("reads the same with Windows line endings", () => {
    const prompt = parseJudgePrompt(
      "relevance",
      "judge-relevance.v2.txt",
      "{{question}}\r\n{{answer}}\r\n",
    );
    expect(prompt.text).toBe("{{question}}\n{{answer}}\n");
    expect(prompt.version).toBe("v2");
  });
});

describe("fillJudgePrompt", () => {
  it("trims values and fills in one pass", () => {
    const template = { id: "t", version: "v1", text: "Q={{question}} A={{answer}}" };
    expect(fillJudgePrompt(template, { question: " x ", answer: "{{question}}" })).toBe(
      "Q=x A={{question}}",
    );
  });
});

describe("extractJson", () => {
  it("reads plain JSON, a fenced block and JSON inside a sentence", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go: {"a":{"b":2}} done')).toEqual({ a: { b: 2 } });
  });

  it("gives undefined for no JSON", () => {
    expect(extractJson("")).toBeUndefined();
    expect(extractJson("{not json}")).toBeUndefined();
  });
});
