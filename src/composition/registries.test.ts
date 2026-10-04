import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config/index.js";
import { RagError } from "../shared/index.js";
import { makeDocument, pageTexts } from "../testing/make-document.testing.js";
import { buildCleaner, cleanerNames } from "./registries.js";

const FI = String.fromCodePoint(0xfb01);

describe("buildCleaner", () => {
  it("knows the four cleaners by their config names", () => {
    expect(cleanerNames()).toEqual(["unicode", "page-numbers", "headers-footers", "dehyphenate"]);
  });

  it("builds a chain that runs the named cleaners", () => {
    const chain = buildCleaner(["unicode", "dehyphenate"]);
    expect(pageTexts(chain.clean(makeDocument([`${FI}x vec-\ntors`])))).toEqual(["fix vectors"]);
  });

  it("runs them in the order given", () => {
    const soft = `vec${String.fromCodePoint(0xad)}\ntors`;
    const doc = makeDocument([soft]);
    expect(pageTexts(buildCleaner(["unicode", "dehyphenate"]).clean(doc))).toEqual(["vectors"]);
    expect(pageTexts(buildCleaner(["dehyphenate", "unicode"]).clean(doc))).toEqual(["vec-\ntors"]);
  });

  it("builds a chain that does nothing from an empty list", () => {
    const doc = makeDocument(["x"]);
    expect(buildCleaner([]).clean(doc)).toBe(doc);
  });

  it("builds the default configuration's chain", () => {
    const chain = buildCleaner(DEFAULT_CONFIG.ingestion.cleaners);
    const pages = [
      `Head\n${FI}rst page  on vec-\ntors\n\n1`,
      "Head\nsecond page\n\n2",
      "Head\nthird page\n\n3",
    ];
    expect(pageTexts(chain.clean(makeDocument(pages)))).toEqual([
      "first page on vectors",
      "second page",
      "third page",
    ]);
  });

  it("rejects an unknown name and lists the ones that exist", () => {
    let error: unknown;
    try {
      buildCleaner(["unicode", "spellcheck"]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RagError);
    expect((error as RagError).code).toBe("CONFIG_INVALID");
    expect((error as RagError).message).toContain('"spellcheck"');
    expect((error as RagError).message).toContain("dehyphenate");
  });
});
