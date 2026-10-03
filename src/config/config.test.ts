import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_CONFIG,
  hashConfig,
  loadConfig,
  ragConfigSchema,
  resolveConfig,
} from "./index.js";
import type { RagConfig } from "./index.js";

/** Runs `fn`, expecting a ConfigError, and returns its message. */
function errorOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).message;
  }
  throw new Error("expected a ConfigError, but nothing was thrown");
}

describe("defaults and the committed rag.config.json", () => {
  it("defaults are a valid configuration", () => {
    expect(ragConfigSchema.safeParse(DEFAULT_CONFIG).success).toBe(true);
    expect(resolveConfig()).toEqual(DEFAULT_CONFIG);
  });

  it("rag.config.json at the repo root is valid", () => {
    const text = readFileSync(new URL("../../rag.config.json", import.meta.url), "utf8");
    expect(() => resolveConfig({ file: JSON.parse(text) })).not.toThrow();
  });

  it("returns a deeply frozen object", () => {
    const config = resolveConfig();
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.chunking)).toBe(true);
    expect(Object.isFrozen(config.ingestion.cleaners)).toBe(true);
  });
});

describe("precedence: defaults < file < env < CLI", () => {
  it("a file only needs the settings it changes", () => {
    const config = resolveConfig({ file: { chunking: { maxTokens: 200 } } });
    expect(config.chunking.maxTokens).toBe(200);
    expect(config.chunking.strategy).toBe("recursive");
    expect(config.retrieval).toEqual(DEFAULT_CONFIG.retrieval);
  });

  it("env overrides the file", () => {
    const config = resolveConfig({
      file: { chunking: { maxTokens: 200 } },
      env: { RAG_CHUNKING__MAX_TOKENS: "300" },
    });
    expect(config.chunking.maxTokens).toBe(300);
  });

  it("CLI overrides env", () => {
    const config = resolveConfig({
      file: { chunking: { maxTokens: 200 } },
      env: { RAG_CHUNKING__MAX_TOKENS: "300" },
      argv: ["--chunking.max-tokens", "500"],
    });
    expect(config.chunking.maxTokens).toBe(500);
  });

  it("only the overridden key changes inside a section", () => {
    const config = resolveConfig({ env: { RAG_CHUNKING__MAX_TOKENS: "300" } });
    expect(config.chunking).toEqual({ ...DEFAULT_CONFIG.chunking, maxTokens: 300 });
  });
});

describe("environment variables", () => {
  it("maps RAG_SECTION__KEY to section.key, converting names to camelCase", () => {
    const config = resolveConfig({
      env: {
        RAG_VECTOR_STORE__TYPE: "file",
        RAG_GENERATION__CONTEXT_BUDGET_TOKENS: "2000",
        RAG_EMBEDDING__MODEL: "nomic-embed-text",
      },
    });
    expect(config.vectorStore.type).toBe("file");
    expect(config.generation.contextBudgetTokens).toBe(2000);
    expect(config.embedding.model).toBe("nomic-embed-text");
  });

  it("parses booleans and lists", () => {
    const config = resolveConfig({
      env: { RAG_RERANK__ENABLED: "true", RAG_INGESTION__CLEANERS: "unicode, dehyphenate" },
    });
    expect(config.rerank.enabled).toBe(true);
    expect(config.ingestion.cleaners).toEqual(["unicode", "dehyphenate"]);
  });

  it("accepts a JSON list", () => {
    const config = resolveConfig({ env: { RAG_INGESTION__CLEANERS: '["unicode"]' } });
    expect(config.ingestion.cleaners).toEqual(["unicode"]);
  });

  it("ignores variables that are not settings, such as RAG_CONFIG and unrelated ones", () => {
    const config = resolveConfig({ env: { RAG_CONFIG: "x.json", PATH: "/bin", OLLAMA_HOST: "h" } });
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("rejects an unknown setting and names the variable", () => {
    expect(errorOf(() => resolveConfig({ env: { RAG_CHUNKING__MAX_TOKEN: "1" } }))).toContain(
      'RAG_CHUNKING__MAX_TOKEN: unknown setting "chunking.maxToken"',
    );
  });

  it("rejects a value of the wrong type and names the variable", () => {
    const message = errorOf(() => resolveConfig({ env: { RAG_CHUNKING__MAX_TOKENS: "lots" } }));
    expect(message).toContain('RAG_CHUNKING__MAX_TOKENS: expected a number, got "lots"');
  });

  it("rejects a name that goes deeper than any setting", () => {
    expect(errorOf(() => resolveConfig({ env: { RAG_CHUNKING__MAX_TOKENS__X: "1" } }))).toContain(
      'unknown setting "chunking.maxTokens.x"',
    );
  });
});

describe("CLI flags", () => {
  it("accepts `--a.b value` and `--a.b=value`", () => {
    const config = resolveConfig({
      argv: ["--retrieval.k", "8", "--retrieval.strategy=dense"],
    });
    expect(config.retrieval.k).toBe(8);
    expect(config.retrieval.strategy).toBe("dense");
  });

  it("accepts a bare boolean flag, and an explicit value", () => {
    expect(resolveConfig({ argv: ["--rerank.enabled"] }).rerank.enabled).toBe(true);
    expect(resolveConfig({ argv: ["--rerank.enabled", "--retrieval.k", "3"] }).rerank.enabled).toBe(
      true,
    );
    expect(resolveConfig({ argv: ["--rerank.enabled=false"] }).rerank.enabled).toBe(false);
    expect(
      resolveConfig({ file: { rerank: { enabled: true } }, argv: ["--rerank.enabled", "false"] })
        .rerank.enabled,
    ).toBe(false);
  });

  it("skips flags that belong to a command", () => {
    const config = resolveConfig({
      argv: [
        "chunks",
        "--strategy",
        "recursive",
        "--config",
        "x.json",
        "--chunking.max-tokens",
        "250",
      ],
    });
    expect(config.chunking.maxTokens).toBe(250);
  });

  it("reports a missing value", () => {
    expect(errorOf(() => resolveConfig({ argv: ["--retrieval.k"] }))).toContain(
      "--retrieval.k: needs a value",
    );
    expect(errorOf(() => resolveConfig({ argv: ["--retrieval.k", "--rerank.enabled"] }))).toContain(
      "--retrieval.k: needs a value",
    );
  });

  it("reports an unknown setting", () => {
    expect(errorOf(() => resolveConfig({ argv: ["--chunking.size", "3"] }))).toContain(
      '--chunking.size: unknown setting "chunking.size"',
    );
  });
});

describe("validation", () => {
  it("rejects values that break a rule, naming the setting and where it came from", () => {
    const message = errorOf(() => resolveConfig({ env: { RAG_CHUNKING__MAX_TOKENS: "-5" } }));
    expect(message).toContain(
      "chunking.maxTokens: must be greater than 0 (from RAG_CHUNKING__MAX_TOKENS)",
    );
  });

  it("names the file for a value that came from it", () => {
    const message = errorOf(() =>
      resolveConfig({ file: { retrieval: { k: 0 } }, fileLabel: "exp1.json" }),
    );
    expect(message).toContain("retrieval.k: must be greater than 0 (from exp1.json)");
  });

  it("rejects unknown keys in the file (typos)", () => {
    const message = errorOf(() => resolveConfig({ file: { chunking: { maxToken: 100 } } }));
    expect(message).toContain("chunking");
    expect(message).toContain("maxToken");
  });

  it("rejects a file that is not an object", () => {
    expect(errorOf(() => resolveConfig({ file: [1, 2], fileLabel: "x.json" }))).toContain(
      "x.json: must contain a JSON object",
    );
  });

  it("rejects non-kebab-case names", () => {
    expect(
      errorOf(() => resolveConfig({ file: { chunking: { strategy: "Parent_Child" } } })),
    ).toContain("chunking.strategy: must be a kebab-case name");
  });

  it("rejects overlap that is not smaller than the chunk size", () => {
    const message = errorOf(() =>
      resolveConfig({ file: { chunking: { maxTokens: 100, overlapTokens: 100 } } }),
    );
    expect(message).toContain("chunking.overlapTokens: must be smaller than maxTokens");
  });

  it("requires enough rerank candidates only when reranking is on", () => {
    expect(() => resolveConfig({ file: { retrieval: { k: 50 } } })).not.toThrow();
    expect(
      errorOf(() => resolveConfig({ file: { retrieval: { k: 50 }, rerank: { enabled: true } } })),
    ).toContain("rerank.candidates: must be at least retrieval.k when reranking is enabled");
  });

  it("reports every problem at once, not just the first", () => {
    const error = (() => {
      try {
        resolveConfig({
          file: { retrieval: { k: 0 } },
          env: { RAG_CHUNKING__MAX_TOKENS: "lots", RAG_NOPE__X: "1" },
          argv: ["--embedding.batch-size"],
        });
      } catch (e) {
        return e as ConfigError;
      }
      throw new Error("expected a ConfigError");
    })();
    expect(error.issues).toHaveLength(3);
    expect(error.issues.join("\n")).toContain("RAG_CHUNKING__MAX_TOKENS");
    expect(error.issues.join("\n")).toContain("RAG_NOPE__X");
    expect(error.issues.join("\n")).toContain("--embedding.batch-size");
  });
});

describe("hashConfig", () => {
  it("is a 64-character hex string, identical for identical configs", () => {
    expect(hashConfig(resolveConfig())).toMatch(/^[0-9a-f]{64}$/);
    expect(hashConfig(resolveConfig())).toBe(hashConfig(resolveConfig()));
  });

  it("does not depend on key order", () => {
    const reordered = {
      generation: DEFAULT_CONFIG.generation,
      rerank: DEFAULT_CONFIG.rerank,
      retrieval: { fusion: "rrf", k: 5, strategy: "hybrid" },
      vectorStore: DEFAULT_CONFIG.vectorStore,
      embedding: DEFAULT_CONFIG.embedding,
      chunking: DEFAULT_CONFIG.chunking,
      ingestion: DEFAULT_CONFIG.ingestion,
    } as RagConfig;
    expect(hashConfig(reordered)).toBe(hashConfig(DEFAULT_CONFIG));
  });

  it("changes when any setting changes", () => {
    const base = hashConfig(resolveConfig());
    expect(hashConfig(resolveConfig({ env: { RAG_RETRIEVAL__K: "6" } }))).not.toBe(base);
    expect(hashConfig(resolveConfig({ env: { RAG_VECTOR_STORE__DIR: "x" } }))).not.toBe(base);
    expect(hashConfig(resolveConfig({ env: { RAG_INGESTION__CLEANERS: "unicode" } }))).not.toBe(
      base,
    );
  });
});

describe("loadConfig", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rag-config-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("uses the defaults when the default file does not exist", async () => {
    expect(await loadConfig({ cwd: dir, argv: [], env: {} })).toEqual(DEFAULT_CONFIG);
  });

  it("reads rag.config.json from the working directory", async () => {
    await writeFile(path.join(dir, "rag.config.json"), '{"retrieval":{"k":9}}');
    const config = await loadConfig({ cwd: dir, argv: [], env: {} });
    expect(config.retrieval.k).toBe(9);
  });

  it("reads the file named by --config, and by RAG_CONFIG", async () => {
    await writeFile(path.join(dir, "a.json"), '{"retrieval":{"k":7}}');
    await writeFile(path.join(dir, "b.json"), '{"retrieval":{"k":8}}');
    expect(
      (await loadConfig({ cwd: dir, argv: ["--config", "a.json"], env: {} })).retrieval.k,
    ).toBe(7);
    expect((await loadConfig({ cwd: dir, argv: ["--config=a.json"], env: {} })).retrieval.k).toBe(
      7,
    );
    expect(
      (await loadConfig({ cwd: dir, argv: [], env: { RAG_CONFIG: "b.json" } })).retrieval.k,
    ).toBe(8);
    expect(
      (await loadConfig({ cwd: dir, argv: ["--config", "a.json"], env: { RAG_CONFIG: "b.json" } }))
        .retrieval.k,
    ).toBe(7);
  });

  it("fails when a file named explicitly does not exist", async () => {
    await expect(
      loadConfig({ cwd: dir, argv: ["--config", "nope.json"], env: {} }),
    ).rejects.toThrow(/config file not found/);
  });

  it("fails with a readable message on invalid JSON", async () => {
    await writeFile(path.join(dir, "rag.config.json"), "{ not json");
    await expect(loadConfig({ cwd: dir, argv: [], env: {} })).rejects.toThrow(
      /rag\.config\.json is not valid JSON/,
    );
  });

  it("applies env and CLI on top of the file", async () => {
    await writeFile(path.join(dir, "rag.config.json"), '{"retrieval":{"k":9}}');
    const config = await loadConfig({
      cwd: dir,
      argv: ["--retrieval.strategy", "dense"],
      env: { RAG_RETRIEVAL__K: "4" },
    });
    expect(config.retrieval).toEqual({ strategy: "dense", k: 4, fusion: "rrf" });
  });
});
