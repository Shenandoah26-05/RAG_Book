import { normalizeOllamaHost, OllamaHost } from "../adapters/index.js";
import { loadConfig } from "../config/index.js";
import type { Env } from "../config/index.js";
import { runDoctor } from "../pipeline/index.js";
import type { CheckResult, RequiredModel } from "../pipeline/index.js";

export interface BuildDoctorOptions {
  readonly argv?: readonly string[];
  readonly env?: Env;
  readonly fetch?: typeof fetch;
}

export interface Doctor {
  run(): Promise<readonly CheckResult[]>;
}

/**
 * Reads the configuration and OLLAMA_HOST, and returns a doctor that checks the models that
 * configuration actually uses. Throws a ConfigError for a bad config and a RagError for a bad
 * OLLAMA_HOST.
 */
export async function buildDoctor(options: BuildDoctorOptions = {}): Promise<Doctor> {
  const { argv = process.argv.slice(2), env = process.env, fetch: fetchFn } = options;

  const config = await loadConfig({ argv, env });
  const host = new OllamaHost(normalizeOllamaHost(env["OLLAMA_HOST"]), fetchFn);

  const required: RequiredModel[] = [];
  if (config.embedding.provider === "ollama") {
    required.push({ model: config.embedding.model, purpose: "embedding" });
  }
  if (config.generation.provider === "ollama") {
    required.push({ model: config.generation.model, purpose: "generation" });
  }

  return { run: () => runDoctor(host, required) };
}
