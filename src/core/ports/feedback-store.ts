import type { FeedbackEntry } from "../types/feedback.js";

/**
 * Where a reader's feedback goes.
 *
 * Rules every store follows:
 * 1. `record` has saved the entry before it returns: feedback acknowledged is feedback kept.
 * 2. Entries are only added. A store never changes or removes one; a changed mind is a new entry
 *    with the same `answerId`, and whoever reads the entries keeps the newest.
 * 3. Entries are kept in the order they were recorded.
 */
export interface FeedbackStore {
  /** Where the entries are kept, for the log line at start-up. */
  readonly location: string;
  record(entry: FeedbackEntry): Promise<void>;
}
