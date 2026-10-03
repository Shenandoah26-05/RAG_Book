import type { Cleaner, ParsedDocument } from "../../core/index.js";
import { char, codePoint, escape, HYPHEN_VARIANTS, range, SOFT_HYPHEN } from "./characters.js";
import { editDocument } from "./page-edits.js";
import type { TextEdit } from "./page-edits.js";

const INVISIBLE = [range(0x200b, 0x200d), codePoint(0x2060), codePoint(0xfeff)];
const SPACES = [
  " ",
  escape("t"),
  codePoint(0xa0),
  codePoint(0x1680),
  range(0x2000, 0x200a),
  codePoint(0x202f),
  codePoint(0x205f),
  codePoint(0x3000),
];

/** Presentation forms that PDFs use for letter pairs, and what they stand for. */
const LIGATURES: ReadonlyMap<string, string> = new Map([
  [char(0xfb00), "ff"],
  [char(0xfb01), "fi"],
  [char(0xfb02), "fl"],
  [char(0xfb03), "ffi"],
  [char(0xfb04), "ffl"],
  [char(0xfb05), "st"],
  [char(0xfb06), "st"],
]);

const n = escape("n");
/** One line break of any kind: Windows, old Mac or Unix. */
const BREAK = `(?:${escape("r")}${n}?|${n})`;
const BREAKS = new RegExp(BREAK, "g");

/** Everything this cleaner may rewrite, tried in this order at each position. */
const NOISE = new RegExp(
  [
    `^${BREAK}+`, // line breaks at the start of the page
    `${BREAK}+$`, // line breaks at the end of the page
    `${BREAK}{3,}`, // runs of blank lines
    `${escape("r")}${n}?`, // Windows or old Mac line endings
    `[${codePoint(SOFT_HYPHEN)}${INVISIBLE.join("")}]`, // soft hyphen and invisible characters
    `[${HYPHEN_VARIANTS.map(codePoint).join("")}]`, // typographic hyphens
    `[${range(0xfb00, 0xfb06)}]`, // ligatures
    `[${SPACES.join("")}]+`, // runs of spaces of any kind
    `${escape("p{L}")}${escape("p{M}")}+`, // a letter followed by separate accent marks
  ].join("|"),
  "gu",
);

const INVISIBLE_CHAR = new RegExp(`^[${INVISIBLE.join("")}]$`, "u");

function replacementFor(match: string, index: number, text: string): string {
  const first = match[0] ?? "";
  const after = text[index + match.length];
  const lineEnds = after === "\n" || after === "\r";

  if (first === "\n" || first === "\r") {
    if (index === 0 || after === undefined) return ""; // the start or end of the page
    return (match.match(BREAKS)?.length ?? 0) >= 3 ? "\n\n" : "\n";
  }
  if (first === char(SOFT_HYPHEN)) return lineEnds ? "-" : ""; // only visible at a line break
  if (INVISIBLE_CHAR.test(first)) return "";
  if (HYPHEN_VARIANTS.includes(first.codePointAt(0) ?? 0)) return "-";
  const ligature = LIGATURES.get(first);
  if (ligature !== undefined) return ligature;
  if (/\p{L}/u.test(first)) return match.normalize("NFC");
  return lineEnds || after === undefined ? "" : " "; // a run of spaces
}

/**
 * Normalises characters and whitespace: splits ligatures (the "fi" glyph becomes "fi"), joins
 * letters with their accents, drops soft hyphens and invisible characters, turns odd spaces and
 * runs of spaces into one space, and trims blank lines and spaces at line ends. A soft hyphen at
 * the end of a line becomes a visible hyphen, so de-hyphenation can join the word. Visible text is
 * otherwise kept.
 */
export class UnicodeCleaner implements Cleaner {
  readonly name = "unicode";

  clean(doc: ParsedDocument): ParsedDocument {
    const plan = doc.pages.map((page) => {
      const edits: TextEdit[] = [];
      for (const found of page.text.matchAll(NOISE)) {
        const match = found[0];
        const replacement = replacementFor(match, found.index, page.text);
        if (replacement !== match) {
          edits.push({ start: found.index, end: found.index + match.length, replacement });
        }
      }
      return edits;
    });
    return editDocument(doc, plan);
  }
}
