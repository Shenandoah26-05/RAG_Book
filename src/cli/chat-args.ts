export interface ChatArgs {
  readonly k?: number;
  readonly debug: boolean;
  readonly variant?: string;
  readonly indexDir?: string;
  readonly cacheDir?: string;
}

export const CHAT_USAGE =
  "Usage: pnpm chat [--k <n>] [--debug] [--variant <name|file>]\n" +
  "                 [--index-dir <folder>] [--cache-dir <folder>]\n" +
  "  --k <n>              how many chunks to use for each question (default: retrieval.k)\n" +
  "  --debug              start with the trace on (toggle it with /debug)\n" +
  "  --variant <name>     use configs/variants/<name>.json as the config (or give a file path)\n" +
  "  --index-dir <dir>    where indexes are (default: vectorStore.dir, data/index)\n" +
  "  --cache-dir <dir>    embedding cache (default: data/cache/embeddings)\n" +
  "  --<section>.<key>    override a config setting, e.g. --retrieval.strategy bm25\n" +
  "Type your questions at the prompt; /help lists the commands. With input piped in, each line\n" +
  "is a question and only the answers are printed.";

const VALUE_FLAGS = new Set(["--k", "--variant", "--index-dir", "--cache-dir"]);

/**
 * Reads the command line of `pnpm chat`. Flags written as `--section.key` are config overrides for
 * the config loader and are skipped here, with their values.
 */
export function parseChatArgs(
  argv: readonly string[],
): ChatArgs | { readonly error: string } | { readonly help: true } {
  let debug = false;
  let hasConfig = false;
  const values = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const name = arg.split("=")[0] ?? "";
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else if (arg === "--debug") {
      debug = true;
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
    } else if (arg === "--config" || arg.startsWith("--config=")) {
      hasConfig = true;
      if (arg === "--config") i++;
    } else if (arg.startsWith("--") && arg.includes(".")) {
      // a config override: `--a.b value` takes the next argument unless it is `--a.b=value`
      if (!arg.includes("=") && argv[i + 1] !== undefined && !argv[i + 1]?.startsWith("--")) i++;
    } else if (arg.startsWith("--")) {
      return { error: `Unknown option ${arg}` };
    } else {
      return { error: `Unexpected argument "${arg}": type your questions at the prompt` };
    }
  }

  if (hasConfig && values.has("--variant")) {
    return { error: "Use --variant or --config, not both" };
  }

  let k: number | undefined;
  const rawK = values.get("--k");
  if (rawK !== undefined) {
    if (!/^\d+$/.test(rawK) || Number(rawK) < 1) {
      return { error: "--k needs a whole number of 1 or more" };
    }
    k = Number(rawK);
  }

  const optional = (flag: string, key: string): Record<string, string> => {
    const value = values.get(flag);
    return value === undefined ? {} : { [key]: value };
  };
  return {
    debug,
    ...(k === undefined ? {} : { k }),
    ...optional("--variant", "variant"),
    ...optional("--index-dir", "indexDir"),
    ...optional("--cache-dir", "cacheDir"),
  };
}
