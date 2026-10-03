import { describe, expect, it } from "vitest";
import type { Cleaner } from "../../core/index.js";
import { CleaningChain } from "./cleaning-chain.js";
import { DehyphenateCleaner } from "./dehyphenate-cleaner.js";
import { HeaderFooterCleaner } from "./header-footer-cleaner.js";
import { expectConsistent, makeDocument, pageTexts } from "./make-document.testing.js";
import { PageNumberCleaner } from "./page-number-cleaner.js";
import { UnicodeCleaner } from "./unicode-cleaner.js";

const SHY = String.fromCodePoint(0xad);
const FI = String.fromCodePoint(0xfb01);

describe("CleaningChain", () => {
  it("returns the document unchanged when it has no cleaners", () => {
    const doc = makeDocument(["x"]);
    expect(new CleaningChain([]).clean(doc)).toBe(doc);
  });

  it("runs cleaners in order, each on the result of the last", () => {
    const calls: string[] = [];
    const spy = (name: string): Cleaner => ({
      name,
      clean: (doc) => {
        calls.push(name);
        return doc;
      },
    });
    new CleaningChain([spy("a"), spy("b"), spy("c")]).clean(makeDocument(["x"]));
    expect(calls).toEqual(["a", "b", "c"]);
  });

  it("is itself a Cleaner, so chains can be nested", () => {
    const inner = new CleaningChain([new DehyphenateCleaner()]);
    const outer = new CleaningChain([new UnicodeCleaner(), inner]);
    expect(pageTexts(outer.clean(makeDocument(["a vec-\ntor"])))).toEqual(["a vector"]);
  });

  it("order matters: a soft hyphen is only joined if the unicode cleaner runs first", () => {
    const doc = makeDocument([`the vec${SHY}\ntors`]);
    const unicodeFirst = new CleaningChain([new UnicodeCleaner(), new DehyphenateCleaner()]);
    const dehyphenFirst = new CleaningChain([new DehyphenateCleaner(), new UnicodeCleaner()]);

    expect(pageTexts(unicodeFirst.clean(doc))).toEqual(["the vectors"]);
    expect(pageTexts(dehyphenFirst.clean(doc))).toEqual(["the vec-\ntors"]);
  });

  it("cleans a noisy document end to end and keeps every span consistent", () => {
    const pages = [
      `The Handbook\n${FI}rst chapter on vec-\ntors   and  more\n\n1`,
      `The Handbook\nsecond  page about em-\nbeddings\n\n2`,
      `The Handbook\nthird page\n\n3`,
      `The Handbook\nlast page\n\n4`,
    ];
    const chain = new CleaningChain([
      new UnicodeCleaner(),
      new PageNumberCleaner(),
      new HeaderFooterCleaner(),
      new DehyphenateCleaner(),
    ]);
    const cleaned = chain.clean(makeDocument(pages));

    expect(pageTexts(cleaned)).toEqual([
      "first chapter on vectors and more",
      "second page about embeddings",
      "third page",
      "last page",
    ]);
    expectConsistent(cleaned);
  });

  it("does not change the document it was given", () => {
    const doc = makeDocument([`${FI}x`]);
    new CleaningChain([new UnicodeCleaner()]).clean(doc);
    expect(pageTexts(doc)).toEqual([`${FI}x`]);
  });
});
