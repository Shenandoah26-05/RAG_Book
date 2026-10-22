import { describe, expect, it } from "vitest";
import { scriptedLlm } from "../../testing/scripted-llm.testing.js";
import { FollowUpRewriter, formatHistory, REWRITE_PLACEHOLDERS } from "./follow-up-rewriter.js";
import { parseQueryPrompt } from "./query-prompt.js";

const prompt = parseQueryPrompt(
  "rewrite-question.v1.txt",
  "HISTORY:\n{{history}}\nLAST: {{question}}",
  REWRITE_PLACEHOLDERS,
);
const turns = [
  { question: "What is chunking?", answer: "Splitting a book into pieces [1]." },
  { question: "Which sizes work?", answer: "Around 400 tokens [2][3]." },
];

const rewriter = (llm: ReturnType<typeof scriptedLlm>, maxTurns = 4) =>
  new FollowUpRewriter({ llm, prompt, maxTurns });

describe("FollowUpRewriter", () => {
  it("rewrites a follow-up using the history", async () => {
    const llm = scriptedLlm("What does chapter 4 say about chunking sizes?");
    const result = await rewriter(llm).transform({ text: "What about chapter 4?", history: turns });
    expect(result.text).toBe("What does chapter 4 say about chunking sizes?");
    expect(llm.calls[0]?.prompt).toContain("LAST: What about chapter 4?");
    expect(llm.calls[0]?.prompt).toContain(
      "Q: What is chunking?\nA: Splitting a book into pieces .",
    );
  });

  it("passes the first question through without calling the model", async () => {
    const llm = scriptedLlm("never used");
    const query = { text: "What is chunking?" };
    expect(await rewriter(llm).transform(query)).toBe(query);
    expect(await rewriter(llm).transform({ ...query, history: [] })).toEqual({
      ...query,
      history: [],
    });
    expect(llm.calls).toHaveLength(0);
  });

  it("sends only the last maxTurns turns", async () => {
    const llm = scriptedLlm("Standalone?");
    await rewriter(llm, 1).transform({ text: "And then?", history: turns });
    const sent = llm.calls[0]?.prompt ?? "";
    expect(sent).toContain("Which sizes work?");
    expect(sent).not.toContain("What is chunking?");
  });

  it("asks for a predictable, short reply", async () => {
    const llm = scriptedLlm("ok?");
    const controller = new AbortController();
    await rewriter(llm).transform({ text: "More?", history: turns }, { signal: controller.signal });
    expect(llm.calls[0]?.options).toMatchObject({
      temperature: 0,
      maxOutputTokens: 200,
      signal: controller.signal,
    });
  });

  it("keeps the history and variants for the transformers after it", async () => {
    const result = await rewriter(scriptedLlm("Standalone?")).transform({
      text: "More?",
      history: turns,
      variants: ["x"],
    });
    expect(result).toEqual({ text: "Standalone?", history: turns, variants: ["x"] });
  });

  it.each([
    ["Standalone question: What is X?", "What is X?"],
    ['"What is X?"', "What is X?"],
    ["\n\nWhat is X?\nBecause the book says so.", "What is X?"],
  ])("cleans the reply %j", async (reply, expected) => {
    const result = await rewriter(scriptedLlm(reply)).transform({ text: "X?", history: turns });
    expect(result.text).toBe(expected);
  });

  it.each(["", "   \n ", "x".repeat(501)])(
    "falls back to the original question for an unusable reply",
    async (reply) => {
      const result = await rewriter(scriptedLlm(reply)).transform({ text: "X?", history: turns });
      expect(result.text).toBe("X?");
    },
  );

  it("lets a model failure through", async () => {
    const failure = Object.assign(new Error("down"), { code: "PROVIDER_UNAVAILABLE" });
    await expect(
      rewriter(scriptedLlm(failure)).transform({ text: "X?", history: turns }),
    ).rejects.toBe(failure);
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      rewriter(scriptedLlm("x")).transform(
        { text: "X?", history: turns },
        { signal: controller.signal },
      ),
    ).rejects.toBeDefined();
  });

  it("rejects a blank question and a bad maxTurns", async () => {
    await expect(rewriter(scriptedLlm("x")).transform({ text: "  " })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    for (const maxTurns of [0, -1, 1.5]) {
      expect(() => rewriter(scriptedLlm("x"), maxTurns)).toThrow(/maxTurns/);
    }
  });

  it("does not change its input", async () => {
    const query = { text: "More?", history: turns };
    await rewriter(scriptedLlm("Other?")).transform(query);
    expect(query).toEqual({ text: "More?", history: turns });
  });
});

describe("formatHistory", () => {
  it("takes citation marks out of answers and keeps one line per part", () => {
    expect(formatHistory([{ question: "A\nB?", answer: "Yes [1], [2, 3] and\n\nmore." }])).toBe(
      "Q: A B?\nA: Yes , and more.",
    );
  });

  it("cuts a long answer", () => {
    const text = formatHistory([{ question: "Q?", answer: "word ".repeat(200) }]);
    expect(text.length).toBeLessThan(460);
    expect(text.endsWith("…")).toBe(true);
  });
});
