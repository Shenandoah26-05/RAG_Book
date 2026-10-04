export interface IngestArgs {
  readonly file: string;
  readonly force: boolean;
  readonly outDir?: string;
}

export const INGEST_USAGE =
  "Usage: pnpm ingest <file.pdf> [--force] [--out-dir <folder>]\n" +
  "  --force            process the file again even if a result is already stored\n" +
  "  --out-dir <folder> where processed documents go (default: data/processed)\n" +
  "  --<section>.<key>  override a config setting, e.g. --ingestion.loader unpdf";

/**
 * Reads the command line of `pnpm ingest`. Flags written as `--section.key` are config overrides
 * for the config loader, so they are skipped here (with their value, if they take one).
 */
export function parseIngestArgs(argv: readonly string[]): IngestArgs | { readonly error: string } {
  let file: string | undefined;
  let force = false;
  let outDir: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--force") {
      force = true;
    } else if (arg === "--out-dir") {
      outDir = argv[++i];
      if (outDir === undefined || outDir.startsWith("--"))
        return { error: "--out-dir needs a folder" };
    } else if (arg.startsWith("--out-dir=")) {
      outDir = arg.slice("--out-dir=".length);
    } else if (arg.startsWith("--") && arg.includes(".")) {
      // a config override: `--a.b value` takes the next argument unless it is `--a.b=value`
      if (!arg.includes("=") && argv[i + 1] !== undefined && !argv[i + 1]?.startsWith("--")) i++;
    } else if (arg.startsWith("--")) {
      return { error: `Unknown option ${arg}` };
    } else if (file === undefined) {
      file = arg;
    } else {
      return { error: `Unexpected argument "${arg}": ingest takes one file` };
    }
  }

  if (file === undefined) return { error: "No file given" };
  return outDir === undefined ? { file, force } : { file, force, outDir };
}
