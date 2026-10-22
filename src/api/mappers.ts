import type {
  AskFilter,
  ChunkResponse,
  PageResponse,
  WireCitation,
  WireTrace,
  WireUsage,
} from "@rag-book/api-contract";
import type {
  Chunk,
  Citation,
  FilterClause,
  MetadataFilter,
  ParsedDocument,
  Page,
} from "../core/index.js";
import { costOf, totalUsage, usageOf } from "../shared/index.js";
import type { PriceTable, TraceSnapshot } from "../shared/index.js";

// The one place where the library's types become the contract's, and back. A field is copied by name
// here, so a library type can gain, lose or rename fields without the browser noticing: the
// contract changes only when this file does.

export function toWireCitation(citation: Citation): WireCitation {
  return {
    index: citation.index,
    chunkId: citation.chunkId,
    docId: citation.docId,
    pageStart: citation.pageStart,
    pageEnd: citation.pageEnd,
    charStart: citation.charStart,
    charEnd: citation.charEnd,
    quote: citation.quote,
  };
}

/** What the calls made for an answer came to; absent when no model or embedder was called. */
function toWireUsage(trace: TraceSnapshot, prices: PriceTable): WireUsage | undefined {
  const entries = usageOf(trace.stages);
  if (entries.length === 0) return undefined;
  const totals = totalUsage(entries);
  const hasPrices = Object.keys(prices.models).length > 0;
  const cost = hasPrices ? costOf(entries, prices) : undefined;
  return {
    calls: totals.calls,
    promptTokens: totals.promptTokens,
    outputTokens: totals.outputTokens,
    embeddedTokens: totals.embeddedTokens,
    modelMs: totals.modelMs,
    ...(cost === undefined
      ? {}
      : {
          cost: {
            amount: cost.amount,
            currency: cost.currency,
            unpricedTokens: cost.unpricedTokens,
          },
        }),
  };
}

export function toWireTrace(trace: TraceSnapshot, prices: PriceTable): WireTrace {
  const usage = toWireUsage(trace, prices);
  return {
    totalMs: trace.totalMs,
    stages: trace.stages.map((stage) => ({
      stage: stage.stage,
      startMs: stage.startMs,
      durationMs: stage.durationMs,
      status: stage.status,
      summary: { ...stage.summary },
      ...(stage.error === undefined ? {} : { error: stage.error }),
    })),
    ...(usage === undefined ? {} : { usage }),
  };
}

export function toWirePage(doc: ParsedDocument, page: Page): PageResponse {
  return {
    docId: doc.id,
    title: doc.title,
    number: page.number,
    pageCount: doc.pageCount,
    text: page.text,
    span: { start: page.span.start, end: page.span.end },
  };
}

export function toWireChunk(chunk: Chunk): ChunkResponse {
  const { metadata } = chunk;
  return {
    id: chunk.id,
    docId: metadata.docId,
    text: chunk.text,
    ...(chunk.parentId === undefined ? {} : { parentId: chunk.parentId }),
    pageStart: metadata.pageStart,
    pageEnd: metadata.pageEnd,
    sectionPath: [...metadata.sectionPath],
    charStart: metadata.charStart,
    charEnd: metadata.charEnd,
    strategy: metadata.strategy,
  };
}

/** One value is `equals`, several are `in`. */
function oneOrMany(field: "docId" | "strategy", values: readonly string[]): FilterClause {
  const [only] = values;
  return values.length === 1 && only !== undefined
    ? { kind: "equals", field, value: only }
    : { kind: "in", field, values };
}

/**
 * The request's filter as the library's. Every part that is given becomes one clause, and the
 * library requires all of them to hold. Returns undefined for no filter at all, so a request that
 * sends an empty `filter` is the same as one that sends none.
 */
export function toMetadataFilter(filter: AskFilter | undefined): MetadataFilter | undefined {
  if (filter === undefined) return undefined;
  const clauses: FilterClause[] = [];
  if (filter.documents !== undefined) clauses.push(oneOrMany("docId", filter.documents));
  if (filter.strategies !== undefined) clauses.push(oneOrMany("strategy", filter.strategies));
  if (filter.section !== undefined) clauses.push({ kind: "section", path: filter.section });
  if (filter.pages !== undefined) {
    clauses.push({
      kind: "pageRange",
      ...(filter.pages.from === undefined ? {} : { from: filter.pages.from }),
      ...(filter.pages.to === undefined ? {} : { to: filter.pages.to }),
    });
  }
  return clauses.length === 0 ? undefined : clauses;
}
