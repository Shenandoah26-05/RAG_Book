export const DEFAULT_PORT = 8787;
/** The loopback address: only this machine can reach the server. There is no login (ADR-0006). */
export const DEFAULT_HOST = "127.0.0.1";

export interface ApiArgs {
  readonly port: number;
  readonly host: string;
  /** Web pages allowed to call the API, in addition to the Vite dev server. */
  readonly origins: readonly string[];
  readonly variant?: string;
  readonly processedDir?: string;
  readonly indexDir?: string;
  readonly cacheDir?: string;
}

export const API_USAGE =
  "Usage: pnpm api [--port <n>] [--host <address>] [--origin <url>]... [--variant <name>]\n" +
  "                [--processed-dir <folder>] [--index-dir <folder>] [--cache-dir <folder>]\n" +
  `  --port <n>             where to listen (default: ${DEFAULT_PORT.toString()})\n` +
  `  --host <address>       the address to bind (default: ${DEFAULT_HOST}, this machine only).\n` +
  "                         The API has no login: do not bind it to an address others can reach.\n" +
  "  --origin <url>         a web page allowed to call the API from a browser, e.g. http://localhost:3000\n" +
  "                         (repeat for several; the Vite dev server, http://localhost:5173, is always allowed)\n" +
  "  --variant <name>       use a variant from configs/variants as the configuration\n" +
  "  --processed-dir <dir>  where processed documents are (default: data/processed)\n" +
  "  --index-dir <dir>      where indexes are (default: vectorStore.dir, data/index)\n" +
  "  --cache-dir <dir>      embedding cache (default: data/cache/embeddings)\n" +
  "  --<section>.<key>      override a config setting, e.g. --retrieval.k 8\n" +
  'The index must exist: run "pnpm index" first.';

const VALUE_FLAGS = new Set([
  "--port",
  "--host",
  "--origin",
  "--variant",
  "--processed-dir",
  "--index-dir",
  "--cache-dir",
]);

/** An origin is `scheme://host[:port]` and nothing more: no path, no trailing slash. */
function normalizeOrigin(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Reads the command line of `pnpm api`. Flags written as `--section.key` are config overrides for the
 * config loader, so they are skipped here (with their value, if they take one).
 */
export function parseApiArgs(argv: readonly string[]): ApiArgs | { readonly error: string } {
  const values = new Map<string, string>();
  const origins: string[] = [];

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
      if (name === "--origin") {
        const origin = normalizeOrigin(value);
        if (origin === undefined) {
          return { error: `--origin must look like http://localhost:3000, got "${value}"` };
        }
        origins.push(origin);
      } else {
        values.set(name, value);
      }
    } else if (arg.startsWith("--") && arg.includes(".")) {
      // a config override: `--a.b value` takes the next argument unless it is `--a.b=value`
      if (!arg.includes("=") && argv[i + 1] !== undefined && !argv[i + 1]?.startsWith("--")) i++;
    } else if (arg === "--config") {
      i++;
    } else if (arg.startsWith("--config=")) {
      // read by the config loader
    } else if (arg.startsWith("--")) {
      return { error: `Unknown option ${arg}` };
    } else {
      return { error: `Unexpected argument "${arg}"` };
    }
  }

  let port = DEFAULT_PORT;
  const rawPort = values.get("--port");
  if (rawPort !== undefined) {
    port = Number(rawPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      return { error: `--port must be a whole number from 0 to 65535, got "${rawPort}"` };
    }
  }

  const optional = (flag: string, key: string): Record<string, string> => {
    const value = values.get(flag);
    return value === undefined ? {} : { [key]: value };
  };
  return {
    port,
    host: values.get("--host") ?? DEFAULT_HOST,
    origins,
    ...optional("--variant", "variant"),
    ...optional("--processed-dir", "processedDir"),
    ...optional("--index-dir", "indexDir"),
    ...optional("--cache-dir", "cacheDir"),
  };
}
