import { describe, expect, it } from "vitest";
import { parseIngestArgs } from "./ingest-args.js";

describe("parseIngestArgs", () => {
  it("takes a file", () => {
    expect(parseIngestArgs(["data/raw/book.pdf"])).toEqual({
      file: "data/raw/book.pdf",
      force: false,
    });
  });

  it("takes --force", () => {
    expect(parseIngestArgs(["book.pdf", "--force"])).toEqual({ file: "book.pdf", force: true });
    expect(parseIngestArgs(["--force", "book.pdf"])).toEqual({ file: "book.pdf", force: true });
  });

  it("takes --out-dir, with a space or an equals sign", () => {
    expect(parseIngestArgs(["book.pdf", "--out-dir", "out"])).toEqual({
      file: "book.pdf",
      force: false,
      outDir: "out",
    });
    expect(parseIngestArgs(["book.pdf", "--out-dir=out/here"])).toEqual({
      file: "book.pdf",
      force: false,
      outDir: "out/here",
    });
  });

  it("skips config overrides, and the value that follows them", () => {
    expect(parseIngestArgs(["--ingestion.loader", "unpdf", "book.pdf"])).toEqual({
      file: "book.pdf",
      force: false,
    });
    expect(parseIngestArgs(["book.pdf", "--chunking.max-tokens=300", "--force"])).toEqual({
      file: "book.pdf",
      force: true,
    });
  });

  it("does not swallow the file name when an override is bare", () => {
    expect(parseIngestArgs(["--rerank.enabled", "--force", "book.pdf"])).toEqual({
      file: "book.pdf",
      force: true,
    });
  });

  it("reports a missing file", () => {
    expect(parseIngestArgs([])).toEqual({ error: "No file given" });
    expect(parseIngestArgs(["--force"])).toEqual({ error: "No file given" });
  });

  it("reports an unknown option", () => {
    expect(parseIngestArgs(["book.pdf", "--frce"])).toEqual({ error: "Unknown option --frce" });
  });

  it("reports a second file", () => {
    expect(parseIngestArgs(["a.pdf", "b.pdf"])).toMatchObject({
      error: expect.stringContaining("one file") as string,
    });
  });

  it("reports --out-dir without a folder", () => {
    expect(parseIngestArgs(["book.pdf", "--out-dir"])).toEqual({
      error: "--out-dir needs a folder",
    });
    expect(parseIngestArgs(["book.pdf", "--out-dir", "--force"])).toEqual({
      error: "--out-dir needs a folder",
    });
  });
});
