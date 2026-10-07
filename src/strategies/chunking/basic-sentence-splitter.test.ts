import { describe, expect, it } from "vitest";
import { splitSentencesBasic } from "./basic-sentence-splitter.js";

const sentences = (text: string): string[] =>
  splitSentencesBasic(text).map((span) => text.slice(span.start, span.end));

describe("splitSentencesBasic", () => {
  it("splits after . ! and ? when a new sentence starts", () => {
    expect(sentences("One is here. Two is next! Is three? Yes 4 is.")).toEqual([
      "One is here.",
      "Two is next!",
      "Is three?",
      "Yes 4 is.",
    ]);
  });

  it("does not split on decimals or before a lowercase word", () => {
    expect(sentences("Pi is 3.14 roughly. See e.g. the table.")).toEqual([
      "Pi is 3.14 roughly.",
      "See e.g. the table.",
    ]);
  });

  it("always splits on a blank line, so no sentence crosses a page", () => {
    expect(sentences("no full stop here\n\nnext page starts")).toEqual([
      "no full stop here",
      "next page starts",
    ]);
  });

  it("returns spans without surrounding whitespace, and nothing for blank text", () => {
    expect(splitSentencesBasic("  Hello there.  ")).toEqual([{ start: 2, end: 14 }]);
    expect(splitSentencesBasic("  \n\n ")).toEqual([]);
    expect(splitSentencesBasic("")).toEqual([]);
  });

  it("covers every non-whitespace character exactly once", () => {
    const text = "First one. Second one.\n\nThird? Fourth!  Fifth";
    const covered = splitSentencesBasic(text)
      .map((s) => text.slice(s.start, s.end))
      .join("");
    expect(covered.replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
  });
});
