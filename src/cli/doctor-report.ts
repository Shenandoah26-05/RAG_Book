import type { CheckResult, CheckStatus } from "../pipeline/index.js";

const LABEL: Readonly<Record<CheckStatus, string>> = {
  ok: "[ ok ]",
  fail: "[FAIL]",
  skip: "[skip]",
};

/** Plain text, no colours or symbols, so it reads the same in any terminal. */
export function formatReport(results: readonly CheckResult[]): string {
  const lines = ["RAG Book doctor", ""];
  for (const { name, status, detail, fix } of results) {
    lines.push(`${LABEL[status]} ${name}: ${detail}`);
    if (fix !== undefined) lines.push(`       fix: ${fix}`);
  }

  const failed = results.filter((r) => r.status === "fail").length;
  lines.push(
    "",
    failed === 0 ? "Everything needed is in place." : `${failed.toString()} problem(s) to fix.`,
  );
  return lines.join("\n");
}

export function hasFailures(results: readonly CheckResult[]): boolean {
  return results.some((result) => result.status === "fail");
}
