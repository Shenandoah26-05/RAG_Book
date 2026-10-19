import type { MetadataFilter } from "../core/index.js";
import { FILTER_FLAGS, FILTER_USAGE, parseFilterArgs } from "./filter-args.js";

export interface SearchArgs {
  readonly question: string;
  readonly k?: number;
  readonly json: boolean;
  readonly variant?: string;
  readonly chunker?: string;
  readonly embedder?: string;
  readonly indexDir?: string;
  readonly cacheDir?: string;
  readonly filter: MetadataFilter;
}

export const SEARCH_USAGE =
  'Usage: pnpm search "<question>" [--k <n>] [--json] [--variant <name|file>]\n' +
  "                   [--chunker <name>] [--embedder <provider:model>]\n" +
  "                   [--index-dir <folder>] [--cache-dir <folder>] [filters]\n" +
  "  --k <n>              how many chunks to return (default: retrieval.k in the config)\n" +
  "  --json               print the whole report as JSON\n" +
  "  --variant <name>     use configs/variants/<name>.json as the config (or give a file path)\n" +
  "  --chunker <name>     which index: the chunker it was built with (default: chunking.strategy)\n" +
  "  --embedder <p:model> which index: the embedder it was built with (default: embedding.*)\n" +
  "  --index-dir <dir>    where indexes are (default: vectorStore.dir, data/index)\n" +
  "  --cache-dir <dir>    embedding cache (default: data/cache/embeddings)\n" +
  "Filters:\n" +
  FILTER_USAGE +
  "\n  --<section>.<key>    override a config setting, e.g. --retrieval.strategy bm25";

const VALUE_FLAGS = new Set([
  "--k",
  "--variant",
  "--chunker",
  "--embedder",
  "--index-dir",
  "--cache-dir",
]);

/**
 * Reads the command line of `pnpm search`. Flags written as `--section.key` are config overrides
 * for the config loader, and the filter flags belong to `parseFilterArgs`; both are skipped here,
 * with their values.
 */
export function parseSearchArgs(argv: readonly string[]): SearchArgs | { readonly error: string } {
  let question: string | undefined;
  let json = false;
  let hasConfig = false;
  const values = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const name = arg.split("=")[0] ?? "";
    if (arg === "--json") {
      json = true;
    } else if (VALUE_FLAGS.has(name)) {
      let value: string | undefined;
      if (arg.includes("=")) {
        value = arg.slice(name.length + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          value = next;
          i++;
        }
      }
      if (value === undefined || value === "") return { error: `${name} needs a value` };
      values.set(name, value);
    } else if ((FILTER_FLAGS as readonly string[]).includes(name)) {
      // its value belongs to parseFilterArgs
      if (!arg.includes("=")) i++;
    } else if (arg === "--config" || arg.startsWith("--config=")) {
      hasConfig = true;
      if (arg === "--config") i++;
    } else if (arg.startsWith("--") && arg.includes(".")) {
      // a config override: `--a.b value` takes the next argument unless it is `--a.b=value`
      if (!arg.includes("=") && argv[i + 1] !== undefined && !argv[i + 1]?.startsWith("--")) i++;
    } else if (arg.startsWith("--")) {
      return { error: `Unknown option ${arg}` };
    } else if (question === undefined) {
      question = arg;
    } else {
      return { error: `Unexpected argument "${arg}": put the question in quotes` };
    }
  }

  if (question === undefined || question.trim() === "") return { error: "No question given" };
  if (hasConfig && values.has("--variant")) {
    return { error: "Use --variant or --config, not both" };
  }

  let k: number | undefined;
  const rawK = values.get("--k");
  if (rawK !== undefined) {
    if (!/^\d+$/.test(rawK) || Number(rawK) < 1)
      return { error: "--k needs a whole number of 1 or more" };
    k = Number(rawK);
  }

  const filter = parseFilterArgs(argv);
  if ("error" in filter) return filter;

  const optional = (flag: string, key: string): Record<string, string> => {
    const value = values.get(flag);
    return value === undefined ? {} : { [key]: value };
  };
  return {
    question,
    json,
    filter: filter.filter,
    ...(k === undefined ? {} : { k }),
    ...optional("--variant", "variant"),
    ...optional("--chunker", "chunker"),
    ...optional("--embedder", "embedder"),
    ...optional("--index-dir", "indexDir"),
    ...optional("--cache-dir", "cacheDir"),
  };
}
