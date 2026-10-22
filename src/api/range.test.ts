import { describe, expect, it } from "vitest";
import { parseRange } from "./range.js";

describe("parseRange", () => {
  it("sends the whole file when there is no header", () => {
    expect(parseRange(undefined, 100)).toEqual({ kind: "whole" });
  });

  it("reads a closed range, both ends inclusive", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({
      kind: "partial",
      range: { start: 0, end: 9 },
    });
  });

  it("reads an open-ended range as running to the end of the file", () => {
    expect(parseRange("bytes=90-", 100)).toEqual({
      kind: "partial",
      range: { start: 90, end: 99 },
    });
  });

  it("reads a suffix range as the last n bytes, and all of a short file", () => {
    expect(parseRange("bytes=-10", 100)).toEqual({
      kind: "partial",
      range: { start: 90, end: 99 },
    });
    expect(parseRange("bytes=-500", 100)).toEqual({
      kind: "partial",
      range: { start: 0, end: 99 },
    });
  });

  it("cuts an end past the file to the last byte", () => {
    expect(parseRange("bytes=50-5000", 100)).toEqual({
      kind: "partial",
      range: { start: 50, end: 99 },
    });
  });

  it("is unsatisfiable when it starts at or after the end, and for an empty suffix", () => {
    expect(parseRange("bytes=100-", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=250-300", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=-0", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=0-0", 0)).toEqual({ kind: "unsatisfiable" });
  });

  it("ignores what it cannot serve as one range: several ranges, another unit, nonsense", () => {
    for (const header of ["bytes=0-1,5-6", "items=0-1", "bytes=-", "bytes=a-b", "", "bytes=5-2"]) {
      expect(parseRange(header, 100), header).toEqual({ kind: "whole" });
    }
  });
});
