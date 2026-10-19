import { describe, expect, it } from "vitest";
import { isOrderingName, orderForPrompt } from "./ordering.js";

describe("orderForPrompt", () => {
  it("keeps best first for relevance", () => {
    expect(orderForPrompt([1, 2, 3, 4], "relevance")).toEqual([1, 2, 3, 4]);
  });

  it("puts the best first and the second best last for sandwich", () => {
    expect(orderForPrompt([1, 2, 3, 4, 5], "sandwich")).toEqual([1, 3, 5, 4, 2]);
    expect(orderForPrompt([1, 2, 3, 4, 5, 6], "sandwich")).toEqual([1, 3, 5, 6, 4, 2]);
  });

  it("handles none, one and two items", () => {
    expect(orderForPrompt([], "sandwich")).toEqual([]);
    expect(orderForPrompt([1], "sandwich")).toEqual([1]);
    expect(orderForPrompt([1, 2], "sandwich")).toEqual([1, 2]);
  });

  it("does not change its input", () => {
    const input = [1, 2, 3];
    orderForPrompt(input, "sandwich");
    orderForPrompt(input, "relevance").push(9);
    expect(input).toEqual([1, 2, 3]);
  });
});

describe("isOrderingName", () => {
  it("accepts the known names only", () => {
    expect(isOrderingName("sandwich")).toBe(true);
    expect(isOrderingName("relevance")).toBe(true);
    expect(isOrderingName("random")).toBe(false);
  });
});
