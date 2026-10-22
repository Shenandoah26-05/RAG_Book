// Fake services for the tests of the HTTP API. Not part of the build (see tsconfig.build.json).
import type { ApiServices } from "../composition/index.js";
import { makeChunkId, PAGE_SEPARATOR } from "../core/index.js";
import type {
  AssembledPrompt,
  Chunk,
  ChatDelta,
  ChunkId,
  DocId,
  ParsedDocument,
  RetrievedChunk,
} from "../core/index.js";
import type { GroundedAnswer, GroundingReport } from "../pipeline/index.js";
import { makeDocId, Trace } from "../shared/index.js";
import type { PriceTable } from "../shared/index.js";

export const DOC: DocId = makeDocId("a".repeat(64));
export const OTHER_DOC: DocId = makeDocId("b".repeat(64));

const PAGES = [
  "Embeddings map text to vectors.\nSimilar meanings sit close together.",
  "Cosine similarity compares the direction of two vectors.",
  "A vector store keeps vectors and finds the nearest ones.",
];

/** A book of three short pages. */
export const BOOK: ParsedDocument = (() => {
  let offset = 0;
  const pages = PAGES.map((text, index) => {
    const page = {
      number: index + 1,
      text,
      span: { start: offset, end: offset + text.length },
      items: [],
    };
    offset += text.length + PAGE_SEPARATOR.length;
    return page;
  });
  return {
    id: DOC,
    title: "Vectors",
    pageCount: pages.length,
    sha256: "a".repeat(64),
    text: PAGES.join(PAGE_SEPARATOR),
    pages,
    sections: [],
  };
})();

export function chunkOf(text: string, extra: Partial<Chunk> = {}): Chunk {
  const start = BOOK.text.indexOf(text);
  return {
    id: makeChunkId({
      docId: DOC,
      strategy: "recursive",
      charStart: start,
      charEnd: start + text.length,
      text,
    }),
    text,
    metadata: {
      docId: DOC,
      pageStart: 1,
      pageEnd: 2,
      sectionPath: ["Chapter 1", "1.1 Vectors"],
      charStart: start,
      charEnd: start + text.length,
      strategy: "recursive",
    },
    ...extra,
  };
}

export const CHUNK = chunkOf("Embeddings map text to vectors.");

const retrieved = (chunk: Chunk, rank: number): RetrievedChunk => ({
  chunk,
  score: 1 / rank,
  rank,
  retriever: "hybrid",
});

export interface AnswerSpec {
  /** The pieces of the reply, one `text` event each. */
  readonly pieces?: readonly string[];
  /** Fail after the pieces, as a model that drops the connection would. */
  readonly failWith?: Error;
  /** What the guardrails report. Default: answered, citing [1]. */
  readonly grounding?: Partial<GroundingReport>;
  /** Citations: the chunks the prompt used. Default: one. Empty for a refusal. */
  readonly sources?: readonly Chunk[];
  /** Stages to put on the trace, besides retrieve. */
  readonly stages?: readonly {
    stage: string;
    summary: Record<string, string | number | boolean | null>;
  }[];
}

/** An answer as the grounded pipeline hands it back. */
export function groundedAnswer(spec: AnswerSpec = {}): GroundedAnswer {
  const { pieces = ["Embeddings ", "are ", "vectors [1]."], failWith, sources = [CHUNK] } = spec;
  const included = sources.map(retrieved);
  const citations = included.map(({ chunk }, i) => ({
    index: i + 1,
    chunkId: chunk.id,
    docId: chunk.metadata.docId,
    pageStart: chunk.metadata.pageStart,
    pageEnd: chunk.metadata.pageEnd,
    charStart: chunk.metadata.charStart,
    charEnd: chunk.metadata.charEnd,
    quote: chunk.text,
  }));

  const trace = new Trace();
  trace.start("retrieve").end({ retriever: "hybrid", found: included.length });
  for (const { stage, summary } of spec.stages ?? []) trace.start(stage).end(summary);

  const stream = (async function* (): AsyncGenerator<ChatDelta> {
    for (const text of pieces) {
      await Promise.resolve();
      yield { kind: "text", text };
    }
    if (failWith !== undefined) throw failWith;
    yield { kind: "end", reason: "stop" };
  })();

  const prompt: AssembledPrompt = {
    system: "system",
    user: "user",
    promptVersion: "rag-system@v2",
    included,
    citations,
    dropped: [],
    sourceTokens: 10,
    budget: 100,
  };
  const grounding: GroundingReport = {
    answered: true,
    cited: [1],
    unknownCitations: [],
    complete: true,
    ...spec.grounding,
  };
  return { stream, citations, prompt, trace, grounding: Promise.resolve(grounding) };
}

export interface AskCall {
  readonly question: string;
  readonly options: Parameters<ApiServices["pipeline"]["ask"]>[1];
}

export interface FakeServices extends ApiServices {
  readonly asked: AskCall[];
  readonly loads: DocId[];
}

export interface FakeServicesOptions {
  /** What each question gets. Default: the standard answer. A function can inspect the call. */
  readonly answer?: (call: AskCall) => GroundedAnswer | Promise<GroundedAnswer>;
  readonly documentIds?: readonly DocId[];
  readonly documents?: ReadonlyMap<DocId, ParsedDocument>;
  readonly chunks?: readonly Chunk[];
  readonly prices?: PriceTable;
  /** Make loading a document fail this many times first. */
  readonly loadFailures?: number;
}

export function fakeServices(options: FakeServicesOptions = {}): FakeServices {
  const asked: AskCall[] = [];
  const loads: DocId[] = [];
  let failures = options.loadFailures ?? 0;
  const documents = options.documents ?? new Map([[DOC, BOOK]]);
  const stored = new Map<ChunkId, Chunk>((options.chunks ?? [CHUNK]).map((c) => [c.id, c]));
  return {
    asked,
    loads,
    pipeline: {
      ask: async (question, askOptions) => {
        const call = { question, options: askOptions };
        asked.push(call);
        return (options.answer ?? (() => groundedAnswer()))(call);
      },
    },
    documents: {
      load: (id) => {
        loads.push(id);
        if (failures > 0) {
          failures--;
          return Promise.reject(new Error("disk on fire"));
        }
        return Promise.resolve(documents.get(id));
      },
    },
    chunks: {
      get: (ids) => Promise.resolve(ids.map((id) => stored.get(id))),
    },
    documentIds: options.documentIds ?? [DOC],
    prices: options.prices ?? { currency: "USD", models: {} },
    namespace: "recursive__ollama-all-minilm",
    model: "fake:model",
  };
}
