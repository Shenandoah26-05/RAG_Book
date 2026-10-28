// Usage: pnpm eval:promote <book.pdf or docId> [--candidates evals/candidates.jsonl]
//                          [--base evals/datasets/v1.jsonl] [--out evals/datasets/v2.jsonl]
//                          [--dry-run]
//
// Turns what readers rated (evals/candidates.jsonl, added by the API) into the next version of the
// evaluation dataset. Answers rated up become questions with their cited passages as gold; answers
// rated down are written to <out>.review.jsonl for a person to label. The base dataset is never
// changed, an existing output is never overwritten, and nothing is written unless the new dataset
// passes the same checks as `pnpm eval:validate`.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileDocumentStore } from "../src/adapters/index.js";
import { DEFAULT_PROCESSED_DIR } from "../src/composition/index.js";
import { resolveDocId } from "../src/composition/resolve-doc-id.js";
import {
  checkDatasetAgainstDocument,
  checkDatasetShape,
  countByKind,
  datasetMetaSchema,
  formatDatasetViolations,
  parseCandidates,
  parseDataset,
  nextVersion,
  promoteCandidates,
} from "../src/eval/index.js";

const USAGE =
  "Usage: pnpm eval:promote <book.pdf or docId> [--candidates <file>] [--base <dataset.jsonl>]\n" +
  "                         [--out <dataset.jsonl>] [--dry-run]";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const VALUE_FLAGS = ["--candidates", "--base", "--out"];
const target = args.find(
  (arg, i) => !arg.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1] ?? ""),
);
const dryRun = args.includes("--dry-run");
const candidatesPath = flag("--candidates") ?? "evals/candidates.jsonl";
const basePath = flag("--base") ?? "evals/datasets/v1.jsonl";
const metaPathOf = (jsonl: string): string => jsonl.replace(/\.jsonl$/, ".meta.json");

if (target === undefined || VALUE_FLAGS.some((f) => args.includes(f) && flag(f) === undefined)) {
  console.error(USAGE);
  process.exit(2);
}

try {
  const baseMeta = datasetMetaSchema.parse(
    JSON.parse(await readFile(metaPathOf(basePath), "utf8")),
  );
  const base = parseDataset(await readFile(basePath, "utf8"));

  const version = nextVersion(baseMeta.version);
  const outPath =
    flag("--out") ??
    (version === undefined ? undefined : path.join(path.dirname(basePath), `${version}.jsonl`));
  if (outPath === undefined) {
    console.error(
      `"${baseMeta.version}" has no next version: say where the new dataset goes with --out.\n${USAGE}`,
    );
    process.exit(2);
  }
  const outMetaPath = metaPathOf(outPath);
  const reviewPath = outPath.replace(/\.jsonl$/, ".review.jsonl");
  const outVersion = path.basename(outPath, ".jsonl");
  const taken = [outPath, outMetaPath, reviewPath].filter(existsSync);
  if (taken.length > 0 && !dryRun) {
    console.error(
      `Refusing to overwrite ${taken.join(", ")}. A dataset version is never changed once written; choose another --out.`,
    );
    process.exit(1);
  }

  if (!existsSync(candidatesPath)) {
    console.error(
      `No feedback yet: ${candidatesPath} does not exist. Rate some answers in the web app first.`,
    );
    process.exit(1);
  }
  const { candidates, malformed } = parseCandidates(await readFile(candidatesPath, "utf8"));
  for (const m of malformed)
    console.warn(`${candidatesPath} line ${m.line.toString()} ignored: ${m.message}`);

  const store = new FileDocumentStore(DEFAULT_PROCESSED_DIR);
  const doc = await store.load(await resolveDocId(target));
  if (doc === undefined) {
    console.error("That book has not been processed. Run: pnpm ingest <pdf>");
    process.exit(1);
  }

  const meta = { ...baseMeta, version: outVersion };
  const promotion = promoteCandidates({ base, meta, doc, candidates });

  const violations = [
    ...checkDatasetShape(promotion.questions, meta),
    ...checkDatasetAgainstDocument(promotion.questions, meta, doc),
  ];
  if (violations.length > 0) {
    console.error(
      `The new dataset would not pass validation, so nothing was written:\n${formatDatasetViolations(violations)}`,
    );
    process.exit(1);
  }

  const counts = countByKind(promotion.added);
  console.log(
    `${candidates.length.toString()} ratings read: ${promotion.added.length.toString()} promoted ` +
      `(${counts.factual.toString()} factual, ${counts["multi-part"].toString()} multi-part, ` +
      `${counts.unanswerable.toString()} unanswerable), ${promotion.review.length.toString()} to review, ` +
      `${promotion.skipped.length.toString()} skipped.`,
  );
  for (const s of promotion.skipped) console.log(`  skipped "${s.question}": ${s.reason}`);

  if (dryRun) {
    console.log("Dry run: nothing written.");
  } else if (promotion.added.length === 0 && promotion.review.length === 0) {
    console.log("Nothing to promote or review, so no new version was made.");
  } else {
    const lines = (items: readonly unknown[]): string =>
      items.map((i) => JSON.stringify(i)).join("\n") + (items.length > 0 ? "\n" : "");
    if (promotion.added.length > 0) {
      await writeFile(outPath, lines(promotion.questions), "utf8");
      await writeFile(outMetaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
      console.log(
        `Wrote ${outPath} (${promotion.questions.length.toString()} questions) and ${outMetaPath}.`,
      );
      console.log(`Check it against the book with: pnpm eval:validate <book> --dataset ${outPath}`);
    }
    if (promotion.review.length > 0) {
      await writeFile(reviewPath, lines(promotion.review), "utf8");
      console.log(
        `Wrote ${reviewPath}: ${promotion.review.length.toString()} answers a person must label.`,
      );
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
