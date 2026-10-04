// Usage: pnpm export:markdown <file.pdf> [--out <file.md>] [--loader pdfjs|unpdf] [--no-clean]
//
// Runs the ingestion steps built so far on one PDF: load, clean (the cleaners from rag.config.json),
// detect sections. Prints an outline of the sections and, with --out, writes the whole document as
// Markdown so you can read it the way the pipeline sees it and check the headings by eye.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PdfJsLoader, UnpdfLoader } from "../src/adapters/index.js";
import { buildCleaner } from "../src/composition/index.js";
import { loadConfig } from "../src/config/index.js";
import type { DocumentLoader, Section } from "../src/core/index.js";
import { documentToMarkdown, FontHeadingDetector, outline } from "../src/strategies/index.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const file = args.find(
  (arg, i) => !arg.startsWith("--") && !["--out", "--loader"].includes(args[i - 1] ?? ""),
);
if (file === undefined) {
  console.error(
    "Usage: pnpm export:markdown <file.pdf> [--out <file.md>] [--loader pdfjs|unpdf] [--no-clean]",
  );
  process.exit(2);
}

const loaders: Record<string, DocumentLoader> = {
  pdfjs: new PdfJsLoader(),
  unpdf: new UnpdfLoader(),
};
const loader = loaders[flag("--loader") ?? "pdfjs"];
if (loader === undefined) {
  console.error(`Unknown loader. Use one of: ${Object.keys(loaders).join(", ")}`);
  process.exit(2);
}

const timed = async <T>(label: string, fn: () => T | Promise<T>): Promise<T> => {
  const started = performance.now();
  const result = await fn();
  console.log(`  ${label.padEnd(18)} ${(performance.now() - started).toFixed(0).padStart(6)} ms`);
  return result;
};

const config = await loadConfig({ argv: [], env: process.env });
console.log(
  `\n${file}  (loader: ${loader.name}, cleaners: ${args.includes("--no-clean") ? "none" : config.ingestion.cleaners.join(", ")})\n`,
);

const raw = await timed("load", () => loader.load(file));
const cleaned = args.includes("--no-clean")
  ? raw
  : await timed("clean", () => buildCleaner(config.ingestion.cleaners).clean(raw));
const doc = await timed("detect sections", () => new FontHeadingDetector().detect(cleaned));

const count = (sections: readonly Section[]): number =>
  sections.reduce((total, s) => total + 1 + count(s.children), 0);
console.log(
  `\n  ${doc.pageCount.toString()} pages, ${doc.text.length.toLocaleString("en-US")} characters, ${count(doc.sections).toString()} sections\n`,
);
console.log(doc.sections.length === 0 ? "  (no sections found)" : outline(doc.sections, "  "));

const out = flag("--out");
if (out !== undefined) {
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await writeFile(out, documentToMarkdown(doc));
  console.log(`\n  Wrote ${out}`);
}
console.log("");
