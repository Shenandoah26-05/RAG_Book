/**
 * What an HTTP failure says about trying again. Only the adapter that saw the response knows the
 * status, so it marks its error; deciding whether to retry, and how long to wait, is the retrying
 * decorator's job (RAG-092), never the adapter's.
 */
export interface RetryHints {
  readonly retryable: boolean;
  /** Present when the server said how long to wait (`Retry-After`). */
  readonly retryAfterMs?: number;
}

/** A longer `Retry-After` than this is passed on as it is; the decorator decides it is too long. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a status is worth trying again. A server that is busy or briefly broken (408, 425, 429 and
 * 5xx except 501 and 505) may answer next time. A request the server refused or cannot understand
 * (400, 401, 403, 404, 422, 501, 505) will be refused again.
 */
export function isTransientStatus(status: number): boolean {
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500 && status !== 501 && status !== 505;
}

/**
 * Reads `Retry-After`, which is either a number of seconds or a date, as milliseconds from `now`.
 * A header that is missing, malformed or in the past gives undefined.
 */
export function parseRetryAfter(value: string | null, now: Date = new Date()): number | undefined {
  const text = value?.trim() ?? "";
  if (text === "") return undefined;
  if (/^\d+$/.test(text)) return Math.min(Number(text) * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  const wait = at - now.getTime();
  return wait > 0 ? Math.min(wait, MAX_RETRY_AFTER_MS) : undefined;
}

/** The hints for a non-2xx response. */
export function retryHints(response: Response): RetryHints {
  const retryable = isTransientStatus(response.status);
  const retryAfterMs = retryable ? parseRetryAfter(response.headers.get("retry-after")) : undefined;
  return retryAfterMs === undefined ? { retryable } : { retryable, retryAfterMs };
}
