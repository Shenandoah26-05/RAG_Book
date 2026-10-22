/** `#page=12` in the address: a reader's place that can be bookmarked, shared or reloaded. */
const PAGE_HASH = /^#page=([1-9]\d{0,8})$/;

export function parsePageHash(hash: string): number | undefined {
  const match = PAGE_HASH.exec(hash);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

export const formatPageHash = (page: number): string => `#page=${page.toString()}`;

/** The nearest page that exists: 1 to `pageCount`, whole numbers only. */
export function clampPage(page: number, pageCount: number): number {
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(Math.trunc(page), 1), Math.max(pageCount, 1));
}

const inBook = (page: number | undefined, pageCount: number): page is number =>
  page !== undefined && Number.isInteger(page) && page >= 1 && page <= pageCount;

/**
 * Where to open the book. An address that names a page wins (it is what the person just asked for),
 * then the place they stopped last time, then the first page. A page outside the book is ignored
 * rather than clamped: a stale bookmark to page 400 of a 25-page book is not a request for page 25.
 */
export function startPage(options: {
  readonly hash: string;
  readonly saved: number | undefined;
  readonly pageCount: number;
}): number {
  const fromAddress = parsePageHash(options.hash);
  if (inBook(fromAddress, options.pageCount)) return fromAddress;
  if (inBook(options.saved, options.pageCount)) return options.saved;
  return 1;
}
