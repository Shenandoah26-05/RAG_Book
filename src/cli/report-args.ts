import { isMetricName, METRIC_NAMES } from "../eval/index.js";
import type { MetricName } from "../eval/index.js";

export interface ReportArgs {
  /** A run folder, or an experiment name (its latest run). */
  readonly target: string;
  readonly baseline?: string;
  readonly metric?: MetricName;
  readonly top?: number;
  /** Where to write the report. Default: `report.md` in the run folder. */
  readonly out?: string;
  readonly resultsDir?: string;
}

export const REPORT_USAGE =
  "Usage: pnpm report <run-folder | experiment-name> [--baseline <variant>] [--metric <name>]\n" +
  "                   [--top <n>] [--out <file.md>] [--results-dir <folder>]\n" +
  "  --baseline <variant>   what the others are compared with (default: the first variant)\n" +
  `  --metric <name>        what to rank and compare by: ${METRIC_NAMES.join(", ")} (default: ndcg)\n` +
  "  --top <n>              biggest wins and losses to list per variant (default: 5)\n" +
  "  --out <file>           where to write the report (default: report.md in the run folder)\n" +
  "  --results-dir <dir>    where experiment runs are (default: evals/results)\n" +
  'An experiment name means its latest run. Run "pnpm experiment <file>" first.';

const VALUE_FLAGS = new Set(["--baseline", "--metric", "--top", "--out", "--results-dir"]);

/** Reads the command line of `pnpm report`. */
export function parseReportArgs(argv: readonly string[]): ReportArgs | { readonly error: string } {
  const positional: string[] = [];
  const values = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const name = arg.split("=")[0] ?? "";
    if (VALUE_FLAGS.has(name)) {
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
    } else if (arg.startsWith("--")) {
      return { error: `Unknown option ${arg}` };
    } else {
      positional.push(arg);
    }
  }

  const [target, ...extra] = positional;
  if (target === undefined) return { error: "Name a run folder or an experiment" };
  if (extra.length > 0) {
    return { error: `Expected one run folder or experiment, got ${positional.length.toString()}` };
  }

  const metric = values.get("--metric");
  if (metric !== undefined && !isMetricName(metric)) {
    return { error: `--metric must be one of ${METRIC_NAMES.join(", ")}, got "${metric}"` };
  }
  let top: number | undefined;
  const rawTop = values.get("--top");
  if (rawTop !== undefined) {
    top = Number(rawTop);
    if (!Number.isInteger(top) || top < 1) {
      return { error: `--top must be a whole number of 1 or more, got "${rawTop}"` };
    }
  }

  const optional = (flag: string, key: string): Record<string, string> => {
    const value = values.get(flag);
    return value === undefined ? {} : { [key]: value };
  };
  return {
    target,
    ...optional("--baseline", "baseline"),
    ...(metric === undefined || !isMetricName(metric) ? {} : { metric }),
    ...(top === undefined ? {} : { top }),
    ...optional("--out", "out"),
    ...optional("--results-dir", "resultsDir"),
  };
}
