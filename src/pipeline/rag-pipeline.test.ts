import { describe, expect, it } from "vitest";
import type {
  AssembledPrompt,
  ChatDelta,
  ChatMessage,
  ChatOptions,
  ContextAssembler,
  LlmProvider,
  Query,
  QueryTransformer,
  RerankOptions,
  Reranker,
  RetrieveOptions,
  TransformOptions,
  Retriever,
} from "../core/index.js";
import { RagError } from "../shared/index.js";
import { makeCandidates } from "../testing/reranker-contract.testing.js";
import { RagPipeline, readAnswer, STAGES } from "./rag-pipeline.js";
import type { RagPipelineDeps } from "./rag-pipeline.js";

const ALL = makeCandidates(["a", "b", "c", "d", "e", "f"]);

/** A trail of what each stage was called with, in order. */
class Spy {
  readonly calls: string[] = [];
}

const transformer = (spy: Spy, rewrite = (text: string) => text): QueryTransformer => ({
  name: "fake-transform",
  transform: (q) => {
    spy.calls.push(`transform(${q.text})`);
    return Promise.resolve({ text: rewrite(q.text) });
  },
});

const retriever = (spy: Spy, seen: RetrieveOptions[] = []): Retriever => ({
  name: "fake-retriever",
  retrieve: (q, options) => {
    spy.calls.push(`retrieve(${q.text})`);
    seen.push(options);
    return Promise.resolve(ALL.slice(0, options.k));
  },
});

/** Puts the candidates in reverse order. */
const reversing = (spy: Spy): Reranker => ({
  name: "reverse",
  rerank: (_q, candidates, options: RerankOptions) => {
    spy.calls.push(`rerank(${candidates.length.toString()})`);
    return Promise.resolve(
      [...candidates]
        .reverse()
        .slice(0, options.k)
        .map((r, i) => ({ ...r, rank: i + 1 })),
    );
  },
});

const assembler = (spy: Spy): ContextAssembler => ({
  assemble: (q, chunks): AssembledPrompt => {
    spy.calls.push(`assemble(${chunks.map((c) => c.chunk.text).join("")})`);
    return {
      system: `SYSTEM ${chunks.map((c) => c.chunk.text).join("")}`,
      user: q.text,
      promptVersion: "test@v1",
      included: chunks,
      citations: chunks.map((c, i) => ({
        index: i + 1,
        chunkId: c.chunk.id,
        docId: c.chunk.metadata.docId,
        pageStart: c.chunk.metadata.pageStart,
        pageEnd: c.chunk.metadata.pageEnd,
        charStart: c.chunk.metadata.charStart,
        charEnd: c.chunk.metadata.charEnd,
        quote: c.chunk.text,
      })),
      dropped: [],
      sourceTokens: 5,
      budget: 100,
    };
  },
});

function llm(spy: Spy, words: readonly string[] = ["Hello", " world"]) {
  const received: { messages: readonly ChatMessage[]; options: ChatOptions | undefined }[] = [];
  const provider: LlmProvider = {
    modelId: "fake:llm",
    async *chat(messages, options) {
      spy.calls.push("chat");
      received.push({ messages, options });
      for (const text of words) {
        await Promise.resolve();
        yield { kind: "text", text } satisfies ChatDelta;
      }
      yield { kind: "end", reason: "stop", promptTokens: 10, outputTokens: 2 } satisfies ChatDelta;
    },
  };
  return { provider, received };
}

function build(overrides: Partial<RagPipelineDeps> = {}, spy = new Spy()) {
  const model = llm(spy);
  const deps: RagPipelineDeps = {
    transformer: transformer(spy),
    retriever: retriever(spy),
    reranker: reversing(spy),
    rerankCandidates: 4,
    assembler: assembler(spy),
    llm: model.provider,
    k: 2,
    ...overrides,
  };
  return { pipeline: new RagPipeline(deps), spy, model };
}

describe("RagPipeline.ask: conversation history", () => {
  const turns = [{ question: "What is chunking?", answer: "Splitting." }];

  it("hands the history and the signal to the transformer, and retrieves with the rewrite", async () => {
    const seen: { query: Query; options: TransformOptions | undefined }[] = [];
    const spy = new Spy();
    const rewriting: QueryTransformer = {
      name: "rewrite",
      transform: (query, options) => {
        seen.push({ query, options });
        return Promise.resolve({ ...query, text: "What does chapter 4 say about chunking?" });
      },
    };
    const { pipeline } = build({ transformer: rewriting }, spy);
    const controller = new AbortController();

    const answer = await pipeline.ask("What about chapter 4?", {
      history: turns,
      signal: controller.signal,
    });

    expect(seen).toEqual([
      {
        query: { text: "What about chapter 4?", history: turns },
        options: { signal: controller.signal },
      },
    ]);
    expect(spy.calls).toContain("retrieve(What does chapter 4 say about chunking?)");
    expect(answer.trace.stages.find((s) => s.stage === "transform")?.summary).toEqual({
      transformer: "rewrite",
      changed: true,
      history: 1,
      variants: 0,
    });
  });

  it("sends no history key for a first question", async () => {
    const seen: Query[] = [];
    const recording: QueryTransformer = {
      name: "t",
      transform: (query) => {
        seen.push(query);
        return Promise.resolve(query);
      },
    };
    const { pipeline } = build({ transformer: recording });
    await pipeline.ask("one");
    await pipeline.ask("two", { history: [] });
    expect(seen).toEqual([{ text: "one" }, { text: "two" }]);
  });
});

describe("RagPipeline.ask", () => {
  it("runs the stages in order and generates last, when the stream is read", async () => {
    const { pipeline, spy } = build();
    const answer = await pipeline.ask("question");

    // everything but generation has happened before the answer is returned
    expect(spy.calls).toEqual([
      "transform(question)",
      "retrieve(question)",
      "rerank(4)",
      "assemble(dc)",
    ]);
    expect(await readAnswer(answer)).toBe("Hello world");
    expect(spy.calls.at(-1)).toBe("chat");
  });

  it("sends the assembled prompt to the model as a system and a user message", async () => {
    const { pipeline, model } = build();
    await readAnswer(await pipeline.ask("question"));
    expect(model.received[0]?.messages).toEqual([
      { role: "system", content: "SYSTEM dc" },
      { role: "user", content: "question" },
    ]);
  });

  it("uses the transformed question for retrieval and for the prompt", async () => {
    const spy = new Spy();
    const { pipeline, model } = build(
      { transformer: transformer(spy, (t) => `${t} (rewritten)`) },
      spy,
    );
    await readAnswer(await pipeline.ask("question"));
    expect(spy.calls).toContain("retrieve(question (rewritten))");
    expect(model.received[0]?.messages[1]?.content).toBe("question (rewritten)");
  });

  it("fetches max(k, rerankCandidates) and keeps the reranker's best k", async () => {
    const seen: RetrieveOptions[] = [];
    const spy = new Spy();
    const { pipeline } = build({ retriever: retriever(spy, seen) }, spy);
    const answer = await pipeline.ask("question");
    expect(seen).toEqual([{ k: 4 }]);
    expect(answer.prompt.included.map((c) => c.chunk.text)).toEqual(["d", "c"]);
  });

  it("fetches exactly k when there is nothing for a reranker to choose from", async () => {
    const seen: RetrieveOptions[] = [];
    const spy = new Spy();
    const { pipeline } = build({ retriever: retriever(spy, seen), rerankCandidates: 0 }, spy);
    await pipeline.ask("question", { k: 3 });
    expect(seen).toEqual([{ k: 3 }]);
  });

  it("passes the filter to the retriever", async () => {
    const seen: RetrieveOptions[] = [];
    const spy = new Spy();
    const { pipeline } = build({ retriever: retriever(spy, seen) }, spy);
    const filter = [{ kind: "equals", field: "docId", value: "x" }] as const;
    await pipeline.ask("question", { filter });
    expect(seen[0]?.filter).toEqual(filter);
  });

  it("returns the citations of the prompt, source [n] being citations[n - 1]", async () => {
    const { pipeline } = build();
    const answer = await pipeline.ask("question");
    expect(answer.citations.map((c) => c.index)).toEqual([1, 2]);
    expect(answer.citations.map((c) => c.quote)).toEqual(["d", "c"]);
    expect(answer.citations).toBe(answer.prompt.citations);
  });

  it("does not call the model until the stream is read", async () => {
    const { pipeline, spy } = build();
    await pipeline.ask("question");
    expect(spy.calls).not.toContain("chat");
  });
});

describe("RagPipeline trace", () => {
  it("records every stage, in order, with a summary", async () => {
    const { pipeline } = build();
    const answer = await pipeline.ask("question");
    await readAnswer(answer);

    const stages = answer.trace.snapshot().stages;
    expect(stages.map((s) => s.stage)).toEqual([...STAGES]);
    expect(stages.every((s) => s.status === "ok")).toBe(true);
    const byName = Object.fromEntries(stages.map((s) => [s.stage, s.summary]));
    expect(byName["transform"]).toEqual({
      transformer: "fake-transform",
      changed: false,
      history: 0,
      variants: 0,
    });
    expect(byName["retrieve"]).toEqual({ retriever: "fake-retriever", found: 4 });
    expect(byName["rerank"]).toEqual({
      reranker: "reverse",
      candidates: 4,
      kept: 2,
      reordered: true,
    });
    expect(byName["assemble"]).toMatchObject({ promptVersion: "test@v1", included: 2, dropped: 0 });
    expect(byName["generate"]).toEqual({
      model: "fake:llm",
      characters: 11,
      completed: true,
      finishReason: "stop",
      promptTokens: 10,
      outputTokens: 2,
    });
  });

  it("closes the generate stage as not completed when the reader stops early", async () => {
    const { pipeline } = build();
    const answer = await pipeline.ask("question");
    for await (const delta of answer.stream) {
      if (delta.kind === "text") break;
    }
    const generate = answer.trace.stages.find((s) => s.stage === "generate");
    expect(generate?.status).toBe("ok");
    expect(generate?.summary).toMatchObject({ completed: false, characters: 5 });
  });

  it("records a failing model as an error on the generate stage and rethrows it", async () => {
    const failure = new RagError("PROVIDER_UNAVAILABLE", "Ollama is not running");
    const provider: LlmProvider = {
      modelId: "fake:llm",
      // eslint-disable-next-line require-yield
      async *chat() {
        await Promise.resolve();
        throw failure;
      },
    };
    const { pipeline } = build({ llm: provider });
    const answer = await pipeline.ask("question");
    await expect(readAnswer(answer)).rejects.toBe(failure);
    const generate = answer.trace.stages.find((s) => s.stage === "generate");
    expect(generate).toMatchObject({ status: "error", error: "Ollama is not running" });
  });
});

describe("RagPipeline failures", () => {
  it("rejects ask when a stage fails, and the trace is not returned", async () => {
    const failure = new RagError("PROVIDER_UNAVAILABLE", "index offline");
    const { pipeline, model } = build({
      retriever: { name: "broken", retrieve: () => Promise.reject(failure) },
    });
    await expect(pipeline.ask("question")).rejects.toBe(failure);
    expect(model.received).toEqual([]);
  });

  it.each(["", "  \n"])("rejects the blank question %j as INVALID_ARGUMENT", async (text) => {
    const { pipeline, spy } = build();
    await expect(pipeline.ask(text)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(spy.calls).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects k = %s as INVALID_ARGUMENT", async (k) => {
    const { pipeline, spy } = build();
    await expect(pipeline.ask("question", { k })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(spy.calls).toEqual([]);
  });

  it("stops before the next stage when the signal is aborted", async () => {
    const controller = new AbortController();
    const spy = new Spy();
    const { pipeline } = build(
      {
        transformer: {
          name: "aborting",
          transform: (q: Query) => {
            controller.abort(new Error("stopped"));
            return Promise.resolve(q);
          },
        },
      },
      spy,
    );
    await expect(pipeline.ask("question", { signal: controller.signal })).rejects.toThrow(
      "stopped",
    );
    expect(spy.calls).toEqual([]);
  });

  it("passes the signal to the model", async () => {
    const { pipeline, model } = build();
    const controller = new AbortController();
    await readAnswer(await pipeline.ask("question", { signal: controller.signal }));
    expect(model.received[0]?.options?.signal).toBe(controller.signal);
  });

  it.each([[{ k: 0 }], [{ k: 1.5 }], [{ rerankCandidates: -1 }], [{ rerankCandidates: 1.5 }]])(
    "rejects settings %j in the constructor",
    (overrides) => {
      expect(() => build(overrides)).toThrow(RagError);
    },
  );
});

describe("RagPipeline.describe", () => {
  it("names its parts", () => {
    expect(build().pipeline.describe()).toEqual({
      transformer: "fake-transform",
      retriever: "fake-retriever",
      reranker: "reverse",
      llm: "fake:llm",
    });
  });
});
