// Usage: pnpm compare:extractors <file.pdf> [--out <dir>] [--diffs <n>]
//
// Runs both PDF loaders on one file and reports how their output differs: speed, text volume, the
// font detail each one keeps, and where the text differs page by page. With --out, the full text
// of each loader is written to <dir>/pdfjs.txt and <dir>/unpdf.txt for a visual diff.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PdfJsLoader, UnpdfLoader } from "../src/adapters/index.js";
import type { DocumentLoader, ParsedDocument } from "../src/core/index.js";
import { compareDocuments, summarize } from "./compare-extractors-lib.js";
import type { DocumentSummary } from "./compare-extractors-lib.js";

function parseArgs(argv: readonly string[]): { file: string; out?: string; diffs: number } {
  let file: string | undefined;
  let out: string | undefined;
  let diffs = 8;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") out = argv[++i];
    else if (arg === "--diffs") diffs = Number(argv[++i]);
    else if (arg !== undefined && !arg.startsWith("--")) file = arg;
  }
  if (file === undefined || Number.isNaN(diffs)) {
    console.error("Usage: pnpm compare:extractors <file.pdf> [--out <dir>] [--diffs <n>]");
    process.exit(2);
  }
  return out === undefined ? { file, diffs } : { file, out, diffs };
}

interface Run {
  readonly loader: DocumentLoader;
  readonly doc: ParsedDocument;
  readonly ms: number;
  readonly summary: DocumentSummary;
}

async function run(loader: DocumentLoader, file: string): Promise<Run> {
  const started = performance.now();
  const doc = await loader.load(file);
  const ms = performance.now() - started;
  return { loader, doc, ms, summary: summarize(doc) };
}

const fmt = (n: number): string => n.toLocaleString("en-US");
const row = (label: string, ...cells: string[]): string =>
  `  ${label.padEnd(26)}${cells.map((c) => c.padStart(14)).join("")}`;

const { file, out, diffs } = parseArgs(process.argv.slice(2));

const a = await run(new PdfJsLoader(), file);
const b = await run(new UnpdfLoader(), file);
const comparison = compareDocuments(a.doc, b.doc);

console.log(`\nFile: ${file}  (title: ${a.doc.title})\n`);
console.log(row("", a.loader.name, b.loader.name));
console.log(row("time (ms, single run)", fmt(Math.round(a.ms)), fmt(Math.round(b.ms))));
console.log(row("pages", fmt(a.summary.pages), fmt(b.summary.pages)));
console.log(row("pages without text", fmt(a.summary.emptyPages), fmt(b.summary.emptyPages)));
console.log(row("characters", fmt(a.summary.chars), fmt(b.summary.chars)));
console.log(row("words", fmt(a.summary.words), fmt(b.summary.words)));
console.log(row("text items", fmt(a.summary.items), fmt(b.summary.items)));
console.log(row("bold items", fmt(a.summary.boldItems), fmt(b.summary.boldItems)));
console.log(
  row("distinct font names", fmt(a.summary.fontNames.length), fmt(b.summary.fontNames.length)),
);
console.log(row("same doc id", String(a.doc.id === b.doc.id), ""));

const sizes = (s: DocumentSummary): string =>
  s.topSizes.map(([size, chars]) => `${size.toString()}pt(${fmt(chars)})`).join("  ") || "none";
console.log(`\n  Font sizes by amount of text (characters):`);
console.log(`    ${a.loader.name}: ${sizes(a.summary)}`);
console.log(`    ${b.loader.name}: ${sizes(b.summary)}`);

const fonts = (s: DocumentSummary): string => s.fontNames.slice(0, 8).join(", ") || "none";
console.log(`\n  Font names (first 8):`);
console.log(`    ${a.loader.name}: ${fonts(a.summary)}`);
console.log(`    ${b.loader.name}: ${fonts(b.summary)}`);

console.log(
  `\n  Pages identical:                      ${fmt(comparison.identical)} / ${fmt(comparison.pages)}`,
);
console.log(
  `  Pages identical ignoring whitespace:  ${fmt(comparison.identicalIgnoringWhitespace)} / ${fmt(comparison.pages)}`,
);

const real = comparison.differing.filter((d) => !d.whitespaceOnly);
console.log(`  Pages with real text differences:     ${fmt(real.length)}`);
for (const { page, difference } of real.slice(0, diffs)) {
  console.log(`\n  page ${fmt(page)}, first difference at character ${fmt(difference.index)}:`);
  console.log(`    ${a.loader.name}: ${difference.a}`);
  console.log(`    ${b.loader.name}: ${difference.b}`);
}
if (real.length > diffs) console.log(`\n  ... and ${fmt(real.length - diffs)} more (use --diffs).`);

if (out !== undefined) {
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, "pdfjs.txt"), a.doc.text);
  await writeFile(path.join(out, "unpdf.txt"), b.doc.text);
  console.log(`\n  Wrote ${path.join(out, "pdfjs.txt")} and ${path.join(out, "unpdf.txt")}`);
}
console.log("");
