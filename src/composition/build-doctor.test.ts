import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../config/index.js";
import { RagError } from "../shared/index.js";
import { buildDoctor } from "./build-doctor.js";

function tagsFetch(names: readonly string[]) {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(JSON.stringify({ models: names.map((name) => ({ name })) }))),
  );
}

/** Config files are looked up in the working directory, so point it at an empty one. */
async function withEmptyDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "rag-doctor-"));
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(previous);
    await rm(dir, { recursive: true, force: true });
  }
}

describe("buildDoctor", () => {
  it("checks the models the configuration uses, at the address in OLLAMA_HOST", async () => {
    await withEmptyDir(async () => {
      const fetchFn = tagsFetch(["all-minilm:latest", "llama3.2:latest"]);
      const doctor = await buildDoctor({
        argv: [],
        env: { OLLAMA_HOST: "gpu-box:9000" },
        fetch: fetchFn,
      });

      const results = await doctor.run();
      expect(results.map((r) => [r.name, r.status])).toEqual([
        ["Ollama is reachable", "ok"],
        ["Model all-minilm (embedding)", "ok"],
        ["Model llama3.2 (generation)", "ok"],
      ]);
      expect(fetchFn.mock.calls[0]?.[0]).toBe("http://gpu-box:9000/api/tags");
    });
  });

  it("follows config overrides: a different generation model is what gets checked", async () => {
    await withEmptyDir(async () => {
      const doctor = await buildDoctor({
        argv: ["--generation.model", "qwen2.5"],
        env: {},
        fetch: tagsFetch(["all-minilm:latest", "llama3.2:latest"]),
      });
      const results = await doctor.run();
      expect(results.find((r) => r.status === "fail")).toMatchObject({
        name: "Model qwen2.5 (generation)",
        fix: "ollama pull qwen2.5",
      });
    });
  });

  it("skips models for providers other than Ollama", async () => {
    await withEmptyDir(async () => {
      const doctor = await buildDoctor({
        argv: ["--generation.provider", "openai-compatible"],
        env: {},
        fetch: tagsFetch(["all-minilm:latest"]),
      });
      const names = (await doctor.run()).map((r) => r.name);
      expect(names).toEqual(["Ollama is reachable", "Model all-minilm (embedding)"]);
    });
  });

  it("uses the default address when OLLAMA_HOST is unset", async () => {
    await withEmptyDir(async () => {
      const fetchFn = tagsFetch([]);
      const doctor = await buildDoctor({
        argv: [],
        env: {},
        fetch: fetchFn,
      });
      await doctor.run();
      expect(fetchFn.mock.calls[0]?.[0]).toBe("http://127.0.0.1:11434/api/tags");
    });
  });

  it("fails at startup on a bad OLLAMA_HOST, naming the variable", async () => {
    await withEmptyDir(async () => {
      await expect(
        buildDoctor({ argv: [], env: { OLLAMA_HOST: "ftp://x" } }),
      ).rejects.toBeInstanceOf(RagError);
      await expect(buildDoctor({ argv: [], env: { OLLAMA_HOST: "ftp://x" } })).rejects.toThrow(
        "OLLAMA_HOST",
      );
    });
  });

  it("fails at startup on an invalid config", async () => {
    await withEmptyDir(async (dir) => {
      await writeFile(path.join(dir, "rag.config.json"), '{"retrieval":{"k":0}}');
      await expect(buildDoctor({ argv: [], env: {} })).rejects.toBeInstanceOf(ConfigError);
    });
  });
});
