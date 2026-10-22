import { describe, expect, it } from "vitest";
import { isTransientStatus, parseRetryAfter, retryHints } from "./http-failure.js";

describe("isTransientStatus", () => {
  it.each([408, 425, 429, 500, 502, 503, 504, 599])("%i may pass", (status) => {
    expect(isTransientStatus(status)).toBe(true);
  });

  it.each([200, 400, 401, 403, 404, 413, 422, 501, 505])("%i will be refused again", (status) => {
    expect(isTransientStatus(status)).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  const now = new Date("2026-10-22T10:00:00.000Z");

  it("reads a number of seconds", () => {
    expect(parseRetryAfter("7", now)).toBe(7000);
    expect(parseRetryAfter(" 0 ", now)).toBe(0);
  });

  it("reads a date, as the time from now", () => {
    expect(parseRetryAfter("Thu, 22 Oct 2026 10:00:30 GMT", now)).toBe(30_000);
  });

  it("ignores what is missing, malformed, negative or already past", () => {
    for (const value of [null, "", "soon", "-5", "1.5", "Thu, 22 Oct 2026 09:00:00 GMT"]) {
      expect(parseRetryAfter(value, now)).toBeUndefined();
    }
  });

  it("caps an absurd wait at a day", () => {
    expect(parseRetryAfter("99999999999", now)).toBe(24 * 60 * 60 * 1000);
  });
});

describe("retryHints", () => {
  const response = (status: number, headers: Record<string, string> = {}): Response =>
    new Response("", { status, headers });

  it("marks a busy server retryable, with how long it asked to wait", () => {
    expect(retryHints(response(429, { "retry-after": "2" }))).toEqual({
      retryable: true,
      retryAfterMs: 2000,
    });
  });

  it("marks a broken server retryable with no wait when it gave none", () => {
    expect(retryHints(response(503))).toEqual({ retryable: true });
  });

  it("marks a refusal not retryable, and ignores Retry-After on it", () => {
    expect(retryHints(response(401, { "retry-after": "2" }))).toEqual({ retryable: false });
    expect(retryHints(response(404))).toEqual({ retryable: false });
  });
});
