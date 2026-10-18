export interface IndexArgs {
  /** Document ids or PDF paths. Empty means every processed document. */
  readonly targets: readonly string[];
  readonly chunker?: string;
  readonly embedder?: string;
  readonly force: boolean;
  readonly processedDir?: string;
  readonly indexDir?: string;
  readonly cacheDir?: string;
}

export const INDEX_USAGE =
  "Usage: pnpm index [doc-id | file.pdf ...] [--chunker <name>] [--embedder <provider:model>] [--force]\n" +
  "                  [--processed-dir <folder>] [--index-dir <folder>] [--cache-dir <folder>]\n" +
  "  --chunker <name>        chunking strategy (default: chunking.strategy in the config)\n" +
  "  --embedder <p:model>    e.g. ollama:all-minilm (default: embedding.provider and embedding.model)\n" +
  "  --force                 build again even if the index is up to date\n" +
  "  --processed-dir <dir>   where processed documents are (default: data/processed)\n" +
  "  --index-dir <dir>       where indexes go (default: vectorStore.dir, data/index)\n" +
  "  --cache-dir <dir>       embedding cache (default: data/cache/embeddings)\n" +
  "  --<section>.<key>       override a config setting, e.g. --chunking.max-tokens 200\n" +
  "With no document, every document in the processed folder is indexed.\n" +
  "The index is written to <index-dir>/<chunker>__<embedder>/.";

const VALUE_FLAGS = new Set([
  "--chunker",
  "--embedder",
  "--processed-dir",
  "--index-dir",
  "--cache-dir",
]);

/**
 * Reads the command line of `pnpm index`. Flags written as `--section.key` are config overrides
 * for the config loader, so they are skipped here (with their value, if they take one).
 */
export function parseIndexArgs(argv: readonly string[]): IndexArgs | { readonly error: string } {
  const targets: string[] = [];
  const values = new Map<string, string>();
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const name = arg.split("=")[0] ?? "";
    if (arg === "--force") {
      force = true;
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
    } else if (arg.startsWith("--") && arg.includes(".")) {
      // a config override: `--a.b value` takes the next argument unless it is `--a.b=value`
      if (!arg.includes("=") && argv[i + 1] !== undefined && !argv[i + 1]?.startsWith("--")) i++;
    } else if (arg === "--config") {
      i++;
    } else if (arg.startsWith("--")) {
      if (!arg.startsWith("--config=")) return { error: `Unknown option ${arg}` };
    } else {
      targets.push(arg);
    }
  }

  const optional = (flag: string, key: string): Record<string, string> => {
    const value = values.get(flag);
    return value === undefined ? {} : { [key]: value };
  };
  return {
    targets,
    force,
    ...optional("--chunker", "chunker"),
    ...optional("--embedder", "embedder"),
    ...optional("--processed-dir", "processedDir"),
    ...optional("--index-dir", "indexDir"),
    ...optional("--cache-dir", "cacheDir"),
  };
}
