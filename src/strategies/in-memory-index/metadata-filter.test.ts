import { describe, expect, it } from "vitest";
import type { ChunkMetadata, DocId, MetadataFilter } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { assertValidFilter, matchesFilter } from "./metadata-filter.js";

const meta = (overrides: Partial<ChunkMetadata> = {}): ChunkMetadata => ({
  docId: "doc-a" as DocId,
  pageStart: 4,
  pageEnd: 6,
  sectionPath: [],
  charStart: 0,
  charEnd: 10,
  strategy: "recursive",
  ...overrides,
});

describe("matchesFilter", () => {
  it("allows everything for an empty filter", () => {
    expect(matchesFilter(meta(), [])).toBe(true);
  });

  it("equals: the field must be exactly the value", () => {
    expect(matchesFilter(meta(), [{ kind: "equals", field: "docId", value: "doc-a" }])).toBe(true);
    expect(matchesFilter(meta(), [{ kind: "equals", field: "docId", value: "doc-b" }])).toBe(false);
    expect(matchesFilter(meta(), [{ kind: "equals", field: "strategy", value: "doc-a" }])).toBe(
      false,
    );
  });

  it("in: the field must be one of the values, and an empty list matches nothing", () => {
    const strategy = (values: string[]): MetadataFilter => [
      { kind: "in", field: "strategy", values },
    ];
    expect(matchesFilter(meta(), strategy(["fixed-size", "recursive"]))).toBe(true);
    expect(matchesFilter(meta(), strategy(["fixed-size"]))).toBe(false);
    expect(matchesFilter(meta(), strategy([]))).toBe(false);
  });

  it.each([
    [{ from: 4, to: 6 }, true],
    [{ from: 5, to: 5 }, true], // inside a multi-page chunk
    [{ from: 6 }, true], // touches on the last page
    [{ to: 4 }, true], // touches on the first page
    [{ from: 1, to: 3 }, false],
    [{ from: 7 }, false],
    [{ to: 3 }, false],
    [{}, true], // open on both ends
  ])("pageRange %j on a chunk on pages 4 to 6 -> %s", (range, expected) => {
    expect(matchesFilter(meta(), [{ kind: "pageRange", ...range }])).toBe(expected);
  });

  it("needs every clause to hold", () => {
    const filter: MetadataFilter = [
      { kind: "equals", field: "docId", value: "doc-a" },
      { kind: "pageRange", from: 6 },
    ];
    expect(matchesFilter(meta(), filter)).toBe(true);
    expect(matchesFilter(meta({ docId: "doc-b" as DocId }), filter)).toBe(false);
    expect(matchesFilter(meta({ pageStart: 1, pageEnd: 2 }), filter)).toBe(false);
  });
});

describe("assertValidFilter", () => {
  it("accepts filters that can be evaluated", () => {
    expect(() => {
      assertValidFilter([]);
      assertValidFilter([{ kind: "pageRange", from: 1, to: 1 }]);
      assertValidFilter([{ kind: "pageRange" }]);
      assertValidFilter([{ kind: "in", field: "docId", values: [] }]);
    }).not.toThrow();
  });

  it.each([{ from: 5, to: 3 }, { from: 0 }, { to: 2.5 }, { from: -1 }, { to: Number.NaN }])(
    "rejects the page range %j with INVALID_ARGUMENT",
    (range) => {
      try {
        assertValidFilter([{ kind: "pageRange", ...range }]);
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(RagError);
        expect((error as RagError).code).toBe("INVALID_ARGUMENT");
      }
    },
  );
});
