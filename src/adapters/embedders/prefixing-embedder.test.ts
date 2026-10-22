import { describe, expect, it } from "vitest";
import type { EmbedKind, Embedder } from "../../core/index.js";
import { PrefixingEmbedder } from "./prefixing-embedder.js";

/** Remembers what it was asked to embed. */
class Spy implements Embedder {
  readonly modelId = "spy:model";
  readonly dimensions = 2;
  readonly calls: { texts: readonly string[]; kind: EmbedKind }[] = [];

  embed(texts: readonly string[], kind: EmbedKind): Promise<readonly Float32Array[]> {
    this.calls.push({ texts, kind });
    return Promise.resolve(texts.map(() => new Float32Array([1, 0])));
  }
}

const prefixes = { query: "search_query: ", document: "search_document: " };

describe("PrefixingEmbedder", () => {
  it("puts the query prefix on questions and the document prefix on passages", async () => {
    const spy = new Spy();
    const embedder = new PrefixingEmbedder(spy, prefixes);

    await embedder.embed(["what is RAG?"], "query");
    await embedder.embed(["RAG is retrieval.", "More text."], "document");

    expect(spy.calls).toEqual([
      { texts: ["search_query: what is RAG?"], kind: "query" },
      {
        texts: ["search_document: RAG is retrieval.", "search_document: More text."],
        kind: "document",
      },
    ]);
  });

  it("adds nothing for a kind whose prefix is empty (mxbai has no document prefix)", async () => {
    const spy = new Spy();
    const embedder = new PrefixingEmbedder(spy, { query: "Q: ", document: "" });

    await embedder.embed(["a passage"], "document");

    expect(spy.calls[0]?.texts).toEqual(["a passage"]);
  });

  it("keeps the model id and vector length of the wrapped embedder, and returns its vectors", async () => {
    const spy = new Spy();
    const embedder = new PrefixingEmbedder(spy, prefixes);

    expect(embedder.modelId).toBe("spy:model");
    expect(embedder.dimensions).toBe(2);
    expect(await embedder.embed([], "query")).toEqual([]);
    expect(await embedder.embed(["x"], "query")).toHaveLength(1);
  });
});
