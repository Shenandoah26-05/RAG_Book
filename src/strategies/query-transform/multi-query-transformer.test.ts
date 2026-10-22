import { describe, expect, it } from "vitest";
import { scriptedLlm } from "../../testing/scripted-llm.testing.js";
import { MULTI_QUERY_PLACEHOLDERS, MultiQueryTransformer } from "./multi-query-transformer.js";
import { parseQueryPrompt } from "./query-prompt.js";

const prompt = parseQueryPrompt(
  "multi-query.v1.txt",
  "Give {{count}} versions of: {{question}}",
  MULTI_QUERY_PLACEHOLDERS,
);
const make = (reply: string, count = 3) =>
  new MultiQueryTransformer({ llm: scriptedLlm(reply), prompt, count });

describe("MultiQueryTransformer", () => {
  it("puts the other phrasings in variants and leaves the text alone", async () => {
    const llm = scriptedLlm("How are books split?\nWhat is text segmentation?");
    const result = await new MultiQueryTransformer({ llm, prompt, count: 2 }).transform({
      text: "What is chunking?",
    });
    expect(result).toEqual({
      text: "What is chunking?",
      variants: ["How are books split?", "What is text segmentation?"],
    });
    expect(llm.calls[0]?.prompt).toBe("Give 2 versions of: What is chunking?");
  });

  it("removes list marks, blanks, copies of the question and repeats, then keeps count", async () => {
    const result = await make(
      "1. Alpha one?\n- Beta two?\n\n* what is chunking?\n2) alpha ONE?\n• Gamma three?\nDelta four?",
    ).transform({ text: "What is chunking?" });
    expect(result.variants).toEqual(["Alpha one?", "Beta two?", "Gamma three?"]);
  });

  it("adds to variants that are already there without repeating them", async () => {
    const result = await make("Same?\nNew?").transform({ text: "Q?", variants: ["same?"] });
    expect(result.variants).toEqual(["same?", "New?"]);
  });

  it("passes through when nothing is usable", async () => {
    const query = { text: "Q?" };
    expect(await make("  \nq?").transform(query)).toBe(query);
  });

  it("rejects a blank question and a bad count", async () => {
    await expect(make("x").transform({ text: "" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    for (const count of [0, 1.5, -2]) expect(() => make("x", count)).toThrow(/count/);
  });
});
