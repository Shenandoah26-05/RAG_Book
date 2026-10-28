import type { ByteRange } from "../core/index.js";

/** What a request's `Range` header asks for, against a file of a known size. */
export type RangeRequest =
  /** No usable range: send the whole file with 200. */
  | { readonly kind: "whole" }
  /** A single range inside the file: send it with 206. */
  | { readonly kind: "partial"; readonly range: ByteRange }
  /** Starts at or after the end of the file: answer 416. */
  | { readonly kind: "unsatisfiable" };

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * Reads a `Range` header (RFC 9110, byte ranges only). The three forms of a single range are
 * `bytes=a-b`, `bytes=a-` (to the end) and `bytes=-n` (the last n bytes). The end is cut to the
 * file's size. A header that is not a single byte range (several ranges, another unit, nonsense) is
 * ignored and the whole file is sent: the RFC allows it, and a reader that wants a part will ask
 * again. pdf.js asks for one range at a time.
 */
export function parseRange(header: string | undefined, size: number): RangeRequest {
  if (header === undefined) return { kind: "whole" };
  const match = SINGLE_RANGE.exec(header.trim());
  if (match === null) return { kind: "whole" };
  const [, from = "", to = ""] = match;
  if (from === "" && to === "") return { kind: "whole" };

  if (from === "") {
    // the last n bytes
    const count = Number(to);
    if (count === 0) return { kind: "unsatisfiable" };
    return { kind: "partial", range: { start: Math.max(0, size - count), end: size - 1 } };
  }
  const start = Number(from);
  if (start >= size) return { kind: "unsatisfiable" };
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  // `bytes=5-2` is not a range at all
  if (end < start) return { kind: "whole" };
  return { kind: "partial", range: { start, end } };
}
