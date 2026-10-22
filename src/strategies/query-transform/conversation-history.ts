import type { ConversationTurn } from "../../core/index.js";
import { RagError } from "../../shared/index.js";

/**
 * The memory of a conversation: the latest turns, oldest first. It keeps at most `maxTurns`, so a
 * long chat cannot grow without bound; a transformer only ever reads the last few anyway.
 */
export class ConversationHistory {
  readonly #maxTurns: number;
  #turns: ConversationTurn[] = [];

  /** @throws RagError INVALID_ARGUMENT if `maxTurns` is not a whole number of 1 or more */
  constructor(maxTurns: number) {
    if (!Number.isInteger(maxTurns) || maxTurns < 1) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `maxTurns must be a whole number of 1 or more, got ${String(maxTurns)}`,
      );
    }
    this.#maxTurns = maxTurns;
  }

  get size(): number {
    return this.#turns.length;
  }

  /** Remembers a turn; the oldest is forgotten once there are more than `maxTurns`. */
  add(turn: ConversationTurn): void {
    this.#turns = [...this.#turns, turn].slice(-this.#maxTurns);
  }

  /** The remembered turns, oldest first. A copy: changing it does not change the memory. */
  turns(): readonly ConversationTurn[] {
    return [...this.#turns];
  }

  /** Forgets everything, as when a new topic starts. */
  clear(): void {
    this.#turns = [];
  }
}
