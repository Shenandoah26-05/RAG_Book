import type { Chunk } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import type { ChunkStats } from "./chunk-stats.js";

/** FNV-1a: a small, stable hash of a string, used to turn "doc + strategy" into a seed. */
export function seedFrom(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: a tiny seeded generator that gives numbers in [0, 1). */
function randomFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Picks up to `count` different chunks "at random" but repeatably: the same chunks and the same seed
 * always give the same picks, so a report can be compared with an earlier one. The picks come back
 * in document order.
 */
export function sampleChunks(chunks: readonly Chunk[], count: number, seed: number): Chunk[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `sample count must be a whole number of 0 or more, got ${String(count)}`,
    );
  }
  const random = randomFrom(seed);
  const indices = chunks.map((_, index) => index);
  const wanted = Math.min(count, indices.length);
  // partial Fisher-Yates: the first `wanted` places end up holding the picks
  for (let i = 0; i < wanted; i++) {
    const j = i + Math.floor(random() * (indices.length - i));
    [indices[i], indices[j]] = [indices[j] ?? 0, indices[i] ?? 0];
  }
  return indices
    .slice(0, wanted)
    .sort((a, b) => a - b)
    .map((index) => chunks[index] as Chunk);
}

const BAR_WIDTH = 30;

/** One line per bucket, like `40-79 | ████████ 12`. Empty when there are no chunks. */
export function renderHistogram(stats: ChunkStats): string[] {
  const biggest = Math.max(0, ...stats.histogram.map((bucket) => bucket.count));
  const labels = stats.histogram.map((bucket) =>
    bucket.to - bucket.from <= 1
      ? bucket.from.toString()
      : `${bucket.from.toString()}-${(bucket.to - 1).toString()}`,
  );
  const labelWidth = Math.max(0, ...labels.map((label) => label.length));
  return stats.histogram.map((bucket, index) => {
    const bar = "█".repeat(
      bucket.count === 0 ? 0 : Math.max(1, Math.round((bucket.count / biggest) * BAR_WIDTH)),
    );
    return `${(labels[index] ?? "").padStart(labelWidth)} | ${bar} ${bucket.count.toString()}`;
  });
}

const round1 = (value: number): string => (Math.round(value * 10) / 10).toString();

/** The numbers line: `chunks: 41   tokens: min 12 / median 96 / mean 102.4 / max 180`. */
export function renderSummaryLine(stats: ChunkStats): string {
  return (
    `chunks: ${stats.count.toString()}   tokens: min ${stats.min.toString()} / ` +
    `median ${round1(stats.median)} / mean ${round1(stats.mean)} / max ${stats.max.toString()}`
  );
}

export interface ChunkReportInput {
  readonly docId: string;
  readonly title: string;
  readonly strategy: string;
  readonly tokenizer: string;
  readonly maxTokens: number;
  readonly overlapTokens: number;
  readonly stats: ChunkStats;
  /** Every chunk, in document order; `stats.sizes` has the token size of each. */
  readonly chunks: readonly Chunk[];
}

/** A passage on one line, with line breaks made visible. */
const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, " ⏎ ");

/** A fenced block that survives backticks in the text by using a longer fence. */
function fenced(text: string): string[] {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return [fence, text, fence];
}

/**
 * The markdown file written next to the processed document, for reading every chunk the strategy
 * produced: settings, size statistics, then each chunk with where it came from.
 */
export function renderChunkReport(input: ChunkReportInput): string {
  const { stats, chunks } = input;
  const lines: string[] = [
    `# Chunks: ${input.strategy} on "${input.title}"`,
    "",
    `- document: \`${input.docId}\``,
    `- strategy: \`${input.strategy}\` (maxTokens ${input.maxTokens.toString()}, overlapTokens ${input.overlapTokens.toString()})`,
    `- tokenizer: \`${input.tokenizer}\``,
    `- ${renderSummaryLine(stats)}`,
    "",
    "## Token sizes",
    "",
  ];
  if (stats.count === 0) {
    lines.push("No chunks: the document has no text.", "");
  } else {
    lines.push("```", ...renderHistogram(stats), "```", "");
  }
  lines.push("## Chunks", "");
  chunks.forEach((chunk, index) => {
    const { metadata } = chunk;
    const pages =
      metadata.pageStart === metadata.pageEnd
        ? `page ${metadata.pageStart.toString()}`
        : `pages ${metadata.pageStart.toString()}-${metadata.pageEnd.toString()}`;
    lines.push(
      `### ${(index + 1).toString()}. ${(stats.sizes[index] ?? 0).toString()} tokens, ${pages}`,
      "",
      `- section: ${metadata.sectionPath.length === 0 ? "(none)" : metadata.sectionPath.join(" > ")}`,
      `- span: [${metadata.charStart.toString()}, ${metadata.charEnd.toString()})`,
      `- id: \`${chunk.id}\``,
    );
    if (chunk.embedText !== undefined) lines.push(`- embedText: ${oneLine(chunk.embedText)}`);
    lines.push("", ...fenced(chunk.text), "");
  });
  return lines.join("\n");
}
