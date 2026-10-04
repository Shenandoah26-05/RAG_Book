import { describe, expect, it } from "vitest";
import { isDocId, makeDocId } from "./doc-id.js";

/** A UUID, but a random (version 4) one, which is not how document ids are made. */
const V4_UUID = "3f2b8a1e-7c4d-4e9a-b5d6-1a2c3e4f5a6b";

describe("makeDocId", () => {
  it("is a version 5 UUID", () => {
    expect(makeDocId("abc")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("is the same for the same file hash and differs for another", () => {
    expect(makeDocId("abc")).toBe(makeDocId("abc"));
    expect(makeDocId("abc")).not.toBe(makeDocId("abd"));
  });

  it("is stable: a known file hash always gives the same id", () => {
    // Pinned value, also checked against Python's uuid.uuid5 with the same namespace. If this
    // changes, every stored document gets a new id and is processed again. Do not update it
    // casually.
    const sha = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    expect(makeDocId(sha)).toBe("b6320d25-9d9b-5eed-9640-15b1336f1297");
  });
});

describe("isDocId", () => {
  it("accepts a document id", () => {
    expect(isDocId(makeDocId("abc"))).toBe(true);
    expect(isDocId("b6320d25-9d9b-5eed-9640-15b1336f1297")).toBe(true);
  });

  it.each([
    ["an empty string", ""],
    ["a SHA-256 hash (the earlier id format)", "a".repeat(64)],
    ["a random (version 4) UUID", V4_UUID],
    ["the nil UUID", "00000000-0000-0000-0000-000000000000"],
    ["a UUID in capitals", makeDocId("abc").toUpperCase()],
    ["a UUID with something after it", `${makeDocId("abc")}/..`],
    ["a UUID with something before it", `../${makeDocId("abc")}`],
    ["a path", "../../secrets"],
  ])("rejects %s", (_name, value) => {
    expect(isDocId(value)).toBe(false);
  });
});
