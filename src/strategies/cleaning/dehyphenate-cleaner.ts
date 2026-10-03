import type { Cleaner, ParsedDocument } from "../../core/index.js";
import { codePoint, escape, HYPHEN_VARIANTS } from "./characters.js";
import { editDocument } from "./page-edits.js";

const letter = escape("p{L}");

/**
 * A hyphen at the end of a line, after at least two letters, where the next line carries on with a
 * lower-case letter: "vec-" then "tors". The next word starting in lower case is what tells a word
 * split by the typesetter apart from a real hyphen before a name or a heading.
 */
const SPLIT_WORD = new RegExp(
  `(?<=${letter}{2})[-${HYPHEN_VARIANTS.map(codePoint).join("")}][ ${escape("t")}]*${escape("n")}(?=${escape("p{Ll}")})`,
  "gu",
);

/**
 * Joins words that were split across a line break with a hyphen ("vec-" and "tors" become
 * "vectors"). Known limits: a real compound split at the hyphen ("state-" and "of-the-art") loses
 * its hyphen, and a word split across a page break is not joined, because no edit crosses pages.
 */
export class DehyphenateCleaner implements Cleaner {
  readonly name = "dehyphenate";

  clean(doc: ParsedDocument): ParsedDocument {
    const plan = doc.pages.map((page) =>
      [...page.text.matchAll(SPLIT_WORD)].map((found) => ({
        start: found.index,
        end: found.index + found[0].length,
        replacement: "",
      })),
    );
    return editDocument(doc, plan);
  }
}
