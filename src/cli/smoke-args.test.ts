import { describe, expect, it } from "vitest";
import { parseSmokeArgs } from "./smoke-args.js";

describe("parseSmokeArgs", () => {
  it("needs nothing: compare with the stored baseline", () => {
    expect(parseSmokeArgs([])).toEqual({ updateBaseline: false });
  });

  it("reads --update-baseline, the margin and the folders", () => {
    expect(
      parseSmokeArgs(["--update-baseline", "--margin", "0.1", "--baseline=b.json", "--out", "o"]),
    ).toEqual({ updateBaseline: true, margin: 0.1, baselineFile: "b.json", outDir: "o" });
  });

  it("accepts a margin of 0", () => {
    expect(parseSmokeArgs(["--margin", "0"])).toMatchObject({ margin: 0 });
  });

  it("refuses a margin outside 0 to 1, or not a number", () => {
    expect(parseSmokeArgs(["--margin", "2"])).toHaveProperty("error");
    expect(parseSmokeArgs(["--margin", "x"])).toHaveProperty("error");
  });

  it("refuses unknown options, stray arguments and flags without a value", () => {
    expect(parseSmokeArgs(["--nope"])).toEqual({ error: "Unknown option --nope" });
    expect(parseSmokeArgs(["file.json"])).toEqual({ error: "Unexpected argument file.json" });
    expect(parseSmokeArgs(["--margin"])).toEqual({ error: "--margin needs a value" });
  });
});
