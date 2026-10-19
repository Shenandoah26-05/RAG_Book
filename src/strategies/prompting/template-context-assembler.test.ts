import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeChunkId } from "../../core/index.js";
import type { Chunk, RetrievedChunk } from "../../core/index.js";
import { makeDocId } from "../../shared/index.js";
import { wordTokenizer } from "../../testing/fake-tokenizer.testing.js";
import { parsePromptTemplate } from "./prompt-template.js";
import { NO_SOURCES, TemplateContextAssembler } from "./template-context-assembler.js";
import type { TemplateContextAssemblerOptions } from "./template-context-assembler.js";
import type { OrderingName } from "./ordering.js";

const DOC = makeDocId("a".repeat(64));
const TEMPLATE = parsePromptTemplate(
  "rag-system.v1.txt",
  readFileSync(new URL("../../../prompts/rag-system.v1.txt", import.meta.url), "utf8"),
);

function retrieved(
  rank: number,
  text: string,
  pages: [number, number] = [rank, rank],
  sectionPath: string[] = [],
): RetrievedChunk {
  const charStart = rank * 1000;
  const chunk: Chunk = {
    id: makeChunkId({
      docId: DOC,
      strategy: "recursive",
      charStart,
      charEnd: charStart + text.length,
      text,
    }),
    text,
    metadata: {
      docId: DOC,
      pageStart: pages[0],
      pageEnd: pages[1],
      sectionPath,
      charStart,
      charEnd: charStart + text.length,
      strategy: "recursive",
    },
  };
  return { chunk, score: 1 / rank, rank, retriever: "dense" };
}

function assembler(overrides: Partial<TemplateContextAssemblerOptions> = {}) {
  return new TemplateContextAssembler({
    tokenizer: wordTokenizer(),
    template: TEMPLATE,
    budgetTokens: 1000,
    ordering: "relevance",
    ...overrides,
  });
}

/** Distinct passages, so none is a near-duplicate of another. */
const PASSAGES = [
  "Embeddings map text to vectors so similar meanings sit close together.",
  "BM25 scores a chunk by how often the query words appear and how rare they are.",
  "Reciprocal rank fusion merges two rankings by adding one over the rank plus sixty.",
  "A reranker reads the question and a chunk together and scores the pair directly.",
  "Chunk overlap repeats the end of one chunk at the start of the next to keep context.",
];
const ranked = PASSAGES.map((text, i) => retrieved(i + 1, text));
const QUERY = { text: "How does retrieval work?" };

describe("TemplateContextAssembler", () => {
  describe("numbering and citations", () => {
    it("numbers sources from 1 and cites the page and section", () => {
      const result = assembler().assemble(QUERY, [
        retrieved(1, "First passage text.", [41, 42], ["Chapter 3", "3.2 Embeddings"]),
        retrieved(2, "Second passage text different.", [7, 7]),
      ]);
      expect(result.system).toContain(
        "[1] Chapter 3 > 3.2 Embeddings (pp. 41-42)\nFirst passage text.",
      );
      expect(result.system).toContain("[2] (p. 7)\nSecond passage text different.");
      expect(result.citations.map((c) => c.index)).toEqual([1, 2]);
      expect(result.citations[0]).toMatchObject({
        pageStart: 41,
        pageEnd: 42,
        quote: "First passage text.",
        docId: DOC,
      });
    });

    it("keeps citations in step with the prompt order under sandwich", () => {
      const result = assembler({ ordering: "sandwich" }).assemble(QUERY, ranked);
      result.included.forEach((item, position) => {
        expect(result.citations[position]?.chunkId).toBe(item.chunk.id);
        expect(result.citations[position]?.index).toBe(position + 1);
        expect(result.system).toContain(
          `[${(position + 1).toString()}] (p. ${item.rank.toString()})`,
        );
      });
    });

    it("sends the question unchanged as the user message", () => {
      expect(assembler().assemble({ text: "  Why?  " }, ranked).user).toBe("  Why?  ");
    });
  });

  describe("ordering", () => {
    const rankOrder = (ordering: OrderingName) =>
      assembler({ ordering })
        .assemble(QUERY, ranked)
        .included.map((c) => c.rank);

    it("relevance puts the best first", () => {
      expect(rankOrder("relevance")).toEqual([1, 2, 3, 4, 5]);
    });

    it("sandwich puts the best first and the second best last", () => {
      expect(rankOrder("sandwich")).toEqual([1, 3, 5, 4, 2]);
    });

    it("does not depend on the order the chunks arrive in", () => {
      const shuffled = [ranked[3], ranked[0], ranked[4], ranked[2], ranked[1]] as RetrievedChunk[];
      const result = assembler({ ordering: "sandwich" }).assemble(QUERY, shuffled);
      expect(result.included.map((c) => c.rank)).toEqual([1, 3, 5, 4, 2]);
    });
  });

  describe("near-duplicates", () => {
    const original = "Embeddings map text to vectors so that similar meanings sit close together";

    it("drops the lower-ranked copy and says why", () => {
      const copy = retrieved(2, `${original} indeed`);
      const result = assembler().assemble(QUERY, [
        retrieved(1, original),
        copy,
        ranked[1] as RetrievedChunk,
      ]);
      expect(result.included.map((c) => c.rank)).toEqual([1, 2]);
      expect(result.dropped).toEqual([{ chunk: copy, reason: "duplicate" }]);
    });

    it("can be turned stricter or looser", () => {
      const partial = retrieved(2, `${original} and then more new words follow here`);
      const input = [retrieved(1, original), partial];
      expect(assembler({ duplicateThreshold: 0.4 }).assemble(QUERY, input).included).toHaveLength(
        1,
      );
      expect(assembler({ duplicateThreshold: 1 }).assemble(QUERY, input).included).toHaveLength(2);
    });
  });

  describe("token budget", () => {
    const tokens = (text: string) => wordTokenizer().count(text);

    it("never exceeds the budget, whatever the ordering", () => {
      for (const ordering of ["relevance", "sandwich"] as const) {
        for (const budgetTokens of [5, 20, 40, 60, 100]) {
          const result = assembler({ budgetTokens, ordering }).assemble(QUERY, ranked);
          const block = result.included.length
            ? result.system.slice(result.system.indexOf("Sources:\n") + "Sources:\n".length)
            : "";
          expect(result.sourceTokens).toBeLessThanOrEqual(budgetTokens);
          expect(tokens(block)).toBeLessThanOrEqual(budgetTokens);
        }
      }
    });

    it("keeps the best chunks and drops the weakest when the budget is short", () => {
      const result = assembler({ budgetTokens: 40 }).assemble(QUERY, ranked);
      expect(result.included.map((c) => c.rank)).toEqual(
        [1, 2, 3].slice(0, result.included.length),
      );
      expect(result.dropped.every((d) => d.reason === "over-budget")).toBe(true);
      expect(result.included.length + result.dropped.length).toBe(ranked.length);
    });

    it("skips a chunk that is too big but still uses a smaller one after it", () => {
      const huge = retrieved(
        2,
        Array.from({ length: 200 }, (_, i) => `word${i.toString()}`).join(" "),
      );
      const result = assembler({ budgetTokens: 60 }).assemble(QUERY, [
        ranked[0] as RetrievedChunk,
        huge,
        ranked[2] as RetrievedChunk,
      ]);
      expect(result.included.map((c) => c.rank)).toEqual([1, 3]);
      expect(result.dropped).toEqual([{ chunk: huge, reason: "over-budget" }]);
    });

    it("rebuilds the numbering after dropping, so there are no gaps", () => {
      const result = assembler({ budgetTokens: 40, ordering: "sandwich" }).assemble(QUERY, ranked);
      expect(result.citations.map((c) => c.index)).toEqual(result.included.map((_, i) => i + 1));
    });

    it("reports the budget it was given", () => {
      expect(assembler({ budgetTokens: 321 }).assemble(QUERY, ranked).budget).toBe(321);
    });
  });

  describe("edge cases", () => {
    it("says there are no sources when retrieval found nothing", () => {
      const result = assembler().assemble(QUERY, []);
      expect(result.system).toContain(NO_SOURCES);
      expect(result.included).toEqual([]);
      expect(result.citations).toEqual([]);
      expect(result.sourceTokens).toBe(0);
    });

    it("says there are no sources when nothing fits, and reports every chunk dropped", () => {
      const result = assembler({ budgetTokens: 2 }).assemble(QUERY, ranked);
      expect(result.system).toContain(NO_SOURCES);
      expect(result.dropped).toHaveLength(ranked.length);
    });

    it("keeps $ patterns in a passage as they are", () => {
      const text = "Costs $& and $1 and $` stay literal in the prompt.";
      expect(assembler().assemble(QUERY, [retrieved(1, text)]).system).toContain(text);
    });

    it("accounts for every input chunk exactly once", () => {
      const result = assembler({ budgetTokens: 40 }).assemble(QUERY, [
        ...ranked,
        retrieved(6, PASSAGES[0] as string),
      ]);
      const seen = [...result.included, ...result.dropped.map((d) => d.chunk)].map((c) => c.rank);
      expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it("is deterministic", () => {
      const a = assembler({ ordering: "sandwich" }).assemble(QUERY, ranked);
      const b = assembler({ ordering: "sandwich" }).assemble(QUERY, ranked);
      expect(b).toEqual(a);
    });

    it("rejects a blank question", () => {
      expect(() => assembler().assemble({ text: "  " }, ranked)).toThrow(/blank question/);
    });

    it.each([0, -1, 1.5, Number.NaN])("rejects the budget %s", (budgetTokens) => {
      expect(() => assembler({ budgetTokens })).toThrow(/whole number of tokens/);
    });

    it.each([0, -0.5, 1.1])("rejects the duplicate threshold %s", (duplicateThreshold) => {
      expect(() => assembler({ duplicateThreshold })).toThrow(/duplicate threshold/);
    });
  });

  describe("versioning", () => {
    it("names the prompt version, taken from the template file", () => {
      expect(assembler().assemble(QUERY, ranked).promptVersion).toBe("rag-system@v1");
    });
  });

  // The assembled prompts are pinned, so a change to the wording or the layout shows up in review.
  // A changed prompt must come with a new version file, not a quiet edit of v1.
  describe("snapshots", () => {
    const sections = [
      retrieved(1, PASSAGES[0] as string, [41, 42], ["Chapter 3 Embeddings", "3.2 Dense vectors"]),
      retrieved(2, PASSAGES[1] as string, [58, 58], ["Chapter 4 Keyword search"]),
      retrieved(3, PASSAGES[2] as string, [63, 64], ["Chapter 5 Hybrid retrieval"]),
      retrieved(4, PASSAGES[3] as string, [71, 71], ["Chapter 6 Reranking"]),
    ];

    it("relevance-first", () => {
      const result = assembler({ ordering: "relevance" }).assemble(QUERY, sections);
      expect(result.system).toMatchSnapshot();
    });

    it("sandwich", () => {
      const result = assembler({ ordering: "sandwich" }).assemble(QUERY, sections);
      expect(result.system).toMatchSnapshot();
    });

    it("no sources", () => {
      expect(assembler().assemble(QUERY, []).system).toMatchSnapshot();
    });
  });
});
