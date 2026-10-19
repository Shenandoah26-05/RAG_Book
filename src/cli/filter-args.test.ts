import { describe, expect, it } from "vitest";
import { FILTER_FLAGS, FILTER_USAGE, parseFilterArgs } from "./filter-args.js";

describe("parseFilterArgs", () => {
  it("gives an empty filter when there are no filter flags", () => {
    expect(parseFilterArgs([])).toEqual({ filter: [] });
    expect(parseFilterArgs(["what is a chunk", "--top-k", "5"])).toEqual({ filter: [] });
  });

  it("--doc and --strategy: one value is equals, several are in", () => {
    expect(parseFilterArgs(["--doc", "book"])).toEqual({
      filter: [{ kind: "equals", field: "docId", value: "book" }],
    });
    expect(parseFilterArgs(["--strategy=recursive", "--strategy", "fixed-size"])).toEqual({
      filter: [{ kind: "in", field: "strategy", values: ["recursive", "fixed-size"] }],
    });
  });

  it("--chapter is a one-title section path", () => {
    expect(parseFilterArgs(["--chapter", " Chapter 3 "])).toEqual({
      filter: [{ kind: "section", path: ["Chapter 3"] }],
    });
  });

  it("--section splits the path on >", () => {
    expect(parseFilterArgs(["--section=Chapter 3 > 3.2 Embeddings"])).toEqual({
      filter: [{ kind: "section", path: ["Chapter 3", "3.2 Embeddings"] }],
    });
  });

  it.each([
    ["12", { kind: "pageRange", from: 12, to: 12 }],
    ["10-20", { kind: "pageRange", from: 10, to: 20 }],
    ["10-", { kind: "pageRange", from: 10 }],
    ["-20", { kind: "pageRange", to: 20 }],
  ])("--pages %s", (raw, clause) => {
    expect(parseFilterArgs(["--pages", raw])).toEqual({ filter: [clause] });
  });

  it("combines every flag, leaves other arguments alone, in a fixed order", () => {
    expect(
      parseFilterArgs([
        "question",
        "--pages",
        "5-9",
        "--top-k",
        "3",
        "--chapter",
        "Chapter 2",
        "--doc",
        "book",
        "--strategy",
        "recursive",
      ]),
    ).toEqual({
      filter: [
        { kind: "equals", field: "docId", value: "book" },
        { kind: "equals", field: "strategy", value: "recursive" },
        { kind: "section", path: ["Chapter 2"] },
        { kind: "pageRange", from: 5, to: 9 },
      ],
    });
  });

  it.each([
    [["--doc"], "--doc needs a value"],
    [["--doc", "--pages", "3"], "--doc needs a value"],
    [["--chapter="], "--chapter needs a value"],
    [["--pages", "abc"], "is not a page range"],
    [["--pages", "0"], "is not a page range"],
    [["--pages", "9-3"], "is not a page range"],
    [["--pages", "-"], "is not a page range"],
    [["--pages", "5", "--pages", "6"], "--pages was given twice"],
    [["--chapter", "A", "--chapter", "B"], "--chapter was given twice"],
    [["--chapter", "A", "--section", "A > B"], "not both"],
    [["--section", "A > > B"], "blank title"],
  ])("rejects %j", (argv, message) => {
    const result = parseFilterArgs(argv);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain(message);
  });
});

describe("FILTER_USAGE", () => {
  it("documents every filter flag", () => {
    for (const flag of FILTER_FLAGS) expect(FILTER_USAGE).toContain(flag);
  });
});
