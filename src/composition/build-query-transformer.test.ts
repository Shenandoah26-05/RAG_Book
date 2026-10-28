import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config/index.js";
import type { Retriever } from "../core/index.js";
import { MultiQueryRetriever } from "../strategies/index.js";
import { scriptedLlm } from "../testing/scripted-llm.testing.js";
import {
  buildQueryTransformer,
  HYDE_PROMPT_FILE,
  MULTI_QUERY_PROMPT_FILE,
  REWRITE_PROMPT_FILE,
  withVariantSearch,
} from "./build-query-transformer.js";

const settings = DEFAULT_CONFIG.queryTransform;
const llm = scriptedLlm("unused");
let promptsDir: string;
let workdir: string;

beforeAll(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "rag-query-transformer-"));
  promptsDir = path.join(workdir, "prompts");
  await mkdir(promptsDir);
  for (const file of [REWRITE_PROMPT_FILE, HYDE_PROMPT_FILE, MULTI_QUERY_PROMPT_FILE]) {
    await writeFile(
      path.join(promptsDir, file),
      await readFile(path.resolve("prompts", file), "utf8"),
    );
  }
});
afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

const build = (change: Partial<typeof settings>, dir = promptsDir) =>
  buildQueryTransformer({ ...settings, ...change }, { llm, promptsDir: dir });

describe("buildQueryTransformer", () => {
  it("is the identity when everything is off", async () => {
    expect((await build({ rewrite: false })).name).toBe("identity");
  });

  it("is the rewriter alone by default", async () => {
    expect((await build({})).name).toBe("rewrite");
  });

  it("is a chain, rewriter first, when several are on", async () => {
    expect((await build({ multiQuery: true, hyde: true })).name).toBe(
      "chain(rewrite>multi-query>hyde)",
    );
    expect((await build({ rewrite: false, hyde: true })).name).toBe("hyde");
  });

  it("reads only the prompt files of the transformers that are on", async () => {
    const empty = path.join(workdir, "empty");
    await mkdir(empty);
    expect((await build({ rewrite: false }, empty)).name).toBe("identity");
    await expect(build({}, empty)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining(REWRITE_PROMPT_FILE) as string,
    });
  });

  it("rejects a prompt file that lacks its placeholders", async () => {
    const broken = path.join(workdir, "broken");
    await mkdir(broken);
    await writeFile(path.join(broken, REWRITE_PROMPT_FILE), "no placeholders");
    await expect(build({}, broken)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("withVariantSearch", () => {
  const inner: Retriever = { name: "hybrid", retrieve: () => Promise.resolve([]) };

  it("wraps it even when no transformer adds variants, because a selection can", () => {
    expect(withVariantSearch(inner, settings)).toBeInstanceOf(MultiQueryRetriever);
  });

  it("is invisible then: it reports the name of the retriever it wraps", () => {
    expect(withVariantSearch(inner, settings).name).toBe("hybrid");
  });

  it.each([{ hyde: true }, { multiQuery: true }])("wraps it for %j", (change) => {
    const wrapped = withVariantSearch(inner, { ...settings, ...change });
    expect(wrapped).toBeInstanceOf(MultiQueryRetriever);
    expect(wrapped.name).toBe("multi-query(hybrid)");
  });
});
