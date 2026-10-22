import { describe, expect, it } from "vitest";
import { makeChunkId } from "../core/index.js";
import type {
  AssembledPrompt,
  ChatDelta,
  ContextAssembler,
  Embedder,
  LlmProvider,
  Query,
  QueryTransformer,
  Reranker,
  RetrievedChunk,
  Retriever,
} from "../core/index.js";
import { makeDocId, totalUsage, usageOf } from "../shared/index.js";
import { MeteredEmbedder, MeteredProvider } from "../strategies/index.js";
import { RagPipeline, readAnswer } from "./rag-pipeline.js";

// The model is metered once, where it is built, and everything that uses it is counted: the answer,
// and also the work around it that has no stage of its own (rewriting the question, judging
// candidates). This is the whole point of metering at the decorator, so it is tested end to end.

const DOC = makeDocId("a".repeat(64));
const chunk = (text: string, start: number): RetrievedChunk => ({
  chunk: {
    id: makeChunkId({ docId: DOC, strategy: "x", charStart: start, charEnd: start + 1, text }),
    text,
    metadata: {
      docId: DOC,
      pageStart: 1,
      pageEnd: 1,
      sectionPath: [],
      charStart: start,
      charEnd: start + 1,
      strategy: "x",
    },
  },
  score: 1,
  rank: start + 1,
  retriever: "fake",
});

/** Reads a reply to the end. */
const drain = async (stream: AsyncIterable<ChatDelta>): Promise<void> => {
  const seen: ChatDelta[] = [];
  for await (const delta of stream) seen.push(delta);
};

/** A model that reports 100 tokens in and 10 out for every call, and says who asked. */
const base: LlmProvider = {
  modelId: "fake:model",
  async *chat() {
    await Promise.resolve();
    yield { kind: "text", text: "answer" } satisfies ChatDelta;
    yield { kind: "end", reason: "stop", promptTokens: 100, outputTokens: 10 } satisfies ChatDelta;
  },
};
const embedderBase: Embedder = {
  modelId: "fake:embed",
  dimensions: 2,
  embed: (texts) => Promise.resolve(texts.map(() => Float32Array.of(1, 0))),
};

const assembler: ContextAssembler = {
  assemble: (q, chunks): AssembledPrompt => ({
    system: "SYSTEM",
    user: q.text,
    promptVersion: "t@v1",
    included: chunks,
    citations: [],
    dropped: [],
    sourceTokens: 1,
    budget: 10,
  }),
};

function pipeline(options: { rerankCalls: number; rewrites: boolean }) {
  const llm = new MeteredProvider(base);
  const embedder = new MeteredEmbedder(embedderBase);
  // the three places a model or an embedder is used around the answer
  const transformer: QueryTransformer = {
    name: "rewrite",
    transform: async (query: Query) => {
      if (options.rewrites) await drain(llm.chat([{ role: "user", content: "r" }]));
      return query;
    },
  };
  const retriever: Retriever = {
    name: "dense",
    retrieve: async (query) => {
      await embedder.embed([query.text], "query");
      return [chunk("a", 0), chunk("b", 1)];
    },
  };
  const reranker: Reranker = {
    name: "llm",
    rerank: async (_q, candidates) => {
      await Promise.all(
        Array.from({ length: options.rerankCalls }, async () => {
          await drain(llm.chat([{ role: "user", content: "score" }]));
        }),
      );
      return candidates;
    },
  };
  return new RagPipeline({
    transformer,
    retriever,
    reranker,
    rerankCandidates: 2,
    assembler,
    llm,
    k: 2,
  });
}

describe("usage on the trace of a question", () => {
  it("records every model call of the question: rewrite, rerank and the answer", async () => {
    const answer = await pipeline({ rerankCalls: 3, rewrites: true }).ask("What is a vector?");
    await readAnswer(answer);

    const entries = usageOf(answer.trace.snapshot().stages);
    const models = entries.filter((e) => e.kind === "model");
    // 1 rewrite + 3 reranks + 1 answer
    expect(models).toHaveLength(5);
    expect(totalUsage(entries)).toMatchObject({
      calls: 6, // and the embedding of the question
      promptTokens: 500,
      outputTokens: 50,
      failedCalls: 0,
    });
  });

  it("counts the embedding of the question separately from model tokens", async () => {
    const answer = await pipeline({ rerankCalls: 0, rewrites: false }).ask("What is a vector?");
    await readAnswer(answer);
    expect(totalUsage(usageOf(answer.trace.snapshot().stages))).toMatchObject({
      embeddedTokens: 5, // 17 characters at 4 per token, rounded up
      promptTokens: 100,
    });
  });

  it("records the answer even though it is read long after ask returned", async () => {
    const answer = await pipeline({ rerankCalls: 0, rewrites: false }).ask("q?");
    // nothing has been generated yet: only the embedding is on the trace
    expect(usageOf(answer.trace.snapshot().stages).filter((e) => e.kind === "model")).toHaveLength(
      0,
    );
    await readAnswer(answer);
    expect(usageOf(answer.trace.snapshot().stages).filter((e) => e.kind === "model")).toHaveLength(
      1,
    );
  });

  it("keeps two questions asked at the same time apart", async () => {
    const p = pipeline({ rerankCalls: 2, rewrites: false });
    const [a, b] = await Promise.all([p.ask("first?"), p.ask("second?")]);
    await Promise.all([readAnswer(a), readAnswer(b)]);
    for (const answer of [a, b]) {
      expect(totalUsage(usageOf(answer.trace.snapshot().stages)).promptTokens).toBe(300);
    }
  });

  it("leaves the stages the pipeline already had", async () => {
    const answer = await pipeline({ rerankCalls: 0, rewrites: false }).ask("q?");
    await readAnswer(answer);
    const names = answer.trace.snapshot().stages.map((s) => s.stage);
    for (const stage of ["transform", "retrieve", "rerank", "assemble", "generate"]) {
      expect(names).toContain(stage);
    }
  });
});
