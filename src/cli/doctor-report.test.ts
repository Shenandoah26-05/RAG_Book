import { describe, expect, it } from "vitest";
import type { CheckResult } from "../pipeline/index.js";
import { formatReport, hasFailures } from "./doctor-report.js";

const OK: CheckResult = {
  name: "Ollama is reachable",
  status: "ok",
  detail: "http://127.0.0.1:11434",
};
const MISSING: CheckResult = {
  name: "Model llama3.2 (generation)",
  status: "fail",
  detail: "not installed",
  fix: "ollama pull llama3.2",
};

describe("formatReport", () => {
  it("prints one line per check and a fix line under each failure", () => {
    expect(formatReport([OK, MISSING])).toBe(
      [
        "RAG Book doctor",
        "",
        "[ ok ] Ollama is reachable: http://127.0.0.1:11434",
        "[FAIL] Model llama3.2 (generation): not installed",
        "       fix: ollama pull llama3.2",
        "",
        "1 problem(s) to fix.",
      ].join("\n"),
    );
  });

  it("says so when everything passes", () => {
    expect(formatReport([OK])).toContain("Everything needed is in place.");
  });

  it("marks skipped checks", () => {
    const skipped: CheckResult = { name: "Model x", status: "skip", detail: "cannot check" };
    expect(formatReport([skipped])).toContain("[skip] Model x: cannot check");
  });
});

describe("hasFailures", () => {
  it("is true only when a check failed (skips do not count)", () => {
    expect(hasFailures([OK, MISSING])).toBe(true);
    expect(hasFailures([OK, { name: "x", status: "skip", detail: "" }])).toBe(false);
    expect(hasFailures([])).toBe(false);
  });
});
