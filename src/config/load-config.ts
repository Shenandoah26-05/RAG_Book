import { readFile } from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "./config-error.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { applyOverrides, cliOverrides, envOverrides, isPlainObject } from "./overrides.js";
import type { PlainObject, RawOverride } from "./overrides.js";
import { ragConfigSchema } from "./schema.js";
import type { RagConfig } from "./schema.js";

export type Env = Readonly<Record<string, string | undefined>>;

export interface ResolveInput {
  /** Parsed contents of a config file, if there is one. */
  readonly file?: unknown;
  /** Used in error messages, e.g. "rag.config.json". */
  readonly fileLabel?: string;
  readonly env?: Env;
  readonly argv?: readonly string[];
}

/** Objects merge key by key; anything else (including lists) is replaced by the later value. */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const merged: PlainObject = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return merged;
}

function leafPaths(value: unknown, prefix: readonly string[] = []): string[][] {
  if (!isPlainObject(value)) return [[...prefix]];
  return Object.entries(value).flatMap(([key, child]) => leafPaths(child, [...prefix, key]));
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Combines the sources, lowest priority first: built-in defaults, config file, `RAG_*` environment
 * variables, command-line flags. Throws a ConfigError listing every problem if the result is not
 * a valid configuration. Pure: no file or process access, so it is easy to test.
 */
export function resolveConfig(input: ResolveInput = {}): RagConfig {
  const { file, fileLabel = "config file", env = {}, argv = [] } = input;
  const errors: string[] = [];
  /** "chunking.maxTokens" -> where the final value came from. */
  const sources = new Map<string, string>();

  let merged: unknown = DEFAULT_CONFIG;

  if (file !== undefined) {
    if (isPlainObject(file)) {
      merged = deepMerge(merged, file);
      for (const p of leafPaths(file)) sources.set(p.join("."), fileLabel);
    } else {
      errors.push(`${fileLabel}: must contain a JSON object`);
    }
  }

  const cli = cliOverrides(argv);
  errors.push(...cli.errors);

  const layers: readonly (readonly RawOverride[])[] = [envOverrides(env), cli.overrides];
  for (const layer of layers) {
    const applied = applyOverrides(layer);
    errors.push(...applied.errors);
    merged = deepMerge(merged, applied.patch);
    for (const o of layer) sources.set(o.path.join("."), o.source);
  }

  if (errors.length > 0) throw new ConfigError(errors);

  const parsed = ragConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => {
        const where = issue.path.map(String).join(".");
        const from = sources.get(where);
        return `${where === "" ? "(root)" : where}: ${issue.message}${from === undefined ? "" : ` (from ${from})`}`;
      }),
    );
  }
  return deepFreeze(parsed.data);
}

export interface LoadOptions {
  readonly argv?: readonly string[];
  readonly env?: Env;
  readonly cwd?: string;
}

const DEFAULT_FILE = "rag.config.json";

function configFlag(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") return argv[i + 1];
    if (arg?.startsWith("--config=") === true) return arg.slice("--config=".length);
  }
  return undefined;
}

/**
 * Loads the configuration for the running process. The file is `--config <path>`, else
 * `RAG_CONFIG`, else `rag.config.json` in the working directory. The default file may be missing
 * (defaults apply); a file named explicitly must exist.
 */
export async function loadConfig(options: LoadOptions = {}): Promise<RagConfig> {
  const { argv = process.argv.slice(2), env = process.env, cwd = process.cwd() } = options;

  const explicit = configFlag(argv) ?? env["RAG_CONFIG"];
  const file = path.resolve(cwd, explicit ?? DEFAULT_FILE);

  let text: string | undefined;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (!(missing && explicit === undefined)) {
      throw new ConfigError([
        missing ? `config file not found: ${file}` : `cannot read ${file}: ${String(error)}`,
      ]);
    }
  }

  let parsed: unknown;
  if (text !== undefined) {
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ConfigError([
        `${path.basename(file)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
  }

  return resolveConfig({ file: parsed, fileLabel: path.basename(file), env, argv });
}
