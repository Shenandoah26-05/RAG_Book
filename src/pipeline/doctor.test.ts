import { describe, expect, it } from "vitest";
import type { ModelHost } from "../core/index.js";
import { RagError } from "../shared/index.js";
import { hasModel, runDoctor } from "./doctor.js";

function fakeHost(result: readonly string[] | Error): ModelHost {
  return {
    name: "Ollama",
    address: "http://127.0.0.1:11434",
    hints: { start: "Start Ollama", pull: (model) => `ollama pull ${model}` },
    listModels: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
  };
}

const REQUIRED = [
  { model: "all-minilm", purpose: "embedding" },
  { model: "llama3.2", purpose: "generation" },
];

describe("hasModel", () => {
  it("treats a name without a tag as :latest", () => {
    expect(hasModel(["all-minilm:latest"], "all-minilm")).toBe(true);
    expect(hasModel(["all-minilm"], "all-minilm:latest")).toBe(true);
    expect(hasModel(["all-minilm:latest"], "all-minilm:latest")).toBe(true);
  });

  it("does not match a different tag or a different model", () => {
    expect(hasModel(["llama3.2:1b"], "llama3.2")).toBe(false);
    expect(hasModel(["llama3.2:latest"], "llama3.2:1b")).toBe(false);
    expect(hasModel(["llama3.2:latest"], "llama3")).toBe(false);
    expect(hasModel([], "all-minilm")).toBe(false);
  });
});

describe("runDoctor", () => {
  it("passes when the host is reachable and every model is installed", async () => {
    const results = await runDoctor(fakeHost(["all-minilm:latest", "llama3.2:latest"]), REQUIRED);
    expect(results.map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
    expect(results[0]).toMatchObject({
      name: "Ollama is reachable",
      detail: "http://127.0.0.1:11434",
    });
  });

  it("names the fix for each missing model", async () => {
    const results = await runDoctor(fakeHost(["all-minilm:latest"]), REQUIRED);
    expect(results.map((r) => r.status)).toEqual(["ok", "ok", "fail"]);
    expect(results[2]).toEqual({
      name: "Model llama3.2 (generation)",
      status: "fail",
      detail: "not installed",
      fix: "ollama pull llama3.2",
    });
  });

  it("reports every missing model, each with its own fix", async () => {
    const results = await runDoctor(fakeHost([]), REQUIRED);
    expect(results.filter((r) => r.status === "fail").map((r) => r.fix)).toEqual([
      "ollama pull all-minilm",
      "ollama pull llama3.2",
    ]);
  });

  it("when the host is unreachable: one failure with the fix, and the models skipped", async () => {
    const error = new RagError(
      "PROVIDER_UNAVAILABLE",
      "Cannot reach Ollama at http://127.0.0.1:11434",
    );
    const results = await runDoctor(fakeHost(error), REQUIRED);

    expect(results.map((r) => r.status)).toEqual(["fail", "skip", "skip"]);
    expect(results[0]).toMatchObject({
      name: "Ollama is reachable",
      detail: "Cannot reach Ollama at http://127.0.0.1:11434",
    });
    expect(results[0]?.fix).toContain("Start Ollama");
    expect(results[0]?.fix).toContain("OLLAMA_HOST");
  });

  it("checks a model needed for two purposes once", async () => {
    const results = await runDoctor(fakeHost([]), [
      { model: "llama3.2", purpose: "generation" },
      { model: "llama3.2", purpose: "reranking" },
    ]);
    expect(results).toHaveLength(2);
    expect(results[1]?.name).toBe("Model llama3.2 (generation, reranking)");
  });

  it("skips when the configuration uses no models from the host", async () => {
    const results = await runDoctor(fakeHost(new Error("must not be called")), []);
    expect(results).toEqual([
      { name: "Ollama", status: "skip", detail: "the configuration uses no models from it" },
    ]);
  });

  it("never throws, even for a non-Error rejection", async () => {
    const host = fakeHost([]);
    const rejecting: ModelHost = {
      ...host,
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      listModels: () => Promise.reject("weird"),
    };
    const results = await runDoctor(rejecting, REQUIRED);
    expect(results[0]).toMatchObject({ status: "fail", detail: "weird" });
  });
});
