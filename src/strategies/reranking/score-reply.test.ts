import { describe, expect, it } from "vitest";
import { parseScoreReply } from "./score-reply.js";

describe("parseScoreReply", () => {
  it("reads a bare JSON object", () => {
    expect(parseScoreReply('{"score": 7}')).toBe(7);
    expect(parseScoreReply('{"score":0}')).toBe(0);
    expect(parseScoreReply('{"score": 10}')).toBe(10);
    expect(parseScoreReply('{ "score": 6.5 }')).toBe(6.5);
  });

  it("finds the object inside a code fence or after a sentence", () => {
    expect(parseScoreReply('```json\n{"score": 8}\n```')).toBe(8);
    expect(parseScoreReply('Sure! Here is my judgement: {"score": 3} Hope that helps.')).toBe(3);
  });

  it("takes the first object that is valid, skipping broken ones", () => {
    expect(parseScoreReply('{"score": } then {"score": 4} and {"score": 9}')).toBe(4);
    expect(parseScoreReply('{"note": "hmm"} {"score": 5}')).toBe(5);
  });

  it("ignores extra fields in a valid object", () => {
    expect(parseScoreReply('{"score": 2, "why": "off topic"}')).toBe(2);
  });

  it("gives undefined for a score outside 0 to 10", () => {
    expect(parseScoreReply('{"score": 11}')).toBeUndefined();
    expect(parseScoreReply('{"score": -1}')).toBeUndefined();
  });

  it("gives undefined for a score that is not a number", () => {
    expect(parseScoreReply('{"score": "7"}')).toBeUndefined();
    expect(parseScoreReply('{"score": null}')).toBeUndefined();
    expect(parseScoreReply('{"score": true}')).toBeUndefined();
  });

  it("gives undefined when there is no object, or no score in it", () => {
    expect(parseScoreReply("")).toBeUndefined();
    expect(parseScoreReply("7")).toBeUndefined();
    expect(parseScoreReply("The score is 7 out of 10.")).toBeUndefined();
    expect(parseScoreReply('{"rating": 7}')).toBeUndefined();
    expect(parseScoreReply('{"score": 7')).toBeUndefined();
  });
});
