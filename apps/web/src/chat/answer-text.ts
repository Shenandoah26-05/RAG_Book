/** A piece of an answer: plain text, or a citation mark such as `[2]` or `[1, 3]`. */
export type AnswerSegment =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "cite";
      /** What was written, e.g. `[1, 3]`, kept so a mark that cannot be a chip is shown as written. */
      readonly raw: string;
      /** The source numbers inside it, in the order written. */
      readonly numbers: readonly number[];
    };

/**
 * `[1]`, `[12]`, `[1, 2]`: the marks the answer prompt asks the model to write. The same pattern the
 * server uses to check them (`citedNumbers`), so what is checked there is what becomes a chip here.
 */
const MARK = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

/**
 * Cuts an answer into text and citation marks, in order, so the marks can be drawn as buttons and
 * the rest left alone. Joining `text` and `raw` of every segment gives the answer back exactly.
 *
 * The answer arrives a few characters at a time, so it is cut again as it grows: a mark that is
 * still being written (`[1` or `[1,`) is just text until its `]` arrives, and then becomes a chip.
 */
export function splitAnswer(answer: string): readonly AnswerSegment[] {
  const segments: AnswerSegment[] = [];
  let cursor = 0;
  for (const match of answer.matchAll(MARK)) {
    if (match.index > cursor) {
      segments.push({ kind: "text", text: answer.slice(cursor, match.index) });
    }
    segments.push({
      kind: "cite",
      raw: match[0],
      numbers: (match[1] ?? "").split(",").map((part) => Number(part.trim())),
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < answer.length) segments.push({ kind: "text", text: answer.slice(cursor) });
  return segments;
}
