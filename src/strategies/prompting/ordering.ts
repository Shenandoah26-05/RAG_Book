/** How the chosen chunks are laid out in the prompt. The config key is `generation.ordering`. */
export const ORDERING_NAMES = ["relevance", "sandwich"] as const;
export type OrderingName = (typeof ORDERING_NAMES)[number];

export function isOrderingName(value: string): value is OrderingName {
  return (ORDERING_NAMES as readonly string[]).includes(value);
}

/**
 * Puts best-first items in prompt order.
 *
 * - `relevance`: unchanged, best first.
 * - `sandwich`: the best at the start, the second best at the end, then inward: 1 3 5 ... 6 4 2.
 *   Models attend most to the start and the end of a long prompt and least to the middle ("lost in
 *   the middle"), so the weakest chunks go where they do the least harm.
 */
export function orderForPrompt<T>(bestFirst: readonly T[], ordering: OrderingName): T[] {
  if (ordering === "relevance") return [...bestFirst];
  const result = new Array<T>(bestFirst.length);
  let front = 0;
  let back = bestFirst.length - 1;
  bestFirst.forEach((item, position) => {
    if (position % 2 === 0) result[front++] = item;
    else result[back--] = item;
  });
  return result;
}
