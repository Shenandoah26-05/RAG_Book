import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildIngest, buildInspect, describeInspection } from "../../src/composition/index.js";
import { noopLogger } from "../../src/shared/index.js";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SAMPLE = fileURLToPath(new URL("../fixtures/sample.pdf", import.meta.url));

describe("inspecting the chunks of sample.pdf", () => {
  let out: string;
  let docId: string;

  beforeEach(async () => {
    out = await mkdtemp(path.join(tmpdir(), "rag-chunks-"));
    const ingester = await buildIngest({ argv: [], env: {}, outDir: out, logger: noopLogger });
    docId = (await ingester.run(SAMPLE)).docId;
  });
  afterEach(async () => {
    await rm(out, { recursive: true, force: true });
  });

  const inspector = (argv: readonly string[] = []) =>
    buildInspect({ argv, env: {}, processedDir: out });

  it("finds the document by id or by PDF path, and gives the same result", async () => {
    const byId = await (await inspector()).run(docId, { strategy: "fixed-size" });
    const byPath = await (await inspector()).run(SAMPLE, { strategy: "fixed-size" });
    expect(byPath.docId).toBe(docId);
    expect(byPath.stats).toEqual(byId.stats);
    expect(byPath.samples.map((c) => c.id)).toEqual(byId.samples.map((c) => c.id));
  });

  it("writes <docId>.<strategy>.chunks.md next to the processed document", async () => {
    const result = await (await inspector()).run(docId, { strategy: "recursive" });
    expect(result.reportPath).toBe(path.join(out, `${docId}.recursive.chunks.md`));
    expect(await readdir(out)).toContain(`${docId}.recursive.chunks.md`);
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("# Chunks: recursive");
    expect(report).toContain(`chunks: ${result.stats.count.toString()}`);
  });

  it("gives a count, a histogram and 3 samples by default, and lists every chunk in the file", async () => {
    const result = await (await inspector()).run(docId, { strategy: "structure-aware" });
    expect(result.stats.count).toBeGreaterThan(0);
    expect(result.stats.histogram.length).toBeGreaterThan(0);
    expect(result.samples).toHaveLength(Math.min(3, result.stats.count));
    const report = await readFile(result.reportPath, "utf8");
    expect(report.match(/^### \d+\. /gm)).toHaveLength(result.stats.count);
    expect(describeInspection(result)).toContain(result.reportPath);
  });

  it("uses the strategy and sizes from the config when none is asked for", async () => {
    const result = await (await inspector(["--chunking.strategy", "fixed-size"])).run(docId);
    expect(result.strategy).toBe("fixed-size");
  });

  it("picks the same samples every time, and others for another seed", async () => {
    const pick = async (seed?: number) =>
      (
        await (
          await inspector(["--chunking.max-tokens", "20", "--chunking.overlap-tokens", "5"])
        ).run(docId, {
          strategy: "fixed-size",
          samples: 2,
          ...(seed === undefined ? {} : { seed }),
        })
      ).samples.map((c) => c.id);
    expect(await pick()).toEqual(await pick());
    const others = await Promise.all([1, 2, 3, 4, 5, 6].map((seed) => pick(seed)));
    expect(others.some((ids) => ids.join() !== others[0]?.join())).toBe(true);
  });

  it("tells you to ingest first when the document was never processed", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "rag-chunks-empty-"));
    try {
      await expect(
        (await buildInspect({ argv: [], env: {}, processedDir: empty })).run(SAMPLE),
      ).rejects.toThrow(/pnpm ingest/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("rejects an unknown strategy, naming the known ones, and a target that is not a document", async () => {
    await expect((await inspector()).run(docId, { strategy: "magic" })).rejects.toThrow(
      /Known strategies: fixed-size, recursive, structure-aware/,
    );
    await expect((await inspector()).run("nope.pdf")).rejects.toThrow(
      /neither a document id nor an existing file/,
    );
  });

  it("runs as `pnpm chunks`", async () => {
    const { stdout } = await run(
      process.execPath,
      ["--import", "tsx", "src/cli/chunks.ts", SAMPLE, "--strategy", "fixed-size", "--dir", out],
      { cwd: ROOT },
    );
    expect(stdout).toMatch(/chunks: \d+ {3}tokens: min/);
    expect(stdout).toContain("--- sample 1 of ");
    expect(stdout).toContain(`${docId}.fixed-size.chunks.md`);
  }, 30_000);
});
