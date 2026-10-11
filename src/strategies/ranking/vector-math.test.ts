import { describe, expect, it } from "vitest";
import { cosine, dot, euclidean, norm, normalise } from "./vector-math.js";

const v = (...values: number[]): Float32Array => Float32Array.from(values);

// Every expected value below was worked out on paper first.

describe("dot", () => {
  it("multiplies pairwise and adds: 1*4 + 2*5 + 3*6 = 32", () => {
    expect(dot(v(1, 2, 3), v(4, 5, 6))).toBe(32);
  });

  it("is 0 for vectors at right angles", () => {
    expect(dot(v(1, 0), v(0, 7))).toBe(0);
  });

  it("is 0 for empty vectors", () => {
    expect(dot(v(), v())).toBe(0);
  });

  it("rejects different lengths", () => {
    expect(() => dot(v(1, 2), v(1))).toThrowError(/same length/);
  });
});

describe("norm", () => {
  it("is the 3-4-5 triangle: |(3, 4)| = 5", () => {
    expect(norm(v(3, 4))).toBe(5);
  });

  it("is 0 for the zero vector", () => {
    expect(norm(v(0, 0, 0))).toBe(0);
  });
});

describe("normalise", () => {
  it("scales (3, 4) to (0.6, 0.8)", () => {
    const [x, y] = normalise(v(3, 4));
    expect(x).toBeCloseTo(0.6, 6);
    expect(y).toBeCloseTo(0.8, 6);
  });

  it("gives length 1", () => {
    expect(norm(normalise(v(1, 2, 3, 4, 5)))).toBeCloseTo(1, 6);
  });

  it("does not change its input", () => {
    const input = v(3, 4);
    normalise(input);
    expect([...input]).toEqual([3, 4]);
  });

  it("returns a zero vector (a copy) for a zero vector", () => {
    const zero = v(0, 0);
    const result = normalise(zero);
    expect([...result]).toEqual([0, 0]);
    expect(result).not.toBe(zero);
  });
});

describe("cosine", () => {
  it("is 1 for the same direction, whatever the length: (1, 2) and (2, 4)", () => {
    expect(cosine(v(1, 2), v(2, 4))).toBeCloseTo(1, 6);
  });

  it("is 0 for right angles", () => {
    expect(cosine(v(1, 0), v(0, 1))).toBe(0);
  });

  it("is -1 for opposite directions", () => {
    expect(cosine(v(1, 0), v(-3, 0))).toBeCloseTo(-1, 6);
  });

  it("is 1/sqrt(2) at 45 degrees: (1, 1) and (1, 0)", () => {
    expect(cosine(v(1, 1), v(1, 0))).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("is 0, not NaN, when a vector is zero", () => {
    expect(cosine(v(0, 0), v(1, 2))).toBe(0);
    expect(cosine(v(1, 2), v(0, 0))).toBe(0);
  });

  it("rejects different lengths", () => {
    expect(() => cosine(v(1), v(1, 2))).toThrowError(/same length/);
  });

  it("equals the dot product once both vectors are normalised", () => {
    const a = normalise(v(1, -2, 3, 0.5));
    const b = normalise(v(4, 1, -1, 2));
    expect(dot(a, b)).toBeCloseTo(cosine(a, b), 6);
  });
});

describe("euclidean", () => {
  it("is the 3-4-5 triangle: distance from (0, 0) to (3, 4) is 5", () => {
    expect(euclidean(v(0, 0), v(3, 4))).toBe(5);
  });

  it("is 5 from (1, 2, 3) to (4, 6, 3): sqrt(9 + 16 + 0)", () => {
    expect(euclidean(v(1, 2, 3), v(4, 6, 3))).toBe(5);
  });

  it("is 0 for equal vectors", () => {
    expect(euclidean(v(1, 2), v(1, 2))).toBe(0);
  });

  it("rejects different lengths", () => {
    expect(() => euclidean(v(1), v(1, 2))).toThrowError(/same length/);
  });

  it("ranks the same as cosine on normalised vectors: |a-b|^2 = 2 - 2*cos", () => {
    const a = normalise(v(1, 2, 3));
    const b = normalise(v(3, 1, 2));
    expect(euclidean(a, b) ** 2).toBeCloseTo(2 - 2 * cosine(a, b), 5);
  });
});
