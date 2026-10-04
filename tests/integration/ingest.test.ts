import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileDocumentStore } from "../../src/adapters/index.js";
import { buildIngest } from "../../src/composition/index.js";
import { createJsonLogger } from "../../src/shared/index.js";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

describe("ingesting the fixture PDFs", () => {
  let out: string;
  let logs: Record<string, unknown>[];
  beforeEach(async () => {
    out = await mkdtemp(path.join(tmpdir(), "rag-ingest-"));
    logs = [];
  });
  afterEach(async () => {
    await rm(out, { recursive: true, force: true });
  });

  const ingester = () =>
    buildIngest({
      argv: [],
      env: {},
      outDir: out,
      logger: createJsonLogger({
        write: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
      }),
    });

  it("writes <docId>.json for sample.pdf, with 4 pages and 3 sections", async () => {
    const result = await (await ingester()).run(fixture("sample.pdf"));

    expect(result).toMatchObject({ status: "ingested", pages: 4, sections: 3 });
    if (result.status !== "ingested") throw new Error("expected an ingested result");
    expect(result.location).toBe(path.join(out, `${result.docId}.json`));
    expect(await readdir(out)).toEqual([`${result.docId}.json`]);
  });

  it("stores the cleaned document with its section tree, which can be loaded back", async () => {
    const result = await (await ingester()).run(fixture("sample.pdf"));
    const doc = await new FileDocumentStore(out).load(result.docId);

    expect(doc?.id).toBe(result.docId);
    expect(doc?.title).toBe("Sample Book");
    // cleaned: the hyphenated "vec-" and "tors" are joined
    expect(doc?.text).toContain("vectors that can be compared");
    expect(doc?.sections.map((s) => s.title)).toEqual([
      "Chapter 1: Introduction",
      "Chapter 2: Methods",
    ]);
    expect(doc?.sections[0]?.children.map((s) => s.title)).toEqual(["1.1 Background"]);
  });

  it("skips the second run, and processes again with force", async () => {
    const ingest = await ingester();
    const first = await ingest.run(fixture("sample.pdf"));
    const second = await ingest.run(fixture("sample.pdf"));
    const forced = await ingest.run(fixture("sample.pdf"), { force: true });

    expect([first.status, second.status, forced.status]).toEqual([
      "ingested",
      "skipped",
      "ingested",
    ]);
    expect(await readdir(out)).toHaveLength(1);
  });

  it("logs counts and duration for a run, and a skip message for the repeat", async () => {
    const ingest = await ingester();
    await ingest.run(fixture("sample.pdf"));
    await ingest.run(fixture("sample.pdf"));

    const done = logs.find((l) => l["message"] === "ingested");
    expect(done).toMatchObject({ pages: 4, sections: 3 });
    expect(typeof done?.["durationMs"]).toBe("number");
    expect(logs.some((l) => String(l["message"]).includes("skipping"))).toBe(true);
  });

  it("keeps different PDFs apart: each gets its own file", async () => {
    const ingest = await ingester();
    await ingest.run(fixture("sample.pdf"));
    await ingest.run(fixture("noisy.pdf"));
    expect(await readdir(out)).toHaveLength(2);
  });

  it("reads the loader from config, so another loader can be chosen", async () => {
    const withUnpdf = await buildIngest({
      argv: ["--ingestion.loader", "unpdf"],
      env: {},
      outDir: out,
      logger: createJsonLogger({ write: () => undefined }),
    });
    expect((await withUnpdf.run(fixture("sample.pdf"))).status).toBe("ingested");
  });

  it("fails clearly on an unknown loader in config", async () => {
    await expect(
      buildIngest({ argv: ["--ingestion.loader", "magic"], env: {}, outDir: out }),
    ).rejects.toThrow(/Unknown loader "magic".*pdfjs, unpdf/);
  });

  it("fails clearly on a missing file, and writes nothing", async () => {
    await expect((await ingester()).run(fixture("nope.pdf"))).rejects.toThrow(/nope\.pdf/);
    await expect(readdir(out)).resolves.toEqual([]);
  });
});

describe("pnpm ingest, as a command", () => {
  let out: string;
  beforeEach(async () => {
    out = await mkdtemp(path.join(tmpdir(), "rag-cli-"));
  });
  afterEach(async () => {
    await rm(out, { recursive: true, force: true });
  });

  /** Runs the command and reports its exit code and output, whether it succeeds or fails. */
  async function ingest(
    ...args: string[]
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await run(
        process.execPath,
        ["node_modules/tsx/dist/cli.mjs", "src/cli/ingest.ts", ...args],
        { cwd: ROOT },
      );
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
    }
  }

  it("ingests, then skips, then re-runs with --force, reporting each on the log", async () => {
    const file = fixture("sample.pdf");

    const first = await ingest(file, "--out-dir", out);
    expect(first.code).toBe(0);
    expect(first.stderr).toMatch(/INFO\s+ingested .*pages=4 sections=3 durationMs=\d+/);
    expect(await readdir(out)).toHaveLength(1);

    const second = await ingest(file, "--out-dir", out);
    expect(second.code).toBe(0);
    expect(second.stderr).toContain("skipping");

    const forced = await ingest(file, "--force", "--out-dir", out);
    expect(forced.code).toBe(0);
    expect(forced.stderr).toMatch(/ingested .*pages=4/);
  }, 30_000);

  it("exits with 2 and shows the usage when no file is given", async () => {
    const result = await ingest();
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("No file given");
    expect(result.stderr).toContain("Usage: pnpm ingest");
  }, 30_000);

  it("exits with 1 and a clear message for a file that does not exist", async () => {
    const result = await ingest("tests/fixtures/nope.pdf", "--out-dir", out);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("nope.pdf");
  }, 30_000);
});
