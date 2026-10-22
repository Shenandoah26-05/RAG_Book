import type { PriceTable, UsageEntry, UsageTotals } from "../shared/index.js";
import { costOf, formatMoney, totalUsage } from "../shared/index.js";

export { formatMoney };

const count = (n: number): string => Math.round(n).toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`): string =>
  `${count(n)} ${n === 1 ? one : many}`;

/** Whether the table lists any model. Without one, money is not worth mentioning. */
export const hasPrices = (prices: PriceTable): boolean => Object.keys(prices.models).length > 0;

/**
 * What an answer cost, on one line: model calls, tokens, time, and money when there are prices. For
 * the end of an answer in the chat. Undefined when nothing was metered (no call was made).
 */
export function describeUsage(
  entries: readonly UsageEntry[],
  prices: PriceTable,
): string | undefined {
  const totals: UsageTotals = totalUsage(entries);
  if (totals.calls === 0) return undefined;
  const models = entries.filter((e) => e.kind === "model").length;
  const embeds = totals.calls - models;

  const parts: string[] = [];
  if (models > 0) {
    parts.push(
      `${plural(models, "model call")}: ${count(totals.promptTokens)} tokens in, ${count(totals.outputTokens)} out`,
    );
  }
  if (embeds > 0) {
    parts.push(`${plural(embeds, "embedding call")}: about ${count(totals.embeddedTokens)} tokens`);
  }
  parts.push(`${(totals.modelMs / 1000).toFixed(1)} s with the models`);
  if (totals.callsWithoutTokens > 0) {
    parts.push(`${plural(totals.callsWithoutTokens, "call")} reported no tokens`);
  }
  if (totals.failedCalls > 0) parts.push(`${count(totals.failedCalls)} did not finish`);

  if (hasPrices(prices)) {
    const cost = costOf(entries, prices);
    parts.push(
      `cost ${formatMoney(cost.amount)} ${cost.currency}` +
        (cost.unpricedTokens > 0 ? ` (${count(cost.unpricedTokens)} tokens have no price)` : ""),
    );
  }
  return `Usage: ${parts.join("; ")}`;
}
