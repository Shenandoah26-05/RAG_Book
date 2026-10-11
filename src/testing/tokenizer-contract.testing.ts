// Test helper: the rules every Tokenizer must follow (see core/ports/tokenizer.ts). Not part of the
// build (see tsconfig.build.json).
import { describe, expect, it } from "vitest";
import type { Tokenizer } from "../core/index.js";

const SAMPLES: readonly string[] = [
  "Hello, world.",
  "A longer passage about retrieval-augmented generation, with punctuation; numbers like 3.14; and a list.",
  "Line one\nLine two\n\nLine four",
  "Unicode: café, naïve, 日本語, 🙂",
  "   leading and trailing whitespace   ",
  "x".repeat(1000),
];

/** Runs the shared tokenizer rules against the tokenizer that `create` returns. */
export function describeTokenizerContract(label: string, create: () => Tokenizer): void {
  describe(`${label} satisfies the tokenizer contract`, () => {
    const tokenizer = create();

    it("has a non-empty name", () => {
      expect(tokenizer.name.length).toBeGreaterThan(0);
    });

    it("gives no tokens for the empty string", () => {
      expect(tokenizer.count("")).toBe(0);
      expect(tokenizer.encode("")).toEqual([]);
    });

    it("counts at least one token for any non-empty text", () => {
      for (const text of SAMPLES) expect(tokenizer.count(text)).toBeGreaterThan(0);
    });

    it("count equals the length of encode", () => {
      for (const text of SAMPLES) expect(tokenizer.count(text)).toBe(tokenizer.encode(text).length);
    });

    it("is deterministic", () => {
      for (const text of SAMPLES) {
        expect(tokenizer.encode(text)).toEqual(tokenizer.encode(text));
        expect(tokenizer.count(text)).toBe(tokenizer.count(text));
      }
    });

    it("never counts fewer tokens for more text", () => {
      for (const a of SAMPLES) {
        for (const b of SAMPLES) {
          expect(tokenizer.count(a + b)).toBeGreaterThanOrEqual(tokenizer.count(a));
        }
      }
    });

    it("returns whole numbers as ids", () => {
      for (const text of SAMPLES) {
        for (const id of tokenizer.encode(text)) expect(Number.isInteger(id)).toBe(true);
      }
    });
  });
}
