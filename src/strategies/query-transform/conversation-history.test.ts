import { describe, expect, it } from "vitest";
import { ConversationHistory } from "./conversation-history.js";

const turn = (n: number) => ({ question: `q${n.toString()}`, answer: `a${n.toString()}` });

describe("ConversationHistory", () => {
  it("remembers turns, oldest first", () => {
    const history = new ConversationHistory(3);
    history.add(turn(1));
    history.add(turn(2));
    expect(history.turns()).toEqual([turn(1), turn(2)]);
    expect(history.size).toBe(2);
  });

  it("forgets the oldest once it holds more than maxTurns", () => {
    const history = new ConversationHistory(2);
    [1, 2, 3].forEach((n) => {
      history.add(turn(n));
    });
    expect(history.turns()).toEqual([turn(2), turn(3)]);
  });

  it("clears", () => {
    const history = new ConversationHistory(2);
    history.add(turn(1));
    history.clear();
    expect(history.turns()).toEqual([]);
  });

  it("hands out a copy", () => {
    const history = new ConversationHistory(2);
    history.add(turn(1));
    (history.turns() as unknown[]).push("x");
    expect(history.size).toBe(1);
  });

  it("rejects a bad maxTurns", () => {
    for (const n of [0, -1, 1.5]) expect(() => new ConversationHistory(n)).toThrow(/maxTurns/);
  });
});
