import { describe, expect, it } from "vitest";
import type {
  MetadataFilter,
  Query,
  RerankOptions,
  Reranker,
  RetrieveOptions,
  RetrievedChunk,
  Retriever,
} from "../../core/index.js";
import { describeRetrieverContract } from "../../testing/retriever-contract.testing.js";
import { makeCandidates } from "../../testing/reranker-contract.testing.js";
import { NoopReranker } from "../reranking/index.js";
import { RerankingRetriever } from "./reranking-retriever.js";

const ALL = makeCandidates(["a", "b", "c", "d", "e", "f"]);

/** A retriever over a fixed list that records the options it was called with. */
class FakeRetriever implements Retriever {
  readonly name = "dense";
  readonly calls: RetrieveOptions[] = [];
  retrieve(_query: Query, options: RetrieveOptions): Promise<readonly RetrievedChunk[]> {
    this.calls.push(options);
    const allowed =
      options.filter === undefined || options.filter.length === 0
        ? ALL
        : ALL.filter((r) => r.chunk.text !== "a" && r.chunk.text !== "c");
    return Promise.resolve(allowed.slice(0, options.k).map((r, i) => ({ ...r, rank: i + 1 })));
  }
}

/** Puts the candidates in reverse order, to show the reranker's order wins. */
class ReversingReranker implements Reranker {
  readonly name = "reverse";
  readonly seen: RetrievedChunk[][] = [];
  rerank(
    _query: Query,
    candidates: readonly RetrievedChunk[],
    options: RerankOptions,
  ): Promise<readonly RetrievedChunk[]> {
    this.seen.push([...candidates]);
    return Promise.resolve(
      [...candidates]
        .reverse()
        .slice(0, options.k)
        .map((r, i) => ({ ...r, rank: i + 1, score: 1 - i * 0.1 })),
    );
  }
}

const query = { text: "question" };
const filter: MetadataFilter = [{ kind: "equals", field: "strategy", value: "recursive" }];

describeRetrieverContract("RerankingRetriever with the noop reranker", () =>
  Promise.resolve({
    retriever: new RerankingRetriever({
      retriever: new FakeRetriever(),
      reranker: new NoopReranker(),
      candidates: 0,
    }),
    query,
    filter,
    allowed: (chunk) => chunk.text !== "a" && chunk.text !== "c",
  }),
);

describe("RerankingRetriever", () => {
  it("fetches max(k, candidates) from the wrapped retriever and returns the reranker's best k", async () => {
    const inner = new FakeRetriever();
    const reranker = new ReversingReranker();
    const retriever = new RerankingRetriever({ retriever: inner, reranker, candidates: 5 });

    const results = await retriever.retrieve(query, { k: 2 });

    expect(inner.calls).toEqual([{ k: 5 }]);
    expect(reranker.seen[0]?.map((r) => r.chunk.text)).toEqual(["a", "b", "c", "d", "e"]);
    expect(results.map((r) => r.chunk.text)).toEqual(["e", "d"]);
    expect(results.map((r) => r.rank)).toEqual([1, 2]);
  });

  it("fetches k when k is larger than the candidate count", async () => {
    const inner = new FakeRetriever();
    const retriever = new RerankingRetriever({
      retriever: inner,
      reranker: new NoopReranker(),
      candidates: 3,
    });
    await retriever.retrieve(query, { k: 5 });
    expect(inner.calls).toEqual([{ k: 5 }]);
  });

  it("fetches exactly k when the candidate count is 0 (reranking off)", async () => {
    const inner = new FakeRetriever();
    const retriever = new RerankingRetriever({
      retriever: inner,
      reranker: new NoopReranker(),
      candidates: 0,
    });
    const results = await retriever.retrieve(query, { k: 3 });
    expect(inner.calls).toEqual([{ k: 3 }]);
    expect(results.map((r) => r.chunk.text)).toEqual(["a", "b", "c"]);
  });

  it("passes the filter to the wrapped retriever, so the reranker never sees excluded chunks", async () => {
    const inner = new FakeRetriever();
    const reranker = new ReversingReranker();
    const retriever = new RerankingRetriever({ retriever: inner, reranker, candidates: 6 });
    await retriever.retrieve(query, { k: 2, filter });
    expect(inner.calls).toEqual([{ k: 6, filter }]);
    expect(reranker.seen[0]?.map((r) => r.chunk.text)).toEqual(["b", "d", "e", "f"]);
  });

  it("keeps the wrapped retriever's name and each result's retriever", async () => {
    const retriever = new RerankingRetriever({
      retriever: new FakeRetriever(),
      reranker: new ReversingReranker(),
      candidates: 4,
    });
    expect(retriever.name).toBe("dense");
    const results = await retriever.retrieve(query, { k: 3 });
    expect(results.every((r) => r.retriever === "dense")).toBe(true);
  });

  it("rejects a bad k even when the candidate count would hide it", async () => {
    const inner = new FakeRetriever();
    const retriever = new RerankingRetriever({
      retriever: inner,
      reranker: new NoopReranker(),
      candidates: 20,
    });
    await expect(retriever.retrieve(query, { k: 0 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(inner.calls).toEqual([]);
  });

  it.each([-1, 1.5, Number.NaN])("rejects candidates = %s", (candidates) => {
    expect(
      () =>
        new RerankingRetriever({
          retriever: new FakeRetriever(),
          reranker: new NoopReranker(),
          candidates,
        }),
    ).toThrow(/candidates must be/);
  });
});
