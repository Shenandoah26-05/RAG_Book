import { describe, expect, it } from "vitest";
import { BinaryHeap } from "./binary-heap.js";

describe("BinaryHeap", () => {
  it("pops items in the order `before` defines", () => {
    const heap = new BinaryHeap<number>((a, b) => a < b);
    const items = Array.from({ length: 200 }, (_, i) => (i * 7919) % 211);
    items.forEach((n) => {
      heap.push(n);
    });
    const out: number[] = [];
    for (let n = heap.pop(); n !== undefined; n = heap.pop()) out.push(n);
    expect(out).toEqual([...items].sort((a, b) => a - b));
  });

  it("peeks without removing, and is empty after popping everything", () => {
    const heap = new BinaryHeap<number>((a, b) => a > b);
    expect(heap.peek()).toBeUndefined();
    expect(heap.pop()).toBeUndefined();
    [3, 9, 4].forEach((n) => {
      heap.push(n);
    });
    expect(heap.peek()).toBe(9);
    expect(heap.size).toBe(3);
    expect(heap.toArray().sort()).toEqual([3, 4, 9]);
  });
});
