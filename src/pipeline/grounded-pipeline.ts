import type { ChatDelta } from "../core/index.js";
import { RagError } from "../shared/index.js";
import type { AnswerPipeline } from "./answer-pipeline.js";
import type { AskOptions, RagAnswer } from "./rag-pipeline.js";

/** What the reader is told when the book has nothing to answer with. Sent without calling the model. */
export const NOT_FOUND_MESSAGE = "I could not find the answer to that in the book.";

/** Why an answer was refused instead of generated. */
export type RefusalReason =
  /** Nothing reached the prompt: retrieval found nothing, or nothing fit. */
  | "no-sources"
  /** The best source scored below `minScore`. */
  | "low-score";

/** What the guardrails found out about an answer. */
export interface GroundingReport {
  /** False when the model was not called because the book had no good enough source. */
  readonly answered: boolean;
  readonly refusal?: RefusalReason;
  /** The source numbers the answer cites, each once, ascending. */
  readonly cited: readonly number[];
  /** Cited numbers that are not sources of the prompt: 0, or above the number of sources. */
  readonly unknownCitations: readonly number[];
  /** False if the reader stopped early or the stream failed, so the text checked was partial. */
  readonly complete: boolean;
}

export interface GroundedAnswer extends RagAnswer {
  /**
   * Settles when the stream ends (or is abandoned or fails), with the checks on the whole text. It
   * never rejects. It stays pending if the stream is never read.
   */
  readonly grounding: Promise<GroundingReport>;
}

export interface GroundedPipelineDeps {
  readonly inner: AnswerPipeline;
  /**
   * Answers "not found" when the best source scores below this. 0 turns the score rule off. Scores
   * are on the scale of the retriever (or reranker) in use, so the right value depends on it.
   */
  readonly minScore: number;
}

/** `[1]`, `[2][3]` and `[1, 2]` as citation marks; the numbers inside are what is checked. */
const CITATION = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

/** The source numbers cited in `text`, each once, ascending. */
export function citedNumbers(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(CITATION)) {
    for (const part of (match[1] ?? "").split(",")) found.add(Number(part));
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Guardrails around generation, as a decorator: it asks the wrapped pipeline, then looks at what
 * came back. Retrieval, reranking and assembly have finished by then and the model has not been
 * called, because the answer's stream is read lazily. That is the moment to decide.
 *
 * 1. **Not found.** If no source reached the prompt, or the best one scores below `minScore`, the
 *    stream is replaced by a fixed "not found" reply and the model is never called. A model asked
 *    to answer from nothing may invent something that sounds right; a refusal cannot.
 * 2. **Honest citations.** When the stream ends, every `[n]` in the whole reply is checked against
 *    the sources of the prompt, and the result is in `grounding` and in the trace. The words have
 *    already been shown to the reader by then and cannot be taken back, so this reports and does
 *    not rewrite. Only marks that look like citations are read, so a year in square brackets in a
 *    quotation would be flagged too.
 *
 * (The third rule, keeping retrieved text apart from the instructions, is in the prompt itself:
 * `prompts/rag-system.v2.txt` and the assembler.)
 */
export class GroundedPipeline implements AnswerPipeline {
  readonly #inner: AnswerPipeline;
  readonly #minScore: number;

  /** @throws RagError INVALID_ARGUMENT if `minScore` is negative or not a number */
  constructor(deps: GroundedPipelineDeps) {
    if (!(deps.minScore >= 0)) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `minScore must be 0 or more, got ${String(deps.minScore)}`,
      );
    }
    this.#inner = deps.inner;
    this.#minScore = deps.minScore;
  }

  describe(): ReturnType<AnswerPipeline["describe"]> {
    return this.#inner.describe();
  }

  async ask(question: string, options: AskOptions = {}): Promise<GroundedAnswer> {
    const answer = await this.#inner.ask(question, options);
    const { included } = answer.prompt;
    const best = included.reduce((top, r) => Math.max(top, r.score), Number.NEGATIVE_INFINITY);

    const refusal: RefusalReason | undefined =
      included.length === 0
        ? "no-sources"
        : this.#minScore > 0 && best < this.#minScore
          ? "low-score"
          : undefined;

    answer.trace.start("ground").end({
      answered: refusal === undefined,
      refusal: refusal ?? null,
      bestScore: included.length === 0 ? null : best,
      minScore: this.#minScore,
    });

    if (refusal !== undefined) {
      return {
        ...answer,
        stream: notFound(),
        citations: [],
        grounding: Promise.resolve({
          answered: false,
          refusal,
          cited: [],
          unknownCitations: [],
          complete: true,
        }),
      };
    }

    let settle: (report: GroundingReport) => void = () => undefined;
    const grounding = new Promise<GroundingReport>((resolve) => {
      settle = resolve;
    });
    return {
      ...answer,
      stream: check(answer, settle),
      grounding,
    };
  }
}

async function* notFound(): AsyncGenerator<ChatDelta> {
  await Promise.resolve();
  yield { kind: "text", text: NOT_FOUND_MESSAGE };
  yield { kind: "end", reason: "stop" };
}

/** Passes the reply through unchanged, and checks its citations once it is over. */
async function* check(
  answer: RagAnswer,
  settle: (report: GroundingReport) => void,
): AsyncGenerator<ChatDelta> {
  let text = "";
  let complete = false;
  try {
    for await (const delta of answer.stream) {
      if (delta.kind === "text") text += delta.text;
      else complete = true;
      yield delta;
    }
  } finally {
    const cited = citedNumbers(text);
    const sources = answer.citations.length;
    const unknownCitations = cited.filter((n) => n < 1 || n > sources);
    const stage = answer.trace.start("check-citations");
    stage.end({ cited: cited.length, unknown: unknownCitations.length, complete });
    settle({ answered: true, cited, unknownCitations, complete });
  }
}
