import type { ChunkId, DocId } from "./ids.js";

/** A user question as it enters retrieval. Query transforms produce new `Query` values. */
export interface Query {
  readonly text: string;
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
