import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeChunkId } from "../core/index.js";
import type {
  Chunk,
  LlmProvider,
  MetadataFilter,
  Query,
  RetrieveOptions,
  RetrievedChunk,
  Retriever,
} from "../core/index.js";
import { RagPipeline, readAnswer } from "../pipeline/index.js";
import { makeDocId } from "../shared/index.js";
import {
  IdentityQueryTransformer,
  NoopReranker,
  parsePromptTemplate,
  SelectionTransformer,
  TemplateContextAssembler,
} from "../strategies/index.js";
import { wordTokenizer } from "../testing/fake-tokenizer.testing.js";
import { withVariantSearch } from "./build-query-transformer.js";

// A selected passage, through the pieces the configuration wires together: the transformer, the
// retriever that searches for variants, and the assembler. Only the search and the model are fakes.

const DOC = makeDocId("a".repeat(64));

function chunkOf(label: string, rank: number): RetrievedChunk {
  const text = `passage ${label}`;
  const chunk: Chunk = {
    id: makeChunkId({
      docId: DOC,
      strategy: "recursive",
      charStart: rank * 100,
      charEnd: rank * 100 + 10,
      text,
    }),
    text,
    metadata: {
      docId: DOC,
      pageStart: rank,
      pageEnd: rank,
      sectionPath: ["Chapter 1"],
      charStart: rank * 100,
      charEnd: rank * 100 + 10,
      strategy: "recursive",
    },
  };
  return { chunk, score: 1 / rank, rank, retriever: "fake" };
}

/** Finds `passage <word>` for each word of the query it is asked, and records every search. */
function searcher() {
  const asked: { text: string; filter: MetadataFilter | undefined }[] = [];
  const retriever: Retriever = {
    name: "hybrid",
    retrieve: (query: Query, options: RetrieveOptions) => {
      asked.push({ text: query.text, filter: options.filter });
      const words = query.text.split(/\s+/).filter((w) => /^[a-d]$/.test(w));
      return Promise.resolve(words.map((word, i) => chunkOf(word, i + 1)));
    },
  };
  return { retriever, asked };
}

function build() {
  const { retriever, asked } = searcher();
  const messages: string[] = [];
  const llm: LlmProvider = {
    modelId: "fake:llm",
    // eslint-disable-next-line @typescript-eslint/require-await
    async *chat(input) {
      for (const message of input) messages.push(message.content);
      yield { kind: "text", text: "ok" } as const;
      yield { kind: "end", reason: "stop" } as const;
    },
  };
  const pipeline = new RagPipeline({
    transformer: new SelectionTransformer(new IdentityQueryTransformer()),
    retriever: withVariantSearch(retriever, {
      rewrite: false,
      hyde: false,
      multiQuery: false,
      multiQueryCount: 3,
      historyTurns: 4,
    }),
    reranker: new NoopReranker(),
    rerankCandidates: 0,
    assembler: new TemplateContextAssembler({
      tokenizer: wordTokenizer(),
      template: parsePromptTemplate(
        "rag-system.v2.txt",
        readFileSync(new URL("../../prompts/rag-system.v2.txt", import.meta.url), "utf8"),
      ),
      budgetTokens: 1000,
      ordering: "relevance",
    }),
    llm,
    k: 3,
  });
  return { pipeline, asked, messages };
}

describe("asking about a selected passage", () => {
  it("searches for the question and for the passage, and fuses the two", async () => {
    const { pipeline, asked } = build();
    const answer = await pipeline.ask("explain this", {
      selection: { text: "the  passage\n about b and c", page: 3 },
    });
    expect(asked.map((a) => a.text)).toEqual(["explain this", "the passage about b and c"]);
    // the question found nothing; the passage found b and c, which are now the sources
    expect(answer.prompt.included.map((r) => r.chunk.text)).toEqual(["passage b", "passage c"]);
  });

  it("applies the same filter to both searches, so the chapter limit holds for the passage too", async () => {
    const { pipeline, asked } = build();
    const filter: MetadataFilter = [{ kind: "section", path: ["Chapter 1"] }];
    await pipeline.ask("explain this", { filter, selection: { text: "about b" } });
    expect(asked.map((a) => a.filter)).toEqual([filter, filter]);
  });

  it("shows the model the passage, fenced, with the question after it", async () => {
    const { pipeline, messages } = build();
    const answer = await pipeline.ask("explain this", {
      selection: { text: "about b", page: 3 },
    });
    await readAnswer(answer);
    const user = messages[1] ?? "";
    expect(user).toContain("(page 3)");
    expect(user).toContain("<selection>\nabout b\n</selection>");
    expect(user.endsWith("Question: explain this")).toBe(true);
    expect(answer.trace.stages.find((s) => s.stage === "transform")?.summary).toMatchObject({
      selected: true,
    });
  });

  it("is exactly what it was without a selection: one search, the question alone, no extra stage data", async () => {
    const { pipeline, asked, messages } = build();
    const answer = await pipeline.ask("a b");
    await readAnswer(answer);
    expect(asked).toHaveLength(1);
    expect(messages[1]).toBe("a b");
    expect(answer.trace.stages.find((s) => s.stage === "transform")?.summary).not.toHaveProperty(
      "selected",
    );
  });

  it("reports the retriever by its own name, as before", () => {
    const { retriever } = searcher();
    const wrapped = withVariantSearch(retriever, {
      rewrite: false,
      hyde: false,
      multiQuery: false,
      multiQueryCount: 3,
      historyTurns: 4,
    });
    expect(wrapped.name).toBe("hybrid");
  });
});
