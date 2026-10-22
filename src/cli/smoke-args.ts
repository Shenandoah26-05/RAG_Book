export interface SmokeArgs {
  readonly updateBaseline: boolean;
  readonly margin?: number;
  readonly baselineFile?: string;
  readonly outDir?: string;
  readonly processedDir?: string;
  readonly indexDir?: string;
  readonly cacheDir?: string;
}

export const SMOKE_USAGE =
  "Usage: pnpm eval:smoke [--update-baseline] [--margin <0..1>] [--baseline <file>]\n" +
  "                       [--out <folder>] [--processed-dir <folder>] [--index-dir <folder>]\n" +
  "                       [--cache-dir <folder>]\n" +
  "  --update-baseline  record this run as the new baseline (commit the file, and say why)\n" +
  "  --margin <n>       how far recall@k may fall below the baseline (default: the baseline's)\n" +
  "  --baseline <file>  default: evals/baselines/smoke.json\n" +
  "Runs 10 questions through retrieval only (no answers are generated) and fails if recall@k\n" +
  "fell more than the margin below the stored baseline. Exit 0 pass, 1 regression, 2 could not run.";

const VALUE_FLAGS = new Set([
  "--margin",
  "--baseline",
  "--out",
  "--processed-dir",
  "--index-dir",
  "--cache-dir",
]);

/** Reads the command line of `pnpm eval:smoke`. */
export function parseSmokeArgs(argv: readonly string[]): SmokeArgs | { readonly error: string } {
  const values = new Map<string, string>();
  let updateBaseline = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const name = arg.split("=")[0] ?? "";
    if (arg === "--update-baseline") {
      updateBaseline = true;
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
    } else {
      return {
        error: arg.startsWith("--") ? `Unknown option ${arg}` : `Unexpected argument ${arg}`,
      };
    }
  }

  let margin: number | undefined;
  const rawMargin = values.get("--margin");
  if (rawMargin !== undefined) {
    margin = Number(rawMargin);
    if (!Number.isFinite(margin) || margin < 0 || margin > 1) {
      return { error: `--margin must be a number from 0 to 1, got "${rawMargin}"` };
    }
  }

  const optional = (flag: string, key: string): Record<string, string> => {
    const value = values.get(flag);
    return value === undefined ? {} : { [key]: value };
  };
  return {
    updateBaseline,
    ...(margin === undefined ? {} : { margin }),
    ...optional("--baseline", "baselineFile"),
    ...optional("--out", "outDir"),
    ...optional("--processed-dir", "processedDir"),
    ...optional("--index-dir", "indexDir"),
    ...optional("--cache-dir", "cacheDir"),
  };
}
