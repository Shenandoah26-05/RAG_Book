import { ANSWER_ID } from "@rag-book/api-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newAnswerId } from "./answer-id.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("newAnswerId", () => {
  it("is a version 4 UUID, and a different one each time", () => {
    const ids = new Set(Array.from({ length: 50 }, newAnswerId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(ANSWER_ID);
  });

  it("still makes one where crypto.randomUUID does not exist (a page not served securely)", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(0xff),
    });
    // all bits set: the version and variant must still come out right
    expect(newAnswerId()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(newAnswerId()).toMatch(ANSWER_ID);
  });
});
