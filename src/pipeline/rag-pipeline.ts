import type {
  AssembledPrompt,
  ChatDelta,
  ChatMessage,
  Citation,
  ContextAssembler,
  ConversationTurn,
  LlmProvider,
  MetadataFilter,
  QueryTransformer,
  Reranker,
  RetrievedChunk,
  Retriever,
} from "../core/index.js";
import { RagError, RetrievalProbe, Trace, withProbe, withTrace } from "../shared/index.js";
import type { RetrieverCall, TraceSummary } from "../shared/index.js";

/** The stages of the pipeline, as the trace names them. */
export const STAGES = ["transform", "retrieve", "rerank", "assemble", "generate"] as const;

export interface RagPipelineDeps {
  readonly transformer: QueryTransformer;
  readonly retriever: Retriever;
  readonly reranker: Reranker;
  /**
   * How many chunks to fetch for the reranker to choose from. Fewer than `k` means exactly `k`
   * (reranking off fetches nothing extra).
   */
  readonly rerankCandidates: number;
  readonly assembler: ContextAssembler;
  readonly llm: LlmProvider;
  /** How many chunks reach the prompt, unless a question asks for another number. */
  readonly k: number;
}

export interface AskOptions {
  /** Overrides the pipeline's `k` for this question. */
  readonly k?: number;
  /** Only chunks that satisfy every clause may be used. */
  readonly filter?: MetadataFilter;
  /**
   * What was said before this question, oldest first. The transformer uses it to make a follow-up
   * stand alone. Without it every question stands alone.
   */
  readonly history?: readonly ConversationTurn[];
  /** Aborting stops the question: before the next stage, or in the middle of the answer. */
  readonly signal?: AbortSignal;
}

/**
 * What retrieval and reranking did, kept so a learning view can show it (RAG-105). The pipeline only
 * keeps references to lists it already had; it computes nothing for it.
 */
export interface RetrievalReport {
  /** What retrieval gave the reranker, best first. */
  readonly candidates: readonly RetrievedChunk[];
  /** What the reranker kept, best first. Scores here are the reranker's. */
  readonly ranked: readonly RetrievedChunk[];
  /**
   * What each base retriever found on its own (dense and bm25 under a hybrid), when they report. Empty
   * for a retriever that does not, and then only `candidates` is known.
   */
  readonly retrievers: readonly RetrieverCall[];
}

/** What `ask` hands back. Everything but the stream is ready when it returns. */
export interface RagAnswer {
  /**
   * The model's reply: `text` events then one `end`. The model is not called until the stream is
   * read. Read it once.
   */
  readonly stream: AsyncIterable<ChatDelta>;
  /** `citations[i]` is source `[i + 1]` of the prompt, so `[n]` in the answer maps to `citations[n - 1]`. */
  readonly citations: readonly Citation[];
  /** The prompt that was sent, with the chunks it used and the ones it left out and why. */
  readonly prompt: AssembledPrompt;
  /** The chunks before and after reranking, and what each base retriever found. */
  readonly retrieval: RetrievalReport;
  /**
   * What each stage did and how long it took. The `generate` stage is added when the stream ends,
   * so read `trace.snapshot()` after the answer is read.
   */
  readonly trace: Trace;
}

/**
 * The whole question-answering flow, in order:
 *
 *   question -> transform -> retrieve -> rerank -> assemble -> generate
 *
 * It knows only ports. Every stage arrives through the constructor, so it cannot tell a dense
 * retriever from a hybrid one, or reranking on from reranking off, and there is no `if` for any
 * option. Which concrete classes to use is decided in one place, `composition/build-pipeline.ts`,
 * which is the only code that constructs this class.
 *
 * Retrieval, reranking and assembly finish before `ask` returns, so the sources are known before
 * the first word of the answer. A failure in any stage rejects `ask` (the trace records which one).
 * Whether to answer at all when nothing was found is not decided here: the assembler tells the
 * model there are no sources.
 */
export class RagPipeline {
  readonly #deps: RagPipelineDeps;

  /** @throws RagError INVALID_ARGUMENT if `k` or `rerankCandidates` is not a whole number in range */
  constructor(deps: RagPipelineDeps) {
    assertCount("k", deps.k, 1);
    assertCount("rerankCandidates", deps.rerankCandidates, 0);
    this.#deps = deps;
  }

  /** The names of the parts, for `/config` and for reports. */
  describe(): Readonly<Record<"transformer" | "retriever" | "reranker" | "llm", string>> {
    const { transformer, retriever, reranker, llm } = this.#deps;
    return {
      transformer: transformer.name,
      retriever: retriever.name,
      reranker: reranker.name,
      llm: llm.modelId,
    };
  }

  /**
   * @throws RagError INVALID_ARGUMENT for a blank question or a bad `k`; whatever a stage throws
   * (PROVIDER_UNAVAILABLE from the model, for one); the signal's reason if it is aborted
   */
  ask(question: string, options: AskOptions = {}): Promise<RagAnswer> {
    // the trace is in scope for everything the question starts, so a metered model or embedder
    // (RAG-093) records its calls on it without the stages having to pass it along
    const trace = new Trace();
    // and the same for the probe, which the retrievers report what they found on their own to
    const probe = new RetrievalProbe();
    return withTrace(trace, () =>
      withProbe(probe, () => this.#ask(trace, probe, question, options)),
    );
  }

  async #ask(
    trace: Trace,
    probe: RetrievalProbe,
    question: string,
    options: AskOptions,
  ): Promise<RagAnswer> {
    const { transformer, retriever, reranker, assembler, llm } = this.#deps;
    const k = options.k ?? this.#deps.k;
    const { filter, signal, history } = options;
    assertCount("k", k, 1);
    if (question.trim() === "") {
      throw new RagError("INVALID_ARGUMENT", "The question is blank");
    }

    const step = <T>(
      stage: string,
      fn: () => T | Promise<T>,
      summarize: (result: T) => TraceSummary,
    ): Promise<T> => {
      signal?.throwIfAborted();
      return trace.run(stage, fn, summarize);
    };

    const query = await step(
      "transform",
      () =>
        transformer.transform(
          { text: question, ...(history === undefined || history.length === 0 ? {} : { history }) },
          signal === undefined ? {} : { signal },
        ),
      (q) => ({
        transformer: transformer.name,
        changed: q.text !== question,
        history: history?.length ?? 0,
        variants: q.variants?.length ?? 0,
      }),
    );

    const candidates = await step(
      "retrieve",
      () =>
        retriever.retrieve(query, {
          k: Math.max(k, this.#deps.rerankCandidates),
          ...(filter === undefined ? {} : { filter }),
        }),
      (found) => ({ retriever: retriever.name, found: found.length }),
    );

    const ranked = await step(
      "rerank",
      () => reranker.rerank(query, candidates, { k }),
      (kept) => ({
        reranker: reranker.name,
        candidates: candidates.length,
        kept: kept.length,
        reordered: kept.some((r, i) => r.chunk.id !== candidates[i]?.chunk.id),
      }),
    );

    const prompt = await step(
      "assemble",
      () => assembler.assemble(query, ranked),
      (p) => ({
        promptVersion: p.promptVersion,
        included: p.included.length,
        dropped: p.dropped.length,
        sourceTokens: p.sourceTokens,
        budget: p.budget,
      }),
    );

    signal?.throwIfAborted();
    const messages: ChatMessage[] = [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ];
    const stream = generate(trace, llm, messages, signal);

    return {
      stream,
      citations: prompt.citations,
      prompt,
      retrieval: { candidates, ranked, retrievers: probe.calls },
      trace,
    };
  }
}

/** Joins the `text` events of an answer into the whole reply. */
export async function readAnswer(answer: Pick<RagAnswer, "stream">): Promise<string> {
  let text = "";
  for await (const delta of answer.stream) {
    if (delta.kind === "text") text += delta.text;
  }
  return text;
}

/**
 * The model's reply as a stream that also records the `generate` stage: opened when reading starts,
 * closed when the stream finishes, is abandoned (`break`), or fails.
 */
async function* generate(
  trace: Trace,
  llm: LlmProvider,
  messages: readonly ChatMessage[],
  signal: AbortSignal | undefined,
): AsyncGenerator<ChatDelta> {
  const stage = trace.start("generate");
  let characters = 0;
  let end: Extract<ChatDelta, { kind: "end" }> | undefined;
  let failed = false;
  try {
    // the stream is read long after `ask` returned, so the trace is put back in scope for the call
    const reply = withTrace(trace, () =>
      llm.chat(messages, signal === undefined ? {} : { signal }),
    );
    for await (const delta of reply) {
      if (delta.kind === "text") characters += delta.text.length;
      else end = delta;
      yield delta;
    }
  } catch (error) {
    failed = true;
    stage.fail(error);
    throw error;
  } finally {
    // also reached when the reader stops early: the stage then says it did not complete
    if (!failed) {
      stage.end({
        model: llm.modelId,
        characters,
        completed: end !== undefined,
        finishReason: end?.reason ?? null,
        promptTokens: end?.promptTokens ?? null,
        outputTokens: end?.outputTokens ?? null,
      });
    }
  }
}

function assertCount(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `${name} must be a whole number of ${min.toString()} or more, got ${String(value)}`,
    );
  }
}
