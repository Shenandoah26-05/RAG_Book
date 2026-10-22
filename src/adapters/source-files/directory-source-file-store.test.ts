import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ByteRange, SourceFile } from "../../core/index.js";
import { DirectorySourceFileStore } from "./directory-source-file-store.js";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The bytes of a file the test expects to have been found, or of a range of it. */
async function read(found: SourceFile | undefined, range?: ByteRange): Promise<string> {
  if (found === undefined) throw new Error("the file was not found");
  return bytes(found.read(range));
}

async function bytes(source: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(Buffer.from(part));
  return Buffer.concat(parts).toString("utf8");
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "rag-sources-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("DirectorySourceFileStore", () => {
  it("finds a PDF by the hash of its contents, whatever it is called", async () => {
    await writeFile(path.join(dir, "a.pdf"), "first book");
    await writeFile(path.join(dir, "renamed-copy.pdf"), "second book");
    const found = await new DirectorySourceFileStore(dir).find(sha("second book"));
    expect(found).toMatchObject({ size: 11, mediaType: "application/pdf" });
    expect(await read(found)).toBe("second book");
  });

  it("reads a byte range, both ends inclusive", async () => {
    await writeFile(path.join(dir, "a.pdf"), "0123456789");
    const found = await new DirectorySourceFileStore(dir).find(sha("0123456789"));
    expect(await read(found, { start: 2, end: 5 })).toBe("2345");
    expect(await read(found, { start: 9, end: 9 })).toBe("9");
  });

  it("gives undefined when no file has the hash", async () => {
    await writeFile(path.join(dir, "a.pdf"), "some book");
    expect(await new DirectorySourceFileStore(dir).find(sha("another"))).toBeUndefined();
  });

  it("gives undefined for a folder that does not exist", async () => {
    expect(
      await new DirectorySourceFileStore(path.join(dir, "missing")).find(sha("x")),
    ).toBeUndefined();
  });

  it("ignores files that are not PDFs, and folders named like one", async () => {
    await writeFile(path.join(dir, "notes.txt"), "text");
    await mkdir(path.join(dir, "folder.pdf"));
    expect(await new DirectorySourceFileStore(dir).find(sha("text"))).toBeUndefined();
  });

  it("does not look inside subfolders", async () => {
    await mkdir(path.join(dir, "nested"));
    await writeFile(path.join(dir, "nested", "a.pdf"), "hidden");
    expect(await new DirectorySourceFileStore(dir).find(sha("hidden"))).toBeUndefined();
  });

  it("notices a file that changed: the old hash no longer finds it, the new one does", async () => {
    const file = path.join(dir, "a.pdf");
    await writeFile(file, "version one");
    const store = new DirectorySourceFileStore(dir);
    expect(await store.find(sha("version one"))).toBeDefined();

    await writeFile(file, "version two!!");
    await utimes(file, new Date(), new Date(Date.now() + 5000));
    expect(await store.find(sha("version one"))).toBeUndefined();
    expect(await store.find(sha("version two!!"))).toBeDefined();
  });

  it("can stop reading early without error", async () => {
    await writeFile(path.join(dir, "a.pdf"), "x".repeat(200_000));
    const found = await new DirectorySourceFileStore(dir).find(sha("x".repeat(200_000)));
    expect(found).toBeDefined();
    for await (const part of (found as SourceFile).read()) {
      expect(part.length).toBeGreaterThan(0);
      break;
    }
  });
});
