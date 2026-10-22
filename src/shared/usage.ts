import type { StageRecord } from "./trace.js";

// What a question costs. A metered model or embedder (RAG-093) records each call as a stage on the
// question's trace; the functions here read those stages back and put a price on them. Nothing else
// is kept, so the trace stays the one record of what happened and no total can drift from it.

/** The trace stage a metered model call is recorded as. */
export const MODEL_CALL_STAGE = "model-call";
/** The trace stage a metered embedding call is recorded as. */
export const EMBED_CALL_STAGE = "embed-call";

/** One call to a model or an embedder, read back from a trace. */
export interface UsageEntry {
  readonly kind: "model" | "embed";
  /** e.g. `ollama:llama3.2`. The key of the price table. */
  readonly modelId: string;
  /** Tokens sent. Absent when the provider did not say (and the call was not an embedding). */
  readonly promptTokens: number | undefined;
  /** Tokens written. Always absent for an embedding. */
  readonly outputTokens: number | undefined;
  /** True when the token count is an estimate (embeddings are counted from characters). */
  readonly estimated: boolean;
  /** Milliseconds from the call to the end of its reply. */
  readonly latencyMs: number;
  /** Milliseconds to the first piece of the reply; absent for an embedding or an empty reply. */
  readonly firstTokenMs: number | undefined;
  readonly ok: boolean;
}

const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** The metered calls recorded on a trace, in the order they finished. Other stages are ignored. */
export function usageOf(stages: readonly StageRecord[]): UsageEntry[] {
  return stages.flatMap((stage): UsageEntry[] => {
    if (stage.stage !== MODEL_CALL_STAGE && stage.stage !== EMBED_CALL_STAGE) return [];
    const model = typeof stage.summary["model"] === "string" ? stage.summary["model"] : "unknown";
    return [
      {
        kind: stage.stage === MODEL_CALL_STAGE ? "model" : "embed",
        modelId: model,
        promptTokens: number(stage.summary["promptTokens"]),
        outputTokens: number(stage.summary["outputTokens"]),
        estimated: stage.summary["estimated"] === true,
        latencyMs: stage.durationMs,
        firstTokenMs: number(stage.summary["firstTokenMs"]),
        ok: stage.status === "ok" && stage.summary["completed"] !== false,
      },
    ];
  });
}

/** Sums over many calls. */
export interface UsageTotals {
  readonly calls: number;
  /** Calls that did not finish: an error, or a reply that was stopped. */
  readonly failedCalls: number;
  readonly promptTokens: number;
  readonly outputTokens: number;
  /** Tokens of embedded text (all estimates). Kept apart from model tokens: they price differently. */
  readonly embeddedTokens: number;
  /** Tokens that a provider did not report. They are not in the totals above. */
  readonly callsWithoutTokens: number;
  /** Sum of the latency of every call, in milliseconds. Calls that overlap are counted in full. */
  readonly modelMs: number;
}

export function totalUsage(entries: readonly UsageEntry[]): UsageTotals {
  let promptTokens = 0;
  let outputTokens = 0;
  let embeddedTokens = 0;
  let callsWithoutTokens = 0;
  let failedCalls = 0;
  let modelMs = 0;
  for (const e of entries) {
    modelMs += e.latencyMs;
    if (!e.ok) failedCalls++;
    if (e.kind === "embed") {
      embeddedTokens += e.promptTokens ?? 0;
    } else {
      promptTokens += e.promptTokens ?? 0;
      outputTokens += e.outputTokens ?? 0;
      if (e.promptTokens === undefined && e.outputTokens === undefined) callsWithoutTokens++;
    }
  }
  return {
    calls: entries.length,
    failedCalls,
    promptTokens,
    outputTokens,
    embeddedTokens,
    callsWithoutTokens,
    modelMs,
  };
}

// ---- prices ----

/** What a model charges, per million tokens, in the currency of the table. */
export interface Price {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
}

/** The `pricing` section of the config. A model that is not in it has no price. */
export interface PriceTable {
  readonly currency: string;
  readonly models: Readonly<Record<string, Price>>;
}

/** What a set of calls costs, and how much of it could not be priced. */
export interface Cost {
  readonly currency: string;
  /** In `currency` units. Calls to models with no price add nothing. */
  readonly amount: number;
  /** Tokens (sent, written and embedded) of models that are not in the price table. */
  readonly unpricedTokens: number;
}

/**
 * Prices the calls with the table. A model with no entry costs nothing and its tokens are counted
 * as `unpricedTokens`, so a free local model and a hosted model whose price was forgotten can be told
 * apart: the first is listed at 0, the second shows up as tokens nobody paid for on paper.
 * An embedding is priced at the model's input price.
 */
export function costOf(entries: readonly UsageEntry[], prices: PriceTable): Cost {
  let amount = 0;
  let unpricedTokens = 0;
  for (const e of entries) {
    const tokens = (e.promptTokens ?? 0) + (e.outputTokens ?? 0);
    const price = Object.hasOwn(prices.models, e.modelId) ? prices.models[e.modelId] : undefined;
    if (price === undefined) {
      unpricedTokens += tokens;
      continue;
    }
    amount +=
      ((e.promptTokens ?? 0) * price.inputPerMillion +
        (e.outputTokens ?? 0) * price.outputPerMillion) /
      1_000_000;
  }
  return { currency: prices.currency, amount, unpricedTokens };
}

/**
 * An amount of money for a person to read: two decimals from a cent up, and enough decimals below
 * that to show something, because one answer costs a fraction of a cent. Zero is "0".
 */
export function formatMoney(amount: number): string {
  if (amount === 0) return "0";
  if (amount >= 0.01) return amount.toFixed(2);
  return amount.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
