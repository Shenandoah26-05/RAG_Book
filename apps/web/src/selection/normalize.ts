import { MAX_SELECTION_CHARS } from "@rag-book/api-contract";

/** A selected passage as it is sent: clean words, and whether it had to be cut. */
export interface SelectedPassage {
  readonly text: string;
  /** True when the reader selected more than a question may carry, and only the start is sent. */
  readonly truncated: boolean;
}

/**
 * What the browser gives for a selection on a page, as plain text for a question.
 *
 * A page is laid out in lines, so a selection comes back with a line break at the end of every line,
 * runs of spaces, soft hyphens, and a word split across two lines as `vec-` and `tors`. None of that
 * is the author's text. So: a word cut by a hyphen at the end of a line is joined (only when the next
 * line goes on in lower case, so a real dash or a list is left alone), line breaks become spaces, and
 * runs of whitespace become one. An empty result (a selection of only spaces) is undefined.
 *
 * A passage over `MAX_SELECTION_CHARS` is cut at the last space before the limit, so no word is
 * split, and `truncated` says so: the reader should know that only the start was sent.
 */
export function normalizeSelection(raw: string): SelectedPassage | undefined {
  const joined = raw
    .replace(/­/g, "")
    .replace(/([a-z])-[ \t]*\r?\n[ \t]*(?=[a-z])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (joined === "") return undefined;
  if (joined.length <= MAX_SELECTION_CHARS) return { text: joined, truncated: false };

  const head = joined.slice(0, MAX_SELECTION_CHARS);
  const lastSpace = head.lastIndexOf(" ");
  // a single enormous word has no space to cut at: cut it where the limit is
  const text = (lastSpace > MAX_SELECTION_CHARS / 2 ? head.slice(0, lastSpace) : head).trimEnd();
  return { text, truncated: true };
}
