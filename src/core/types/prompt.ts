import type { Citation } from "./chat.js";
import type { RetrievedChunk } from "./retrieval.js";

/**
 * A prompt kept as data. The text lives in a versioned file (`prompts/<id>.<version>.txt`), so a
 * change to the wording is a new version and an eval result can name the prompt it ran with.
 */
export interface PromptTemplate {
  /** e.g. "rag-system". */
  readonly id: string;
  /** e.g. "v1". */
  readonly version: string;
  /** Contains the placeholder `{{sources}}` exactly once. */
  readonly text: string;
}

/** Why a retrieved chunk did not reach the prompt. */
export type DropReason = "duplicate" | "over-budget";

export interface DroppedChunk {
  readonly chunk: RetrievedChunk;
  readonly reason: DropReason;
}

/** What the generation step sends to the model, and the evidence for how it was built. */
export interface AssembledPrompt {
  /** Instructions plus the numbered sources. */
  readonly system: string;
  /** The question, unchanged. */
  readonly user: string;
  /** `"<id>@<version>"` of the template, e.g. "rag-system@v1". */
  readonly promptVersion: string;
  /** The chunks in the prompt, in prompt order: `included[i]` is source `[i + 1]`. */
  readonly included: readonly RetrievedChunk[];
  /** One per included chunk, in the same order, so `[n]` in an answer maps to its passage. */
  readonly citations: readonly Citation[];
  /** Chunks that were left out, in the order they were considered, each with the reason. */
  readonly dropped: readonly DroppedChunk[];
  /** Tokens used by the sources block. At most `budget`. */
  readonly sourceTokens: number;
  /** The token budget the sources were fitted to. */
  readonly budget: number;
}
