export interface ChunksArgs {
  /** A document id, or the path of the PDF that was ingested. */
  readonly target: string;
  readonly strategy?: string;
  readonly samples?: number;
  readonly seed?: number;
  readonly dir?: string;
}

export const CHUNKS_USAGE =
  "Usage: pnpm chunks <doc-id | file.pdf> [--strategy <name>] [--samples <n>] [--seed <n>] [--dir <folder>]\n" +
  "  --strategy <name>  chunking strategy to look at (default: chunking.strategy in the config)\n" +
  "  --samples <n>      how many random chunks to print (default 3)\n" +
  "  --seed <n>         seed for the random pick, to see other chunks (default: fixed per document)\n" +
  "  --dir <folder>     where processed documents are, and the report goes (default: data/processed)\n" +
  "  --<section>.<key>  override a config setting, e.g. --chunking.max-tokens 200";

/** A whole number of 0 or more, or undefined. */
function wholeNumber(raw: string | undefined): number | undefined {
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/**
 * Reads the command line of `pnpm chunks`. Flags written as `--section.key` are config overrides
 * for the config loader, so they are skipped here (with their value, if they take one).
 */
export function parseChunksArgs(argv: readonly string[]): ChunksArgs | { readonly error: string } {
  let target: string | undefined;
  let strategy: string | undefined;
  let samples: number | undefined;
  let seed: number | undefined;
  let dir: string | undefined;

  /** The value of `--name value` or `--name=value`; undefined if there is none. */
  const valueOf = (arg: string, name: string, index: number): [string | undefined, number] => {
    if (arg.startsWith(`${name}=`)) return [arg.slice(name.length + 1), index];
    const next = argv[index + 1];
    return next === undefined || next.startsWith("--") ? [undefined, index] : [next, index + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const name = arg.split("=")[0] ?? "";
    if (name === "--strategy" || name === "--dir") {
      const [value, next] = valueOf(arg, name, i);
      if (value === undefined || value === "") return { error: `${name} needs a value` };
      if (name === "--strategy") strategy = value;
      else dir = value;
      i = next;
    } else if (name === "--samples" || name === "--seed") {
      const [value, next] = valueOf(arg, name, i);
      const number = wholeNumber(value);
      if (number === undefined) return { error: `${name} needs a whole number` };
      if (name === "--samples") samples = number;
      else seed = number;
      i = next;
    } else if (arg.startsWith("--") && arg.includes(".")) {
      // a config override: `--a.b value` takes the next argument unless it is `--a.b=value`
      if (!arg.includes("=") && argv[i + 1] !== undefined && !argv[i + 1]?.startsWith("--")) i++;
    } else if (arg === "--config") {
      i++;
    } else if (arg.startsWith("--")) {
      if (!arg.startsWith("--config=")) return { error: `Unknown option ${arg}` };
    } else if (target === undefined) {
      target = arg;
    } else {
      return { error: `Unexpected argument "${arg}": chunks takes one document` };
    }
  }

  if (target === undefined) return { error: "No document given" };
  return {
    target,
    ...(strategy === undefined ? {} : { strategy }),
    ...(samples === undefined ? {} : { samples }),
    ...(seed === undefined ? {} : { seed }),
    ...(dir === undefined ? {} : { dir }),
  };
}
