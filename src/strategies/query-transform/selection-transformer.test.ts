import { describe, expect, it, vi } from "vitest";
import type { Query, QueryTransformer } from "../../core/index.js";
import { IdentityQueryTransformer } from "./identity-query-transformer.js";
import {
  MAX_SELECTION_SEARCH_CHARS,
  SelectionTransformer,
  selectionSearchText,
} from "./selection-transformer.js";

const identity = new IdentityQueryTransformer();

describe("selectionSearchText", () => {
  it("squeezes the whitespace of the page into single spaces", () => {
    expect(selectionSearchText("  Embeddings turn\n  sentences\t\tinto vectors.\n")).toBe(
      "Embeddings turn sentences into vectors.",
    );
  });

  it("keeps at most what a search can use", () => {
    expect(selectionSearchText("x".repeat(MAX_SELECTION_SEARCH_CHARS + 500))).toHaveLength(
      MAX_SELECTION_SEARCH_CHARS,
    );
  });
});

describe("SelectionTransformer", () => {
  it("adds the selected passage to the variants, so retrieval searches for it too", async () => {
    const transformer = new SelectionTransformer(identity);
    const result = await transformer.transform({
      text: "Explain this",
      selection: { text: "Embeddings turn\nsentences into vectors.", page: 4 },
    });
    expect(result).toEqual({
      text: "Explain this",
      selection: { text: "Embeddings turn\nsentences into vectors.", page: 4 },
      variants: ["Embeddings turn sentences into vectors."],
    });
  });

  it("does not touch the question: it is what the answering model is asked", async () => {
    const result = await new SelectionTransformer(identity).transform({
      text: "Why does this matter?",
      selection: { text: "a passage" },
    });
    expect(result.text).toBe("Why does this matter?");
  });

  it("is invisible without a selection: the query comes back as the wrapped transformer returned it", async () => {
    const query: Query = { text: "What is a vector?", history: [{ question: "q", answer: "a" }] };
    const result = await new SelectionTransformer(identity).transform(query);
    expect(result).toBe(query);
  });

  it("keeps the variants other transformers added, and adds its own after them", async () => {
    const multi: QueryTransformer = {
      name: "multi-query",
      transform: (q) => Promise.resolve({ ...q, variants: ["another phrasing"] }),
    };
    const result = await new SelectionTransformer(multi).transform({
      text: "Explain this",
      selection: { text: "the passage" },
    });
    expect(result.variants).toEqual(["another phrasing", "the passage"]);
  });

  it("works on what the wrapped transformer made of the question (a rewritten follow-up)", async () => {
    const rewriting: QueryTransformer = {
      name: "rewrite",
      transform: (q) => Promise.resolve({ ...q, text: "What does chapter 4 say about chunking?" }),
    };
    const result = await new SelectionTransformer(rewriting).transform({
      text: "and in chapter 4?",
      selection: { text: "the passage" },
    });
    expect(result).toMatchObject({
      text: "What does chapter 4 say about chunking?",
      variants: ["the passage"],
    });
  });

  it("reports the name of the transformer it wraps, so reports and traces read as before", () => {
    expect(new SelectionTransformer(identity).name).toBe("identity");
  });

  it("passes the signal on to the wrapped transformer", async () => {
    const transform = vi.fn((q: Query) => Promise.resolve(q));
    const inner: QueryTransformer = { name: "spy", transform };
    const controller = new AbortController();
    await new SelectionTransformer(inner).transform({ text: "q" }, { signal: controller.signal });
    expect(transform).toHaveBeenCalledWith({ text: "q" }, { signal: controller.signal });
  });

  it("ignores a selection that is only whitespace", async () => {
    const query: Query = { text: "Explain this", selection: { text: " \n\t " } };
    expect(await new SelectionTransformer(identity).transform(query)).toBe(query);
  });

  it("passes on the failure of the wrapped transformer", async () => {
    const failing: QueryTransformer = {
      name: "fail",
      transform: () => Promise.reject(new Error("model down")),
    };
    await expect(
      new SelectionTransformer(failing).transform({ text: "q", selection: { text: "p" } }),
    ).rejects.toThrow("model down");
  });
});
