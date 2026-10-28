// The record a reader's feedback leaves. It lives in core because the store that saves it is an
// adapter, and adapters may only know core. Plain data: no behaviour.

import type { Citation } from "./chat.js";
import type { DocId } from "./ids.js";

export type FeedbackRating = "up" | "down";

/**
 * A reader's verdict on one answer, with everything needed to turn it into an evaluation question
 * later: the question, the answer, what it cited, and what happened behind it.
 */
export interface FeedbackEntry {
  /** Names the answer. Several entries may share it: the newest is the reader's final word. */
  readonly answerId: string;
  /** When the server received it, ISO 8601. */
  readonly savedAt: string;
  readonly rating: FeedbackRating;
  readonly note?: string;
  readonly question: string;
  /** Empty for a question the book declined to answer. */
  readonly answer: string;
  /** Why the book declined, when it did. */
  readonly refusal?: string;
  readonly docId?: DocId;
  readonly citations: readonly Citation[];
  /** What each stage did, as the API sent it. Kept as it was; nothing here reads it. */
  readonly trace?: Readonly<Record<string, unknown>>;
  /** The index and model that wrote the answer, so feedback can be compared across systems. */
  readonly system: { readonly index: string; readonly model: string };
}
