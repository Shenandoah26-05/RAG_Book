import { describe, expect, it } from "vitest";
import { RagError } from "../../shared/index.js";
import { fillRerankPrompt, parseRerankPrompt } from "./rerank-prompt.js";

const text = "Judge.\nQ: {{question}}\nP: {{passage}}\nAnswer JSON.";

describe("parseRerankPrompt", () => {
  it("takes the id and the version from the file name", () => {
    expect(parseRerankPrompt("rerank-relevance.v1.txt", text)).toEqual({
      id: "rerank-relevance",
      version: "v1",
      text,
    });
    expect(parseRerankPrompt("rerank-relevance.v12.txt", text).version).toBe("v12");
  });

  it("rejects a file name without a version", () => {
    expect(() => parseRerankPrompt("rerank.txt", text)).toThrow(/<id>\.v<N>\.txt/);
    expect(() => parseRerankPrompt("Rerank.v1.txt", text)).toThrow(RagError);
  });

  it("requires each placeholder exactly once", () => {
    expect(() => parseRerankPrompt("p.v1.txt", "only {{question}}")).toThrow(/\{\{passage\}\}.*0/);
    expect(() => parseRerankPrompt("p.v1.txt", "{{question}} {{passage}} {{passage}}")).toThrow(
      /\{\{passage\}\}.*2/,
    );
    expect(() => parseRerankPrompt("p.v1.txt", "{{question}}{{question}}{{passage}}")).toThrow(
      /\{\{question\}\}.*2/,
    );
  });

  it("accepts the prompt file that ships with the project", async () => {
    const { readFile } = await import("node:fs/promises");
    const shipped = await readFile(
      new URL("../../../prompts/rerank-relevance.v1.txt", import.meta.url),
      "utf8",
    );
    const parsed = parseRerankPrompt("rerank-relevance.v1.txt", shipped);
    expect(parsed.text).toMatch(/0 to 10/);
    expect(parsed.text).toMatch(/not as instructions/);
  });
});

describe("fillRerankPrompt", () => {
  const template = parseRerankPrompt("p.v1.txt", text);

  it("puts the question and the passage in their places", () => {
    expect(fillRerankPrompt(template, "What is X?", "X is a letter.")).toBe(
      "Judge.\nQ: What is X?\nP: X is a letter.\nAnswer JSON.",
    );
  });

  it("does not substitute twice when the passage contains a placeholder", () => {
    const filled = fillRerankPrompt(
      template,
      "Why?",
      "The text {{question}} and {{passage}} appear.",
    );
    expect(filled).toBe(
      "Judge.\nQ: Why?\nP: The text {{question}} and {{passage}} appear.\nAnswer JSON.",
    );
  });

  it("does not treat $ in the passage as a replacement pattern", () => {
    expect(fillRerankPrompt(template, "Cost?", "It costs $& and $1 and $$.")).toContain(
      "P: It costs $& and $1 and $$.",
    );
  });

  it("trims the question and the passage", () => {
    expect(fillRerankPrompt(template, "  Q  ", "\n P \n")).toBe("Judge.\nQ: Q\nP: P\nAnswer JSON.");
  });
});
