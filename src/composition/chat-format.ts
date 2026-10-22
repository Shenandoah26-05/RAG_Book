import type { RagConfig } from "../config/index.js";
import type { AssembledPrompt, DroppedChunk } from "../core/index.js";
import type { StageRecord, TraceSnapshot } from "../shared/index.js";

const SNIPPET_CHARS = 90;

/** What `/help` prints. */
export const CHAT_HELP = [
  "Ask a question about the book and press Enter. The answer appears as it is written, followed by",
  "the sources it was given, with page numbers. Follow-up questions work: the chat remembers the",
  "last few turns.",
  "",
  "Commands:",
  "  /clear    forget the conversation, so the next question stands alone",
  "  /debug   show or hide what each stage did (timings, retrieval, dropped sources)",
  "  /config   show the active variant and settings",
  "  /help     show this text",
  "  /quit     leave (also /exit, or Ctrl+D)",
  "",
  "Ctrl+C stops an answer that is being written; at the prompt it leaves.",
].join("\n");

/** The text of a chunk on one line, cut to a snippet. */
function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= SNIPPET_CHARS ? flat : `${flat.slice(0, SNIPPET_CHARS - 1)}…`;
}

function pages(start: number, end: number): string {
  return start === end ? `p.${start.toString()}` : `p.${start.toString()}-${end.toString()}`;
}

/**
 * The numbers the answer cites: `[2]`, `[1][3]` and `[1, 2]` all count. A number is only a source
 * number here, so `[0]` or text like `[a]` is ignored.
 */
export function citedNumbers(answer: string): ReadonlySet<number> {
  const cited = new Set<number>();
  for (const [, inside] of answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const part of (inside ?? "").split(",")) cited.add(Number(part.trim()));
  }
  return cited;
}

/**
 * The sources the model was given, in prompt order, each with its page numbers and the start of its
 * text. A source the answer cites is marked `●`, one that was retrieved but not cited `○`, so a
 * reader can see both what the model had and what it used.
 */
export function describeSources(prompt: AssembledPrompt, answer: string): string {
  if (prompt.included.length === 0) {
    return "No sources were found for this question.";
  }
  const cited = citedNumbers(answer);
  const lines = ["Sources:"];
  prompt.citations.forEach((citation, i) => {
    const section = prompt.included[i]?.chunk.metadata.sectionPath ?? [];
    const where = pages(citation.pageStart, citation.pageEnd);
    lines.push(
      `  ${cited.has(citation.index) ? "●" : "○"} [${citation.index.toString()}] ${where}` +
        (section.length === 0 ? "" : `  ${section.join(" > ")}`),
      `      "${snippet(citation.quote)}"`,
    );
  });
  lines.push("  (● cited in the answer, ○ retrieved but not cited)");
  return lines.join("\n");
}

function describeStage(stage: StageRecord): string {
  const details = Object.entries(stage.summary)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
  const status = stage.status === "error" ? `  FAILED: ${stage.error ?? "unknown error"}` : "";
  return (
    `  ${stage.stage.padEnd(10)} ${Math.round(stage.durationMs).toString().padStart(6)} ms` +
    (details === "" ? "" : `  ${details}`) +
    status
  );
}

function describeDropped({ chunk, reason }: DroppedChunk): string {
  const { pageStart, pageEnd } = chunk.chunk.metadata;
  return `  ${reason.padEnd(11)} ${pages(pageStart, pageEnd)}  "${snippet(chunk.chunk.text)}"`;
}

/**
 * What `/debug` prints after an answer: each stage with its time and what it reported, how the
 * prompt was filled, and the retrieved chunks that were left out and why.
 */
export function describeTrace(trace: TraceSnapshot, prompt: AssembledPrompt): string {
  const lines = [`Trace (${Math.round(trace.totalMs).toString()} ms in total):`];
  lines.push(...trace.stages.map(describeStage));
  lines.push(
    `Prompt: ${prompt.promptVersion}, ${prompt.included.length.toString()} sources, ` +
      `${prompt.sourceTokens.toString()} of ${prompt.budget.toString()} source tokens`,
  );
  if (prompt.dropped.length > 0) {
    lines.push(
      `Left out (${prompt.dropped.length.toString()}):`,
      ...prompt.dropped.map(describeDropped),
    );
  }
  return lines.join("\n");
}

export interface ChatConfigInfo {
  readonly config: RagConfig;
  /** The variant in use, or undefined for the default configuration. */
  readonly variant: string | undefined;
  /** The index in use, `<chunker>__<embedder>`. */
  readonly namespace: string;
  /** The names of the parts, from `RagPipeline.describe()`. */
  readonly parts: Readonly<Record<"transformer" | "retriever" | "reranker" | "llm", string>>;
}

/** What `/config` prints: the active variant and the settings that decide how a question is answered. */
export function describeChatConfig({ config, variant, namespace, parts }: ChatConfigInfo): string {
  const { chunking, embedding, retrieval, rerank, generation } = config;
  const fusion = retrieval.strategy === "hybrid" ? `, fusion ${retrieval.fusion}` : "";
  return [
    `Variant:    ${variant ?? "default"}`,
    `Index:      ${namespace} (in ${config.vectorStore.dir})`,
    `Parts:      retriever ${parts.retriever}, reranker ${parts.reranker}, model ${parts.llm}`,
    `Chunking:   ${chunking.strategy}, ${chunking.maxTokens.toString()} tokens, overlap ${chunking.overlapTokens.toString()}`,
    `Embedding:  ${embedding.provider}:${embedding.model}`,
    `Retrieval:  ${retrieval.strategy}${fusion}, k = ${retrieval.k.toString()}`,
    `Rerank:     ${
      rerank.enabled ? `${rerank.strategy}, ${rerank.candidates.toString()} candidates` : "off"
    }`,
    `Generation: temperature ${generation.temperature.toString()}, at most ${generation.maxOutputTokens.toString()} tokens, ` +
      `context budget ${generation.contextBudgetTokens.toString()} tokens, ordering ${generation.ordering}`,
  ].join("\n");
}
