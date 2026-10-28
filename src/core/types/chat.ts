import type { ChunkId, DocId } from "./ids.js";

/** One question the reader asked and the answer they were given, kept as conversation memory. */
export interface ConversationTurn {
  readonly question: string;
  readonly answer: string;
}

/** A passage the reader selected on the page before asking, with the page it was on. */
export interface Selection {
  /** The selected words, as the page shows them. */
  readonly text: string;
  /** 1-based page number, when known. */
  readonly page?: number;
}

/** A user question as it enters retrieval. Query transforms produce new `Query` values. */
export interface Query {
  readonly text: string;
  /**
   * What was said before this question, oldest first. Only a transformer reads it (to turn a
   * follow-up like "what about chapter 4?" into a standalone question); retrieval ignores it.
   */
  readonly history?: readonly ConversationTurn[];
  /**
   * Other texts to search for besides `text`: other phrasings of the question, or a made-up passage
   * that would answer it (HyDE). A plain retriever ignores them; the multi-query retriever
   * searches for `text` and for each of them and fuses the rankings. `text` stays the question
   * that is put to the answering model.
   */
  readonly variants?: readonly string[];
  /**
   * A passage the reader selected before asking ("explain this"). A transformer makes retrieval
   * search for it too, and the assembler quotes it to the answering model, so `text` keeps only the
   * question.
   */
  readonly selection?: Selection;
}

/** Points an answer back to the passage it came from. */
export interface Citation {
  /** The marker used in the answer text, starting at 1: "[1]". */
  readonly index: number;
  readonly chunkId: ChunkId;
  readonly docId: DocId;
  readonly pageStart: number;
  readonly pageEnd: number;
  readonly charStart: number;
  readonly charEnd: number;
  /** The cited text, for display and highlighting. */
  readonly quote: string;
}

export type ChatRole = "system" | "user" | "assistant";

/** One turn of a conversation, as sent to a language model. */
export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

/** Why a reply stopped: the model finished, or hit the output limit. */
export type FinishReason = "stop" | "length";

/**
 * One event of a streamed reply. A reply is any number of `text` events followed by exactly one
 * `end`; nothing comes after `end`.
 */
export type ChatDelta =
  /** The next piece of the answer. Never empty. */
  | { readonly kind: "text"; readonly text: string }
  /** The reply is complete. Token counts are present when the model reports them. */
  | {
      readonly kind: "end";
      readonly reason: FinishReason;
      readonly promptTokens?: number;
      readonly outputTokens?: number;
    };

/** Settings for one `chat` call. What is left out falls back to the provider's own settings. */
export interface ChatOptions {
  /** 0 is the most predictable, higher is more varied. */
  readonly temperature?: number;
  /** Most tokens the model may write. */
  readonly maxOutputTokens?: number;
  /** Aborting stops the request; the stream then throws the signal's reason. */
  readonly signal?: AbortSignal;
}
