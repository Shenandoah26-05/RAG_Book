import type { ScoredId } from "../../core/index.js";
import { RagError } from "../../shared/index.js";

/** Whether `a` ranks above `b`: a higher score, or the lower id when the scores are equal. */
export function ranksAbove(a: ScoredId, b: ScoredId): boolean {
  return a.score > b.score || (a.score === b.score && a.id < b.id);
}

/**
 * Keeps the `k` best hits out of any number offered, without sorting them all. It is a min-heap
 * kept in an array: the root is the **worst** hit kept so far, so a new hit only has to beat the
 * root to get in, and then the root is replaced. That costs O(log k) per hit instead of sorting
 * everything, O(n log n), and never holds more than `k` hits.
 *
 * Order is the one the `VectorStore` port requires: higher score first, ties by id.
 */
export class TopK {
  readonly #k: number;
  readonly #heap: ScoredId[] = [];

  /** @throws RagError INVALID_ARGUMENT if `k` is not a whole number of 1 or more */
  constructor(k: number) {
    if (!Number.isInteger(k) || k < 1) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `k must be a whole number of 1 or more, got ${String(k)}`,
      );
    }
    this.#k = k;
  }

  /** How many hits are kept right now (never more than `k`). */
  get size(): number {
    return this.#heap.length;
  }

  offer(id: ScoredId["id"], score: number): void {
    const hit = { id, score };
    const root = this.#heap[0];
    if (this.#heap.length < this.#k) {
      this.#heap.push(hit);
      this.#siftUp(this.#heap.length - 1);
    } else if (root !== undefined && ranksAbove(hit, root)) {
      this.#heap[0] = hit;
      this.#siftDown(0);
    }
  }

  /** The kept hits, best first. */
  results(): ScoredId[] {
    return [...this.#heap].sort((a, b) => (ranksAbove(a, b) ? -1 : ranksAbove(b, a) ? 1 : 0));
  }

  // A parent must rank below (be worse than) its children, so the worst hit is at index 0.
  #siftUp(from: number): void {
    let i = from;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const child = this.#heap[i];
      const above = this.#heap[parent];
      if (child === undefined || above === undefined || !ranksAbove(above, child)) return;
      this.#heap[parent] = child;
      this.#heap[i] = above;
      i = parent;
    }
  }

  #siftDown(from: number): void {
    let i = from;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let worst = i;
      const at = (n: number): ScoredId | undefined => this.#heap[n];
      const leftHit = at(left);
      const rightHit = at(right);
      const current = at(worst);
      if (leftHit !== undefined && current !== undefined && ranksAbove(current, leftHit)) {
        worst = left;
      }
      const best = at(worst);
      if (rightHit !== undefined && best !== undefined && ranksAbove(best, rightHit)) {
        worst = right;
      }
      if (worst === i) return;
      const a = at(i);
      const b = at(worst);
      if (a === undefined || b === undefined) return;
      this.#heap[i] = b;
      this.#heap[worst] = a;
      i = worst;
    }
  }
}
