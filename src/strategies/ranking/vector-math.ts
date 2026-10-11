import { RagError } from "../../shared/index.js";

// Vector similarity written by hand, on purpose. Pure functions on Float32Array, no I/O. The sums
// are kept in a `number` (64-bit), so rounding error does not pile up in 32-bit floats.
//
// Why this matters: the Embedder port returns L2-normalised vectors (length 1). For those,
// cosine(a, b) = dot(a, b) / (|a| * |b|) = dot(a, b) / (1 * 1) = dot(a, b), so the dot product ranks
// results exactly like cosine and skips two square roots and a division per comparison.

function assertSameLength(name: string, a: Float32Array, b: Float32Array): void {
  if (a.length !== b.length) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `${name}: vectors must have the same length, got ${a.length.toString()} and ${b.length.toString()}`,
    );
  }
}

/** The dot product: the sum of `a[i] * b[i]`. */
export function dot(a: Float32Array, b: Float32Array): number {
  assertSameLength("dot", a, b);
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

/** The length of the vector (L2 norm): the square root of its dot product with itself. */
export function norm(a: Float32Array): number {
  return Math.sqrt(dot(a, a));
}

/**
 * A new vector pointing the same way with length 1. The input is not changed. A zero vector has no
 * direction, so it is returned as a zero vector (a copy) instead of dividing by zero.
 */
export function normalise(a: Float32Array): Float32Array {
  const length = norm(a);
  if (length === 0) {
    return new Float32Array(a);
  }
  return a.map((x) => x / length);
}

/**
 * The cosine of the angle between the vectors, from -1 (opposite) through 0 (unrelated) to 1 (same
 * direction). It ignores length. If either vector is a zero vector there is no angle, and the result
 * is 0 rather than NaN.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  assertSameLength("cosine", a, b);
  const lengths = norm(a) * norm(b);
  return lengths === 0 ? 0 : dot(a, b) / lengths;
}

/** The straight-line distance between the two points: 0 for equal vectors, larger means further apart. */
export function euclidean(a: Float32Array, b: Float32Array): number {
  assertSameLength("euclidean", a, b);
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    sum += difference * difference;
  }
  return Math.sqrt(sum);
}
