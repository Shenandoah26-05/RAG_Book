import type { IndexResult } from "../pipeline/index.js";

/** What `pnpm index` prints: what was built (or found), where it is, and the numbers. */
export function describeIndex(result: IndexResult): string {
  const { manifest } = result;
  const { counts, timingsMs } = manifest;
  const head =
    result.status === "skipped"
      ? `Index ${manifest.namespace} is up to date (built ${manifest.createdAt}); use --force to build again.`
      : `Built index ${manifest.namespace}.`;
  const steps = Object.entries(timingsMs)
    .map(([step, ms]) => `${step} ${ms.toString()} ms`)
    .join(", ");
  return [
    head,
    `  ${counts.documents.toString()} document(s), ${counts.chunks.toString()} chunks ` +
      `(${counts.vectors.toString()} searchable, ${counts.parents.toString()} parents)`,
    `  ${manifest.chunker.name} + ${manifest.embedder.modelId} (${manifest.embedder.dimensions.toString()} dimensions)`,
    `  ${steps}`,
    `  ${result.location}`,
  ].join("\n");
}
