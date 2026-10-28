import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlFeedbackStore } from "../adapters/index.js";
import type { ChunkId, FeedbackEntry } from "../core/index.js";
import { latestPerAnswer, parseCandidates } from "../eval/index.js";
import { makeDocId } from "../shared/index.js";

// The API writes the candidates file and the promotion script reads it. They share no code, only
// the file, so this is the test that they agree on what is in it.

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "candidates-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const DOC = makeDocId("a".repeat(64));
const ANSWER = "3f2b8a1e-7c4d-4e9a-b5d6-1a2c3e4f5a6b";
const entry = (extra: Partial<FeedbackEntry> = {}): FeedbackEntry => ({
  answerId: ANSWER,
  savedAt: "2026-10-28T10:00:00.000Z",
  rating: "up",
  question: "What is an embedding?",
  answer: "A vector [1].",
  docId: DOC,
  citations: [
    {
      index: 1,
      chunkId: "c".repeat(64) as ChunkId,
      docId: DOC,
      pageStart: 1,
      pageEnd: 1,
      charStart: 0,
      charEnd: 31,
      quote: "Embeddings map text to vectors.",
    },
  ],
  trace: { totalMs: 5, stages: [] },
  system: { index: "recursive__ollama-all-minilm", model: "ollama:llama3.2" },
  ...extra,
});

describe("the candidates file", () => {
  it("is read back as written: every entry the store keeps is a candidate", async () => {
    const file = path.join(dir, "candidates.jsonl");
    const store = new JsonlFeedbackStore(file);
    await store.record(entry());
    await store.record(entry({ rating: "down", note: "wrong page" }));
    await store.record(
      entry({ answerId: "other", answer: "", refusal: "no-sources", citations: [] }),
    );

    const { candidates, malformed } = parseCandidates(await readFile(file, "utf8"));
    expect(malformed).toEqual([]);
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toMatchObject(entry());
    expect(latestPerAnswer(candidates).map((c) => [c.answerId, c.rating])).toEqual([
      [ANSWER, "down"],
      ["other", "up"],
    ]);
  });
});
