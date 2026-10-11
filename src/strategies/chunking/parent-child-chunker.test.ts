import { describe, expect, it } from "vitest";
import type { Chunk, Chunker, ParsedDocument } from "../../core/index.js";
import {
  checkChunker,
  chunkerFixtures,
  describeChunkerContract,
  formatViolations,
} from "../../testing/chunker-contract.testing.js";
import { wordTokenizer } from "../../testing/fake-tokenizer.testing.js";
import { makeDocument } from "../../testing/make-document.testing.js";
import { createChunk } from "./chunk-builder.js";
import { ParentChildChunker, recursiveParentChild } from "./parent-child-chunker.js";
import { RecursiveChunker } from "./recursive-chunker.js";

const tokenizer = wordTokenizer();
const count = (text: string): number => tokenizer.count(text);
const build = (parentTokens = 12, childTokens = 4) =>
  recursiveParentChild({ count, parentTokens, childTokens });

/** Three paragraphs of 8 words each, on two pages. */
const paragraph = (letter: string): string =>
  Array.from({ length: 8 }, (_, i) => `${letter}${(i + 1).toString()}`).join(" ");
const doc = makeDocument([`${paragraph("a")}\n\n${paragraph("b")}`, paragraph("c")]);

const parentsOf = async (chunker: Chunker, d: ParsedDocument): Promise<readonly Chunk[]> => {
  const parents = await chunker.parents?.(d);
  if (parents === undefined) throw new Error("the chunker has no parents()");
  return parents;
};

describeChunkerContract("parent-child", () => build(40, 10));

describe("ParentChildChunker: parents", () => {
  it("meets the chunker rules too, under their own strategy name", async () => {
    const chunker = build(40, 10);
    for (const { doc: fixture } of chunkerFixtures()) {
      const parents = await parentsOf(chunker, fixture);
      const violations = checkChunker(fixture, parents, "parent-child-parent");
      expect(violations, formatViolations(violations)).toEqual([]);
    }
  });

  it("cuts parents to the parent size", async () => {
    const parents = await parentsOf(build(), doc);
    expect(parents.length).toBeGreaterThan(1);
    for (const parent of parents) {
      expect(count(parent.text)).toBeLessThanOrEqual(12);
      expect(parent.parentId).toBeUndefined();
    }
  });
});

describe("ParentChildChunker: children", () => {
  it("cuts children to the child size, each inside the parent it names", async () => {
    const chunker = build();
    const children = await chunker.chunk(doc);
    const parents = new Map((await parentsOf(chunker, doc)).map((p) => [p.id, p]));

    expect(children.length).toBeGreaterThan(parents.size);
    for (const child of children) {
      expect(count(child.text)).toBeLessThanOrEqual(4);
      expect(child.metadata.strategy).toBe("parent-child");
      const parent = parents.get(child.parentId ?? ("" as never));
      expect(parent, "every child names an existing parent").toBeDefined();
      expect(child.metadata.charStart).toBeGreaterThanOrEqual(parent?.metadata.charStart ?? 0);
      expect(child.metadata.charEnd).toBeLessThanOrEqual(parent?.metadata.charEnd ?? 0);
    }
  });

  it("covers every parent: its children together hold all of its text", async () => {
    const chunker = build();
    const children = await chunker.chunk(doc);
    for (const parent of await parentsOf(chunker, doc)) {
      const mine = children.filter((c) => c.parentId === parent.id);
      expect(mine.map((c) => c.text).join(" ")).toBe(parent.text.replace(/\s+/g, " "));
    }
  });

  it("gives a parent no bigger than a child a different id from that child", async () => {
    const chunker = build(4, 3);
    const small = makeDocument(["w1 w2 w3"]);
    const [parent] = await parentsOf(chunker, small);
    const [child] = await chunker.chunk(small);

    expect(child?.text).toBe(parent?.text);
    expect(child?.id).not.toBe(parent?.id);
    expect(child?.parentId).toBe(parent?.id);
  });

  it("keeps child overlap inside a parent", async () => {
    const chunker = recursiveParentChild({
      count,
      parentTokens: 12,
      childTokens: 4,
      childOverlapTokens: 1,
    });
    const children = await chunker.chunk(doc);
    const violations = checkChunker(doc, children, "parent-child");
    expect(violations, formatViolations(violations)).toEqual([]);
  });
});

describe("ParentChildChunker: misuse", () => {
  it("is deterministic and leaves the document alone", async () => {
    const before = JSON.stringify(doc);
    const chunker = build();
    expect(await chunker.chunk(doc)).toEqual(await chunker.chunk(doc));
    expect(await parentsOf(chunker, doc)).toEqual(await parentsOf(chunker, doc));
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("rejects child sizes that do not fit inside the parent size", () => {
    expect(() => build(10, 10)).toThrowError(/childTokens/);
    expect(() => build(10, 0)).toThrowError(/childTokens/);
  });

  it("rejects overlapping parents", async () => {
    const overlapping: Chunker = {
      name: "overlapping",
      chunk: (d) =>
        Promise.resolve([
          createChunk(d, "overlapping", { start: 0, end: 20 }),
          createChunk(d, "overlapping", { start: 10, end: 30 }),
        ]),
    };
    const chunker = new ParentChildChunker({
      parentSplitter: overlapping,
      childSplitter: new RecursiveChunker({ maxTokens: 4, overlapTokens: 0, count }),
    });
    await expect(chunker.chunk(doc)).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("rejects a child outside the parent it was given", async () => {
    const wild: Chunker = {
      name: "wild",
      chunk: (d) => Promise.resolve([createChunk(d, "wild", { start: 0, end: d.text.length })]),
    };
    const big = makeDocument(["x ".repeat(100)]);
    const chunker = new ParentChildChunker({
      parentSplitter: {
        name: "halves",
        chunk: (d) => Promise.resolve([createChunk(d, "halves", { start: 0, end: 20 })]),
      },
      childSplitter: {
        name: "wild",
        chunk: () => wild.chunk(big),
      },
    });
    await expect(chunker.chunk(big)).rejects.toMatchObject({ code: "INTERNAL" });
  });
});
