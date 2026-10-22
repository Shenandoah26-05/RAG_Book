export interface ExperimentArgs {
  /** The experiment file. */
  readonly file: string;
  /** Run only these variants. Empty means all. */
  readonly only: readonly string[];
  readonly limit?: number;
  readonly dryRun: boolean;
  readonly outDir?: string;
  readonly processedDir?: string;
  readonly indexDir?: string;
  readonly cacheDir?: string;
}

export const EXPERIMENT_USAGE =
  "Usage: pnpm experiment <experiment.json> [--variant <name>]... [--limit <n>] [--dry-run]\n" +
  "                       [--out <folder>] [--processed-dir <folder>] [--index-dir <folder>]\n" +
  "                       [--cache-dir <folder>]\n" +
  "  --variant <name>       run only this variant (repeat for several)\n" +
  "  --limit <n>            use only the first n questions, for a quick try\n" +
  "  --dry-run              list the variants and the dataset, run nothing\n" +
  "  --out <dir>            where runs are saved (default: evals/results)\n" +
  "  --processed-dir <dir>  where processed documents are (default: data/processed)\n" +
  "  --index-dir <dir>      where indexes go (default: vectorStore.dir, data/index)\n" +
  "  --cache-dir <dir>      embedding cache (default: data/cache/embeddings)\n" +
  "Each variant is built (its index is reused if one exists), asked every question of the dataset,\n" +
  "and scored. Results go to <out>/<experiment>/<time>/results.jsonl and summary.json.";

const VALUE_FLAGS = new Set([
  "--variant",
  "--limit",
  "--out",
  "--processed-dir",
  "--index-dir",
  "--cache-dir",
]);

/** Reads the command line of `pnpm experiment`. */
export function parseExperimentArgs(
  argv: readonly string[],
): ExperimentArgs | { readonly error: string } {
  const positional: string[] = [];
  const only: string[] = [];
  const values = new Map<string, string>();
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const name = arg.split("=")[0] ?? "";
    if (arg === "--dry-run") {
      dryRun = true;
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
      if (name === "--variant") only.push(value);
      else values.set(name, value);
    } else if (arg.startsWith("--")) {
      return { error: `Unknown option ${arg}` };
    } else {
      positional.push(arg);
    }
  }

  const [file, ...extra] = positional;
  if (file === undefined) return { error: "Name an experiment file" };
  if (extra.length > 0) {
    return { error: `Expected one experiment file, got ${positional.length.toString()}` };
  }

  let limit: number | undefined;
  const rawLimit = values.get("--limit");
  if (rawLimit !== undefined) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1) {
      return { error: `--limit must be a whole number of 1 or more, got "${rawLimit}"` };
    }
  }

  const optional = (flag: string, key: string): Record<string, string> => {
    const value = values.get(flag);
    return value === undefined ? {} : { [key]: value };
  };
  return {
    file,
    only,
    dryRun,
    ...(limit === undefined ? {} : { limit }),
    ...optional("--out", "outDir"),
    ...optional("--processed-dir", "processedDir"),
    ...optional("--index-dir", "indexDir"),
    ...optional("--cache-dir", "cacheDir"),
  };
}
