/** The part of `Storage` that is used, so a test can pass a plain object. */
export interface PositionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const key = (docId: string): string => `rag-book:position:v1:${docId}`;

/**
 * The page the reader was on, saved per book. Storage can be missing, full or blocked (a private
 * window, a browser setting), and it holds whatever anything put there, so every read and write is
 * guarded and a bad value is the same as no value. The reader works without it; it only forgets.
 */
export function loadPosition(
  storage: PositionStorage | undefined,
  docId: string,
): number | undefined {
  try {
    const raw = storage?.getItem(key(docId));
    if (raw === null || raw === undefined) return undefined;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || !("page" in value)) return undefined;
    const { page } = value;
    return typeof page === "number" && Number.isInteger(page) && page >= 1 ? page : undefined;
  } catch {
    return undefined;
  }
}

export function savePosition(
  storage: PositionStorage | undefined,
  docId: string,
  page: number,
): void {
  try {
    storage?.setItem(key(docId), JSON.stringify({ page }));
  } catch {
    // not saved: the next visit opens at the first page
  }
}

/** The browser's local storage, or undefined where touching it throws. */
export function browserStorage(): PositionStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
