import type { ResultUsage } from "../../core/index.js";
import { costOf, totalUsage } from "../../shared/index.js";
import type { PriceTable, UsageEntry } from "../../shared/index.js";

/** The prices of a run that has none: every model is unpriced, and nothing costs anything. */
export const NO_PRICES: PriceTable = { currency: "", models: {} };

/**
 * What the calls of one question came to, in the shape a result line holds. Undefined when there
 * were no calls: a result then says nothing about usage, instead of saying zero.
 */
export function resultUsage(
  entries: readonly UsageEntry[] | undefined,
  prices: PriceTable,
): ResultUsage | undefined {
  if (entries === undefined || entries.length === 0) return undefined;
  const totals = totalUsage(entries);
  const cost = costOf(entries, prices);
  return {
    calls: totals.calls,
    failedCalls: totals.failedCalls,
    promptTokens: totals.promptTokens,
    outputTokens: totals.outputTokens,
    embeddedTokens: totals.embeddedTokens,
    modelMs: totals.modelMs,
    cost: cost.amount,
    unpricedTokens: cost.unpricedTokens,
  };
}
