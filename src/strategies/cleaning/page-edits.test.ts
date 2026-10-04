import { describe, expect, it } from "vitest";
import { RagError } from "../../shared/index.js";
import { makeDocument, expectConsistent, pageTexts } from "../../testing/make-document.testing.js";
import { applyEdits, editDocument } from "./page-edits.js";

describe("applyEdits", () => {
  it("applies replacements and deletions", () => {
    const { text } = applyEdits("hello big world", [
      { start: 5, end: 9, replacement: "" },
      { start: 0, end: 1, replacement: "J" },
    ]);
    expect(text).toBe("Jello world");
  });

  it("accepts edits in any order, and leaves a text with no edits alone", () => {
    expect(applyEdits("abc", []).text).toBe("abc");
    expect(
      applyEdits("abcdef", [
        { start: 4, end: 5, replacement: "X" },
        { start: 0, end: 1, replacement: "Y" },
      ]).text,
    ).toBe("YbcdXf");
  });

  it("maps positions before, after and between edits", () => {
    // "0123456789": delete [2,4), replace [6,7) with "XYZ"
    const applied = applyEdits("0123456789", [
      { start: 2, end: 4, replacement: "" },
      { start: 6, end: 7, replacement: "XYZ" },
    ]);
    expect(applied.text).toBe("014" + "5XYZ789");
    expect(applied.mapStart(0)).toBe(0); // before any edit
    expect(applied.mapStart(5)).toBe(3); // after the deletion
    expect(applied.mapStart(8)).toBe(8 - 2 + 2); // after both edits
    expect(applied.mapEnd(10)).toBe(10); // 2 characters deleted, 2 added: same length
  });

  it("maps the edges of an edit to the edges of its replacement", () => {
    const applied = applyEdits("ab--cd", [{ start: 2, end: 4, replacement: "" }]);
    expect(applied.mapStart(2)).toBe(2);
    expect(applied.mapEnd(2)).toBe(2);
    expect(applied.mapStart(4)).toBe(2);
    expect(applied.mapEnd(4)).toBe(2);
  });

  it("moves a range's start past, and its end before, a deleted region it overlaps", () => {
    // a range that starts inside the deleted [2,6) keeps only what follows; one that ends inside keeps what precedes
    const applied = applyEdits("0123456789", [{ start: 2, end: 6, replacement: "" }]);
    expect(applied.mapStart(4)).toBe(2);
    expect(applied.mapEnd(4)).toBe(2);
  });

  it("rejects overlapping or out-of-range edits", () => {
    const overlapping = [
      { start: 0, end: 3, replacement: "" },
      { start: 2, end: 4, replacement: "" },
    ];
    expect(() => applyEdits("abcdef", overlapping)).toThrow(RagError);
    expect(() => applyEdits("abc", [{ start: 2, end: 9, replacement: "" }])).toThrow(
      /out of range/,
    );
    expect(() => applyEdits("abc", [{ start: 2, end: 1, replacement: "" }])).toThrow(RagError);
  });
});

describe("editDocument", () => {
  it("returns the same document when there is nothing to change", () => {
    const doc = makeDocument(["one", "two"]);
    expect(editDocument(doc, [[], []])).toBe(doc);
    expect(editDocument(doc, [])).toBe(doc);
  });

  it("edits the right page and keeps every span consistent", () => {
    const doc = makeDocument(["first line\nsecond line", "third line\nfourth line"]);
    // delete "second line" and its break from page 1, and "third " from page 2
    const edited = editDocument(doc, [
      [{ start: 10, end: 22, replacement: "" }],
      [{ start: 0, end: 6, replacement: "" }],
    ]);

    expect(pageTexts(edited)).toEqual(["first line", "line\nfourth line"]);
    expectConsistent(edited);
    expect(edited.pageCount).toBe(2);
  });

  it("drops items that lose all their text and shortens items that lose part of it", () => {
    const doc = makeDocument(["keep me\ndelete me\nclip-this"]);
    const text = doc.pages[0]?.text ?? "";
    const edited = editDocument(doc, [
      [
        {
          start: text.indexOf("delete me"),
          end: text.indexOf("delete me") + "delete me\n".length,
          replacement: "",
        },
        { start: text.indexOf("-this"), end: text.length, replacement: "" },
      ],
    ]);

    expect(pageTexts(edited)).toEqual(["keep me\nclip"]);
    expect(edited.pages[0]?.items.map((i) => i.text)).toEqual(["keep me", "clip"]);
    expectConsistent(edited);
  });

  it("keeps position, size and font of surviving items", () => {
    const doc = makeDocument(["Title\nbody"], {
      fontSizeOf: (l) => (l === "Title" ? 24 : 12),
      isBold: (l) => l === "Title",
    });
    const edited = editDocument(doc, [[{ start: 0, end: 1, replacement: "t" }]]);
    expect(edited.pages[0]?.items[0]).toMatchObject({
      text: "title",
      fontSize: 24,
      isBold: true,
      x: 72,
    });
  });

  it("moves the spans of later pages when an earlier page changes length", () => {
    const doc = makeDocument(["aaaa", "bbbb\ncccc"]);
    const edited = editDocument(doc, [[{ start: 0, end: 3, replacement: "" }], []]);
    expect(pageTexts(edited)).toEqual(["a", "bbbb\ncccc"]);
    expect(edited.pages[1]?.span.start).toBe("a".length + 2);
    expectConsistent(edited);
  });

  it("refuses to run once sections exist, because their spans would go stale", () => {
    const doc = {
      ...makeDocument(["x"]),
      sections: [
        {
          title: "S",
          level: 1,
          pageStart: 1,
          pageEnd: 1,
          span: { start: 0, end: 1 },
          titleSpan: { start: 0, end: 1 },
          children: [],
        },
      ],
    };
    expect(() => editDocument(doc, [[{ start: 0, end: 1, replacement: "" }]])).toThrow(
      /before section detection/,
    );
  });

  it("does not change the original document", () => {
    const doc = makeDocument(["abc"]);
    editDocument(doc, [[{ start: 0, end: 1, replacement: "" }]]);
    expect(pageTexts(doc)).toEqual(["abc"]);
  });
});
