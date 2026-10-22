import { describe, expect, it } from "vitest";
import { scriptedLlm } from "../../testing/scripted-llm.testing.js";
import { HYDE_PLACEHOLDERS, HydeTransformer } from "./hyde-transformer.js";
import { parseQueryPrompt } from "./query-prompt.js";

const prompt = parseQueryPrompt(
  "hyde.v1.txt",
  "Write a passage for: {{question}}",
  HYDE_PLACEHOLDERS,
);

describe("HydeTransformer", () => {
  it("adds the made-up passage as a variant and leaves the question alone", async () => {
    const llm = scriptedLlm("Embeddings map\n text to vectors.");
    const result = await new HydeTransformer({ llm, prompt }).transform({
      text: "What is an embedding?",
    });
    expect(result).toEqual({
      text: "What is an embedding?",
      variants: ["Embeddings map text to vectors."],
    });
    expect(llm.calls[0]?.prompt).toBe("Write a passage for: What is an embedding?");
  });

  it("keeps variants that are already there", async () => {
    const result = await new HydeTransformer({ llm: scriptedLlm("A passage."), prompt }).transform({
      text: "Q?",
      variants: ["other"],
    });
    expect(result.variants).toEqual(["other", "A passage."]);
  });

  it("cuts a runaway passage", async () => {
    const result = await new HydeTransformer({
      llm: scriptedLlm("w ".repeat(2000)),
      prompt,
    }).transform({ text: "Q?" });
    expect(result.variants?.[0]?.length).toBeLessThanOrEqual(1500);
  });

  it("passes through when the model writes nothing", async () => {
    const query = { text: "Q?" };
    const hyde = new HydeTransformer({ llm: scriptedLlm("  "), prompt });
    expect(await hyde.transform(query)).toBe(query);
  });

  it("rejects a blank question", async () => {
    await expect(
      new HydeTransformer({ llm: scriptedLlm("x"), prompt }).transform({ text: " " }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
