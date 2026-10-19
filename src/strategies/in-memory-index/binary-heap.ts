/**
 * A binary heap kept in an array. `before(a, b)` says whether `a` must come out before `b`, so the
 * item that comes out first is always at the root. Used by the HNSW search, which needs two
 * (best-first candidates, worst-first results).
 */
export class BinaryHeap<T> {
  readonly #items: T[] = [];
  readonly #before: (a: T, b: T) => boolean;

  constructor(before: (a: T, b: T) => boolean) {
    this.#before = before;
  }

  get size(): number {
    return this.#items.length;
  }

  /** The item that would come out next, or undefined when empty. */
  peek(): T | undefined {
    return this.#items[0];
  }

  push(item: T): void {
    this.#items.push(item);
    let i = this.#items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.#swapIfBefore(i, parent)) return;
      i = parent;
    }
  }

  pop(): T | undefined {
    const root = this.#items[0];
    const last = this.#items.pop();
    if (last === undefined || this.#items.length === 0) return root;
    this.#items[0] = last;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      let first = i;
      if (left < this.#items.length && this.#isBefore(left, first)) first = left;
      if (left + 1 < this.#items.length && this.#isBefore(left + 1, first)) first = left + 1;
      if (first === i) return root;
      this.#swap(i, first);
      i = first;
    }
  }

  /** All items, in no particular order. */
  toArray(): T[] {
    return [...this.#items];
  }

  #isBefore(a: number, b: number): boolean {
    const x = this.#items[a];
    const y = this.#items[b];
    return x !== undefined && y !== undefined && this.#before(x, y);
  }

  #swapIfBefore(child: number, parent: number): boolean {
    if (!this.#isBefore(child, parent)) return false;
    this.#swap(child, parent);
    return true;
  }

  #swap(a: number, b: number): void {
    const x = this.#items[a];
    const y = this.#items[b];
    if (x === undefined || y === undefined) return;
    this.#items[a] = y;
    this.#items[b] = x;
  }
}
