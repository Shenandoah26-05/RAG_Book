import { describe, expect, it } from "vitest";
import { expectConsistent, makeDocument, pageTexts } from "../../testing/make-document.testing.js";
import { UnicodeCleaner } from "./unicode-cleaner.js";

// Special characters by code point, so none are hidden in this file.
const c = (code: number): string => String.fromCodePoint(code);
const SHY = c(0xad);
const NBSP = c(0xa0);
const ZWSP = c(0x200b);
const BOM = c(0xfeff);
const THIN = c(0x2009);
const HYPHEN = c(0x2010);
const FI = c(0xfb01);
const FFI = c(0xfb03);
const E_ACUTE = c(0xe9);
const ACUTE = c(0x301);

const clean = (text: string): string => {
  const doc = makeDocument([text]);
  const cleaned = new UnicodeCleaner().clean(doc);
  expectConsistent(cleaned);
  return cleaned.pages[0]?.text ?? "";
};

describe("UnicodeCleaner: before and after", () => {
  it.each([
    ["ligatures are split", `${FI}sh and o${FFI}ce`, "fish and office"],
    ["a non-breaking space becomes a space", `a${NBSP}b`, "a b"],
    ["thin and other odd spaces become a space", `a${THIN}b`, "a b"],
    ["a run of spaces becomes one", "a    b", "a b"],
    ["spaces and tabs mixed become one space", "a \t  b", "a b"],
    ["trailing spaces on a line are removed", "one   \ntwo \t\nthree", "one\ntwo\nthree"],
    ["a soft hyphen inside a word is dropped", `co${SHY}operate`, "cooperate"],
    ["a soft hyphen at a line end becomes a visible hyphen", `vec${SHY}\ntors`, "vec-\ntors"],
    ["zero-width characters and the byte order mark are dropped", `a${ZWSP}b${BOM}c`, "abc"],
    ["typographic hyphens become hyphens", `well${HYPHEN}known`, "well-known"],
    ["Windows line endings become newlines", "a\r\nb", "a\nb"],
    ["a lone carriage return becomes a newline", "a\rb", "a\nb"],
    ["trailing spaces before a Windows line ending are removed", "a  \r\nb", "a\nb"],
    ["blank lines made of Windows line endings are collapsed", "a\r\n\r\n\r\n\r\nb", "a\n\nb"],
    ["Windows and Unix line endings mixed are collapsed", "a  \r\n\n\n\nb", "a\n\nb"],
    ["three or more blank lines become one blank line", "a\n\n\n\nb", "a\n\nb"],
    ["blank lines at the start and end of a page are trimmed", "\n\nHello\n\n", "Hello"],
    ["a letter and its separate accent are joined", `cafe${ACUTE}`, `caf${E_ACUTE}`],
    ["text that needs nothing is left alone", "Plain text.\nTwo lines.", "Plain text.\nTwo lines."],
    ["one blank line between paragraphs is kept", "a\n\nb", "a\n\nb"],
    ["real accented letters are kept", `caf${E_ACUTE}`, `caf${E_ACUTE}`],
  ])("%s", (_name, before, after) => {
    expect(clean(before)).toBe(after);
  });

  it("is idempotent: cleaning twice changes nothing more", () => {
    const messy = `${FI}x${NBSP}${NBSP}y${SHY}\nz  \r\n\n\n\nend\n`;
    const once = new UnicodeCleaner().clean(makeDocument([messy]));
    expect(new UnicodeCleaner().clean(once)).toBe(once);
  });
});

describe("UnicodeCleaner: documents", () => {
  it("returns the same document when nothing needs cleaning", () => {
    const doc = makeDocument(["Clean page.", "Another clean page."]);
    expect(new UnicodeCleaner().clean(doc)).toBe(doc);
  });

  it("cleans every page and keeps items pointing at their text", () => {
    const doc = makeDocument([`${FI}rst${NBSP}page\nsecond  line`, `${FI}nal   page`]);
    const cleaned = new UnicodeCleaner().clean(doc);

    expect(pageTexts(cleaned)).toEqual(["first page\nsecond line", "final page"]);
    expect(cleaned.pages[0]?.items.map((i) => i.text)).toEqual(["first page", "second line"]);
    expectConsistent(cleaned);
  });

  it("keeps font size and weight of items", () => {
    const doc = makeDocument([`${FI}shing  guide\nbody`], {
      fontSizeOf: (line) => (line.includes("guide") ? 24 : 12),
      isBold: (line) => line.includes("guide"),
    });
    const heading = new UnicodeCleaner().clean(doc).pages[0]?.items[0];
    expect(heading).toMatchObject({ text: "fishing guide", fontSize: 24, isBold: true });
  });

  it("does not change the document it was given", () => {
    const doc = makeDocument([`${FI}x`]);
    new UnicodeCleaner().clean(doc);
    expect(doc.pages[0]?.text).toBe(`${FI}x`);
  });

  it("is named for the config value", () => {
    expect(new UnicodeCleaner().name).toBe("unicode");
  });
});
