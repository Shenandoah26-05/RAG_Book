import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RagError } from "./errors.js";
import { sha256OfFile } from "./file-hash.js";

describe("sha256OfFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rag-hash-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("hashes the contents of the file", async () => {
    const file = path.join(dir, "a.txt");
    await writeFile(file, "hello");
    // the well-known SHA-256 of "hello"
    expect(await sha256OfFile(file)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("hashes an empty file", async () => {
    const file = path.join(dir, "empty");
    await writeFile(file, "");
    expect(await sha256OfFile(file)).toBe(createHash("sha256").update("").digest("hex"));
  });

  it("agrees with hashing the bytes in memory, for a file larger than one read chunk", async () => {
    const file = path.join(dir, "big.bin");
    const bytes = Buffer.alloc(300_000, "abc");
    await writeFile(file, bytes);
    expect(await sha256OfFile(file)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("depends on the contents, not the name", async () => {
    const one = path.join(dir, "one.pdf");
    const two = path.join(dir, "renamed.pdf");
    await writeFile(one, "same");
    await writeFile(two, "same");
    expect(await sha256OfFile(one)).toBe(await sha256OfFile(two));

    await writeFile(two, "changed");
    expect(await sha256OfFile(one)).not.toBe(await sha256OfFile(two));
  });

  it("rejects a missing file with INGESTION_FAILED, naming it", async () => {
    const missing = path.join(dir, "nope.pdf");
    const error = await sha256OfFile(missing).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RagError);
    expect((error as RagError).code).toBe("INGESTION_FAILED");
    expect((error as RagError).message).toContain("nope.pdf");
    expect((error as RagError).cause).toBeDefined();
  });
});
