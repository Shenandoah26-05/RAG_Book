import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config/index.js";
import { RagError, Trace } from "../shared/index.js";
import {
  CHAT_HELP,
  citedNumbers,
  describeChatConfig,
  describeSources,
  describeTrace,
} from "./chat-format.js";
import { fakeAnswer, SOURCES } from "./chat-session.testing.js";

describe("citedNumbers", () => {
  it("finds single, adjacent and listed citations", () => {
    expect([...citedNumbers("Cats purr [1]. Dogs bark [2][3]. Fish swim [4, 5].")]).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("counts each number once, however often it is cited", () => {
    expect([...citedNumbers("[2] and again [2] and [1,2]")].sort()).toEqual([1, 2]);
  });

  it("ignores brackets that are not source numbers", () => {
    expect(citedNumbers("see [a], [], [1a] and (3)").size).toBe(0);
  });
});

describe("describeSources", () => {
  const { prompt } = fakeAnswer({ pieces: [] });

  it("lists every source with its pages, section and the start of its text", () => {
    const text = describeSources(prompt, "no citations here");
    expect(text).toContain("[1] p.12-13  Chapter 3 > 3.2 Embeddings");
    expect(text).toContain("[2] p.40");
    expect(text).toContain("[3] p.41-42");
    expect(text).toContain(
      '"Embeddings are lists of numbers that stand for the meaning of a passage."',
    );
  });

  it("marks the sources the answer cites and the ones it does not", () => {
    const lines = describeSources(prompt, "Cosine compares direction [2].").split("\n");
    expect(lines.find((l) => l.includes("[1]"))).toMatch(/○/);
    expect(lines.find((l) => l.includes("[2]"))).toMatch(/●/);
    expect(lines.find((l) => l.includes("[3]"))).toMatch(/○/);
    expect(lines.at(-1)).toMatch(/● cited in the answer, ○ retrieved but not cited/);
  });

  it("cuts a long text to a one-line snippet", () => {
    const long = { text: "word ".repeat(100), pageStart: 1, pageEnd: 1 };
    const text = describeSources(fakeAnswer({ pieces: [], sources: [long] }).prompt, "");
    const quoteLine = text.split("\n").find((l) => l.trim().startsWith('"')) ?? "";
    expect(quoteLine.trim().length).toBeLessThanOrEqual(95);
    expect(quoteLine).toContain("…");
  });

  it("says so when there were no sources", () => {
    const empty = fakeAnswer({ pieces: [], sources: [] }).prompt;
    expect(describeSources(empty, "I could not find it.")).toBe(
      "No sources were found for this question.",
    );
  });
});

describe("describeTrace", () => {
  it("shows each stage with its time and what it reported", () => {
    const clock = [0, 0, 12, 12, 40];
    const trace = new Trace(() => clock.shift() ?? 40);
    trace.start("retrieve").end({ retriever: "hybrid", found: 5 });
    trace.start("generate").end({ model: "ollama:llama3.2", completed: true });
    const text = describeTrace(trace.snapshot(), fakeAnswer({ pieces: [] }).prompt);
    expect(text).toMatch(/Trace \(\d+ ms in total\):/);
    expect(text).toMatch(/retrieve\s+\d+ ms {2}retriever=hybrid, found=5/);
    expect(text).toMatch(/generate\s+\d+ ms {2}model=ollama:llama3.2, completed=true/);
  });

  it("shows a stage that failed with its error", () => {
    const trace = new Trace();
    trace.start("generate").fail(new RagError("PROVIDER_UNAVAILABLE", "Ollama is not running"));
    const text = describeTrace(trace.snapshot(), fakeAnswer({ pieces: [] }).prompt);
    expect(text).toMatch(/generate.*FAILED: Ollama is not running/);
  });

  it("shows how the prompt was filled and what was left out and why", () => {
    const prompt = fakeAnswer({
      pieces: [],
      dropped: [
        { source: SOURCES[0] ?? { text: "", pageStart: 1, pageEnd: 1 }, reason: "duplicate" },
        { source: { text: "Too much text", pageStart: 77, pageEnd: 78 }, reason: "over-budget" },
      ],
    }).prompt;
    const text = describeTrace(new Trace().snapshot(), prompt);
    expect(text).toContain("Prompt: rag-system@v1, 3 sources, 120 of 3000 source tokens");
    expect(text).toContain("Left out (2):");
    expect(text).toMatch(/duplicate\s+p\.12-13 {2}"Embeddings/);
    expect(text).toMatch(/over-budget\s+p\.77-78 {2}"Too much text"/);
  });

  it("does not mention a left-out list when nothing was left out", () => {
    const text = describeTrace(new Trace().snapshot(), fakeAnswer({ pieces: [] }).prompt);
    expect(text).not.toContain("Left out");
  });
});

describe("describeChatConfig", () => {
  const parts = {
    transformer: "identity",
    retriever: "hybrid",
    reranker: "noop",
    llm: "ollama:llama3.2",
  };
  const info = { config: DEFAULT_CONFIG, namespace: "recursive__ollama-all-minilm", parts };

  it("names the variant, or says default", () => {
    expect(describeChatConfig({ ...info, variant: "hybrid-weighted" })).toMatch(
      /^Variant: {4}hybrid-weighted$/m,
    );
    expect(describeChatConfig({ ...info, variant: undefined })).toMatch(/^Variant: {4}default$/m);
  });

  it("shows the index, the parts and the settings that decide an answer", () => {
    const text = describeChatConfig({ ...info, variant: undefined });
    expect(text).toContain("recursive__ollama-all-minilm (in data/index)");
    expect(text).toContain("retriever hybrid, reranker noop, model ollama:llama3.2");
    expect(text).toContain("recursive, 400 tokens, overlap 60");
    expect(text).toContain("ollama:all-minilm");
    expect(text).toContain("hybrid, fusion rrf, k = 5");
    expect(text).toMatch(/^Rerank: {5}off$/m);
    expect(text).toContain("temperature 0.2");
    expect(text).toContain("context budget 3000 tokens, ordering sandwich");
  });

  it("shows the reranker when it is on, and leaves the fusion out for a single retriever", () => {
    const config = {
      ...DEFAULT_CONFIG,
      retrieval: { ...DEFAULT_CONFIG.retrieval, strategy: "bm25" },
      rerank: { ...DEFAULT_CONFIG.rerank, enabled: true, strategy: "llm", candidates: 20 },
    };
    const text = describeChatConfig({ ...info, config, variant: undefined });
    expect(text).toMatch(/^Rerank: {5}llm, 20 candidates$/m);
    expect(text).toContain("Retrieval:  bm25, k = 5");
    expect(text).not.toContain("fusion");
  });
});

describe("CHAT_HELP", () => {
  it("lists every command", () => {
    for (const command of ["/debug", "/config", "/help", "/quit"]) {
      expect(CHAT_HELP).toContain(command);
    }
  });
});
