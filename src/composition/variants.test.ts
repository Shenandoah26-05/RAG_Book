import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listVariants, resolveVariant } from "./variants.js";

describe("variants", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rag-variants-"));
    await writeFile(path.join(dir, "dense.json"), "{}");
    await writeFile(path.join(dir, "bm25.json"), "{}");
    await writeFile(path.join(dir, "notes.txt"), "not a variant");
    await mkdir(path.join(dir, "folder.json"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists the .json files by name, sorted", async () => {
    expect(await listVariants(dir)).toEqual(["bm25", "dense", "folder"]);
    expect(await listVariants(path.join(dir, "missing"))).toEqual([]);
  });

  it("looks a bare name up as <dir>/<name>.json", async () => {
    expect(await resolveVariant("dense", dir)).toBe(path.join(dir, "dense.json"));
  });

  it("uses anything with a folder or ending in .json as a path", async () => {
    const file = path.join(dir, "bm25.json");
    expect(await resolveVariant(file)).toBe(file);
    expect(await resolveVariant(file, path.join(dir, "elsewhere"))).toBe(file);
  });

  it("lists the variants that exist when one is missing", async () => {
    await expect(resolveVariant("magic", dir)).rejects.toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
        message: expect.stringMatching(
          /No variant "magic".*Variants in .*: bm25, dense/,
        ) as unknown,
      }) as Error,
    );
  });

  it("does not take a folder for a file", async () => {
    await expect(resolveVariant("folder", dir)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("says when there are no variants at all", async () => {
    await expect(resolveVariant("x", path.join(dir, "none"))).rejects.toThrow(/no variants in/);
  });

  it("the variants that ship with the repository are valid config files", async () => {
    const shipped = await listVariants();
    expect(shipped).toEqual(expect.arrayContaining(["dense", "bm25", "hybrid-weighted"]));
  });
});
