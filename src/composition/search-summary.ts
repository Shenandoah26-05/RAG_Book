import type { FilterClause, MetadataFilter, RetrievedChunk } from "../core/index.js";
import type { SearchReport } from "./build-searcher.js";

const SNIPPET_CHARS = 90;

/** The filter as a short line, e.g. `docId = 1f3a…; pages 10-20`. */
export function describeFilter(filter: MetadataFilter): string {
  if (filter.length === 0) return "none";
  return filter.map(describeClause).join("; ");
}

function describeClause(clause: FilterClause): string {
  switch (clause.kind) {
    case "equals":
      return `${clause.field} = ${clause.value}`;
    case "in":
      return `${clause.field} in (${clause.values.join(", ")})`;
    case "section":
      return `section ${clause.path.join(" > ")}`;
    case "pageRange":
      return `pages ${clause.from?.toString() ?? ""}-${clause.to?.toString() ?? ""}`;
  }
}

/** The text of a chunk on one line, cut to a snippet. */
function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= SNIPPET_CHARS ? flat : `${flat.slice(0, SNIPPET_CHARS - 1)}…`;
}

/** One ranked list as lines: rank, score, where in the book, and the start of the text. */
function ranked(results: readonly RetrievedChunk[]): string[] {
  if (results.length === 0) return ["  (nothing found)"];
  return results.map(({ chunk, score, rank }) => {
    const { pageStart, pageEnd, sectionPath } = chunk.metadata;
    const pages =
      pageStart === pageEnd
        ? `p.${pageStart.toString()}`
        : `p.${pageStart.toString()}-${pageEnd.toString()}`;
    const section = sectionPath.length === 0 ? "" : ` ${sectionPath.join(" > ")}`;
    return `  ${rank.toString().padStart(2)}  ${score.toFixed(4).padStart(8)}  ${pages}${section}  "${snippet(chunk.text)}"`;
  });
}

/**
 * What `pnpm search` prints: the index and settings, what each retriever found with ranks and
 * scores, the final list the pipeline would use, and the time spent.
 */
export function describeSearch(report: SearchReport): string {
  const { index, settings } = report;
  const fusion = settings.strategy === "hybrid" ? ` (fusion ${settings.fusion})` : "";
  const rerank = settings.rerank.enabled ? `rerank ${settings.rerank.strategy}` : "rerank off";
  const lines = [
    `Question: ${report.question}`,
    `Index:    ${index.namespace}: ${index.chunks.toString()} chunks, ${index.vectors.toString()} searchable` +
      (index.parents > 0 ? `, ${index.parents.toString()} parents` : "") +
      `, built ${index.createdAt}` +
      (index.gitCommit === null ? "" : ` at ${index.gitCommit.slice(0, 7)}`),
    `Settings: ${settings.strategy}${fusion}, ${rerank}, k = ${report.k.toString()}, filter: ${describeFilter(report.filter)}`,
  ];

  for (const retriever of report.retrievers) {
    lines.push(
      "",
      `${retriever.name}: ${retriever.durationMs.toString()} ms, ${retriever.results.length.toString()} found`,
      ...ranked(retriever.results),
    );
  }

  const same = report.retrievers.length === 1 && report.retrievers[0]?.name === report.retriever;
  lines.push(
    "",
    `${same ? "Result" : "Final"} (${report.retriever}): ${report.results.length.toString()} chunks`,
    ...ranked(report.results),
  );

  const times = report.retrievers.map((r) => `${r.name} ${r.durationMs.toString()} ms`);
  lines.push(
    "",
    `Time: index load ${index.loadMs.toString()} ms; ${times.join(", ")}; search total ${report.totalMs.toString()} ms`,
  );
  return lines.join("\n");
}

/** The whole report as JSON, for tests and scripts. */
export function searchToJson(report: SearchReport): string {
  return JSON.stringify(report, null, 2);
}
