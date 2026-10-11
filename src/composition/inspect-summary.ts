import { renderHistogram, renderSummaryLine } from "../strategies/index.js";
import type { InspectResult } from "./build-inspect.js";

/** What `pnpm chunks` prints: the numbers, the size histogram, the samples and the report path. */
export function describeInspection(result: InspectResult): string {
  const lines = [
    `${result.strategy} on "${result.title}" (${result.docId})`,
    renderSummaryLine(result.stats),
    "",
    ...renderHistogram(result.stats),
  ];
  result.samples.forEach((chunk, index) => {
    const { metadata } = chunk;
    const section =
      metadata.sectionPath.length === 0 ? "" : `, ${metadata.sectionPath.join(" > ")}`;
    lines.push(
      "",
      `--- sample ${(index + 1).toString()} of ${result.samples.length.toString()}: ` +
        `page ${metadata.pageStart.toString()}${section}, chars [${metadata.charStart.toString()}, ${metadata.charEnd.toString()}) ---`,
      chunk.text,
    );
  });
  lines.push("", `Every chunk: ${result.reportPath}`);
  return lines.join("\n");
}
