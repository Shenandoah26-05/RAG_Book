// Stand-ins for the pipeline and its answers, for the tests of the chat. Not part of the build.
import type { ChatDelta, ChunkId, DocId, RetrievedChunk } from "../core/index.js";
import type { RagAnswer } from "../pipeline/index.js";
import { Trace } from "../shared/index.js";
import type { ChatOutput } from "./chat-session.js";

export interface Source {
  readonly text: string;
  readonly pageStart: number;
  readonly pageEnd: number;
  readonly sectionPath?: readonly string[];
}

export const SOURCES: readonly Source[] = [
  {
    text: "Embeddings are lists of numbers that stand for the meaning of a passage.",
    pageStart: 12,
    pageEnd: 13,
    sectionPath: ["Chapter 3", "3.2 Embeddings"],
  },
  { text: "Cosine similarity compares the direction of two vectors.", pageStart: 40, pageEnd: 40 },
  { text: "A vector store keeps vectors and finds the nearest ones.", pageStart: 41, pageEnd: 42 },
];

function retrieved(source: Source, index: number): RetrievedChunk {
  return {
    chunk: {
      id: `c${index.toString()}` as ChunkId,
      text: source.text,
      metadata: {
        docId: "doc" as DocId,
        pageStart: source.pageStart,
        pageEnd: source.pageEnd,
        sectionPath: source.sectionPath ?? [],
        charStart: index * 100,
        charEnd: index * 100 + source.text.length,
        strategy: "recursive",
      },
    },
    score: 1 - index * 0.1,
    rank: index + 1,
    retriever: "hybrid",
  };
}

export interface AnswerSpec {
  /** The pieces of the reply, one `text` event each. */
  readonly pieces: readonly string[];
  /** The sources in the prompt. Default: `SOURCES`. */
  readonly sources?: readonly Source[];
  /** Chunks that were left out of the prompt, and why. */
  readonly dropped?: readonly {
    readonly source: Source;
    readonly reason: "duplicate" | "over-budget";
  }[];
  /** Fail after the pieces, as a model that drops the connection would. */
  readonly failWith?: Error;
  /** Hold the answer open until this resolves, or until `signal` aborts (then it throws). */
  readonly waitFor?: Promise<void>;
  readonly signal?: AbortSignal | undefined;
}

/** An answer as the pipeline hands it back: a stream, the sources, the prompt and a trace. */
export function fakeAnswer(spec: AnswerSpec): RagAnswer {
  const included = (spec.sources ?? SOURCES).map(retrieved);
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

  // the earlier stages are over by the time the stream is read, like in the real pipeline
  const trace = new Trace();
  trace.start("retrieve").end({ retriever: "hybrid", found: included.length });

  const stream = (async function* (): AsyncGenerator<ChatDelta> {
    const stage = trace.start("generate");
    try {
      if (spec.waitFor !== undefined) {
        await new Promise<void>((resolve, reject) => {
          spec.signal?.addEventListener("abort", () => {
            reject(spec.signal?.reason as Error);
          });
          void spec.waitFor?.then(resolve);
        });
      }
      for (const text of spec.pieces) {
        await Promise.resolve();
        yield { kind: "text", text };
      }
      if (spec.failWith !== undefined) throw spec.failWith;
      yield { kind: "end", reason: "stop" };
      stage.end({ characters: spec.pieces.join("").length });
    } catch (error) {
      stage.fail(error);
      throw error;
    }
  })();

  return {
    stream,
    citations,
    prompt: {
      system: "system",
      user: "user",
      promptVersion: "rag-system@v1",
      included,
      citations,
      dropped: (spec.dropped ?? []).map(({ source, reason }, i) => ({
        chunk: retrieved(source, 10 + i),
        reason,
      })),
      sourceTokens: 120,
      budget: 3000,
    },
    retrieval: { candidates: included, ranked: included, retrievers: [] },
    trace,
  };
}

/** What a session wrote, in order, and where. */
export function recordingOutput(): ChatOutput & {
  readonly chunks: string[];
  readonly errors: string[];
  readonly text: () => string;
} {
  const chunks: string[] = [];
  const errors: string[] = [];
  return {
    chunks,
    errors,
    write: (text) => {
      chunks.push(text);
    },
    error: (text) => {
      errors.push(text);
    },
    text: () => chunks.join(""),
  };
}
