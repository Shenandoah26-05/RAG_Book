import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FeedbackEntry } from "../../core/index.js";
import { JsonlFeedbackStore } from "./jsonl-feedback-store.js";

const entry = (answerId: string, extra: Partial<FeedbackEntry> = {}): FeedbackEntry => ({
  answerId,
  savedAt: "2026-10-28T10:00:00.000Z",
  rating: "up",
  question: "What is an embedding?",
  answer: "A vector [1].",
  citations: [],
  system: { index: "recursive__ollama", model: "ollama:llama3.2" },
  ...extra,
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "feedback-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const linesOf = async (file: string): Promise<unknown[]> =>
  (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown);

describe("JsonlFeedbackStore", () => {
  it("creates the folder and the file, and writes one line per entry", async () => {
    const file = path.join(dir, "evals", "candidates.jsonl");
    const store = new JsonlFeedbackStore(file);
    await store.record(entry("a"));
    await store.record(entry("b", { rating: "down", note: "wrong page" }));
    expect(await linesOf(file)).toEqual([
      entry("a"),
      entry("b", { rating: "down", note: "wrong page" }),
    ]);
  });

  it("keeps what is already in the file", async () => {
    const file = path.join(dir, "candidates.jsonl");
    await new JsonlFeedbackStore(file).record(entry("a"));
    await new JsonlFeedbackStore(file).record(entry("b"));
    expect(await linesOf(file)).toHaveLength(2);
  });

  it("keeps an entry with line breaks in it on one line", async () => {
    const file = path.join(dir, "candidates.jsonl");
    await new JsonlFeedbackStore(file).record(entry("a", { note: "first\nsecond\r\nthird" }));
    const text = await readFile(file, "utf8");
    expect(text.split("\n")).toHaveLength(2); // the line and the empty rest
    expect(await linesOf(file)).toEqual([entry("a", { note: "first\nsecond\r\nthird" })]);
  });

  it("writes simultaneous calls whole and in the order made", async () => {
    const file = path.join(dir, "candidates.jsonl");
    const store = new JsonlFeedbackStore(file);
    const ids = Array.from({ length: 40 }, (_, i) => `id-${i.toString()}`);
    await Promise.all(ids.map((id) => store.record(entry(id, { note: "x".repeat(5000) }))));
    const written = (await linesOf(file)) as FeedbackEntry[];
    expect(written.map((e) => e.answerId)).toEqual(ids);
  });

  it("goes on writing after a write failed", async () => {
    // a folder where the file should be makes the append fail
    const store = new JsonlFeedbackStore(dir);
    await expect(store.record(entry("a"))).rejects.toThrow();
    const good = new JsonlFeedbackStore(path.join(dir, "ok.jsonl"));
    await good.record(entry("b"));
    expect(await linesOf(path.join(dir, "ok.jsonl"))).toHaveLength(1);
    await expect(store.record(entry("c"))).rejects.toThrow(); // still failing for the same reason, not stuck
  });
});
