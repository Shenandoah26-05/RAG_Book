import type { WireOutlineEntry } from "@rag-book/api-contract";
import { describe, expect, it } from "vitest";
import { clampPage, formatPageHash, parsePageHash, startPage } from "./location.js";
import { activeTrail, currentSectionTitle, indexOutline } from "./outline.js";
import { loadPosition, savePosition } from "./position.js";
import type { PositionStorage } from "./position.js";

const entry = (
  title: string,
  level: number,
  pageStart: number,
  pageEnd: number,
  children: WireOutlineEntry[] = [],
): WireOutlineEntry => ({ title, level, pageStart, pageEnd, children });

// Chapter 1 runs over pages 1 to 4 and chapter 2 starts on page 4, which they share.
const OUTLINE = indexOutline([
  entry("One", 1, 1, 4, [entry("One.A", 2, 1, 2), entry("One.B", 2, 3, 4)]),
  entry("Two", 1, 4, 9, [entry("Two.A", 2, 4, 6, [entry("Two.A.i", 3, 5, 6)])]),
]);

describe("indexOutline", () => {
  it("keys every entry by its position from the top", () => {
    expect(OUTLINE.map((n) => n.key)).toEqual(["0", "1"]);
    expect(OUTLINE[0]?.children.map((n) => n.key)).toEqual(["0.0", "0.1"]);
    expect(OUTLINE[1]?.children[0]?.children[0]?.key).toBe("1.0.0");
  });
});

describe("activeTrail", () => {
  const titles = (page: number): string[] => activeTrail(OUTLINE, page).map((n) => n.entry.title);

  it("goes from the chapter down to the deepest section holding the page", () => {
    expect(titles(1)).toEqual(["One", "One.A"]);
    expect(titles(3)).toEqual(["One", "One.B"]);
    expect(titles(5)).toEqual(["Two", "Two.A", "Two.A.i"]);
  });

  it("prefers the section that starts on a shared page", () => {
    // page 4 is the last page of chapter One and the first of Two: the reader is in Two
    expect(titles(4)).toEqual(["Two", "Two.A"]);
  });

  it("is empty for a page outside every section, and for no outline", () => {
    expect(titles(10)).toEqual([]);
    expect(activeTrail([], 1)).toEqual([]);
  });

  it("names the deepest section, or nothing", () => {
    expect(currentSectionTitle(OUTLINE, 5)).toBe("Two.A.i");
    expect(currentSectionTitle(OUTLINE, 99)).toBeUndefined();
  });
});

describe("page numbers in the address", () => {
  it("reads and writes #page=N", () => {
    expect(parsePageHash("#page=12")).toBe(12);
    expect(formatPageHash(12)).toBe("#page=12");
  });

  it("ignores anything else, including zero, signs, decimals and other keys", () => {
    for (const hash of ["", "#", "#page=0", "#page=-3", "#page=1.5", "#page=x", "#p=3", "page=3"]) {
      expect(parsePageHash(hash), hash).toBeUndefined();
    }
  });
});

describe("clampPage", () => {
  it("keeps a page inside the book", () => {
    expect(clampPage(0, 25)).toBe(1);
    expect(clampPage(-4, 25)).toBe(1);
    expect(clampPage(26, 25)).toBe(25);
    expect(clampPage(7, 25)).toBe(7);
  });

  it("makes whole numbers of fractions and handles a book of no pages and NaN", () => {
    expect(clampPage(7.9, 25)).toBe(7);
    expect(clampPage(5, 0)).toBe(1);
    expect(clampPage(Number.NaN, 25)).toBe(1);
  });
});

describe("startPage", () => {
  it("opens where the address says, before where the reader stopped", () => {
    expect(startPage({ hash: "#page=9", saved: 3, pageCount: 25 })).toBe(9);
  });

  it("opens where the reader stopped when the address says nothing", () => {
    expect(startPage({ hash: "", saved: 3, pageCount: 25 })).toBe(3);
  });

  it("opens at the first page with neither", () => {
    expect(startPage({ hash: "", saved: undefined, pageCount: 25 })).toBe(1);
  });

  it("ignores a page that is not in the book instead of clamping it", () => {
    // a stale bookmark to page 400 of a 25-page book is not a request for the last page
    expect(startPage({ hash: "#page=400", saved: 3, pageCount: 25 })).toBe(3);
    expect(startPage({ hash: "", saved: 400, pageCount: 25 })).toBe(1);
    expect(startPage({ hash: "", saved: 0, pageCount: 25 })).toBe(1);
  });
});

/** Storage held in a map, optionally broken. */
function memoryStorage(broken?: "read" | "write"): PositionStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => {
      if (broken === "read") throw new Error("blocked");
      return data.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (broken === "write") throw new Error("full");
      data.set(key, value);
    },
  };
}

describe("reading position", () => {
  it("is remembered per book", () => {
    const storage = memoryStorage();
    savePosition(storage, "book-a", 7);
    savePosition(storage, "book-b", 2);
    expect(loadPosition(storage, "book-a")).toBe(7);
    expect(loadPosition(storage, "book-b")).toBe(2);
    expect(loadPosition(storage, "book-c")).toBeUndefined();
  });

  it("is forgotten, not fatal, when storage is missing, blocked or full", () => {
    expect(loadPosition(undefined, "x")).toBeUndefined();
    expect(() => {
      savePosition(undefined, "x", 3);
    }).not.toThrow();
    expect(loadPosition(memoryStorage("read"), "x")).toBeUndefined();
    expect(() => {
      savePosition(memoryStorage("write"), "x", 3);
    }).not.toThrow();
  });

  it("treats a damaged value as no value", () => {
    const storage = memoryStorage();
    const key = "rag-book:position:v1:x";
    for (const bad of [
      "not json",
      "null",
      "[]",
      '{"page":"3"}',
      '{"page":0}',
      '{"page":1.5}',
      "{}",
    ]) {
      storage.data.set(key, bad);
      expect(loadPosition(storage, "x"), bad).toBeUndefined();
    }
  });
});
