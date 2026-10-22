import type { RegressionReport } from "./compare.js";

const num = (value: number): string => value.toFixed(3);
const signed = (value: number): string => `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;

/** The check's result as text for a terminal, ending with what to do about it. */
export function describeRegression(report: RegressionReport): string {
  const k = report.k.toString();
  const lines: string[] = [];

  if (report.verdict === "invalid") {
    lines.push("Smoke check could not compare this run with the baseline:");
    for (const problem of report.problems) lines.push(`  - ${problem}`);
    lines.push(
      "If the dataset or k changed on purpose, record a new baseline: pnpm eval:smoke --update-baseline",
    );
    return lines.join("\n");
  }

  lines.push(
    `recall@${k}: ${num(report.recall)}  baseline ${num(report.baselineRecall)}  ` +
      `change ${signed(-report.drop)}  allowed drop ${num(report.margin)}`,
  );
  if (report.worse.length > 0) {
    lines.push("Worse:");
    for (const c of report.worse)
      lines.push(`  ${c.questionId}  ${num(c.before)} -> ${num(c.after)}`);
  }
  if (report.better.length > 0) {
    lines.push("Better:");
    for (const c of report.better)
      lines.push(`  ${c.questionId}  ${num(c.before)} -> ${num(c.after)}`);
  }
  for (const note of report.notes) lines.push(`Note: ${note}.`);
  lines.push(
    report.verdict === "pass"
      ? "PASS: retrieval is no worse than the baseline."
      : `FAIL: recall@${k} fell ${num(report.drop)}, more than the ${num(report.margin)} allowed. ` +
          "Fix the change, or if the drop is intended, run pnpm eval:smoke --update-baseline and say why in the PR.",
  );
  return lines.join("\n");
}
