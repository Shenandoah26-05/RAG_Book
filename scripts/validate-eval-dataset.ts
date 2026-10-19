// Usage: pnpm eval:validate <book.pdf or docId> [--dataset evals/datasets/v1.jsonl]
//
// Checks an evaluation dataset against the processed book it was written for: the shape of the whole
// set (enough questions, every kind, enough unanswerable ones) and every gold quote (the page exists
// and the words are on it, once). The book must already be ingested (`pnpm ingest <pdf>`).
import { readFile } from "node:fs/promises";
import { FileDocumentStore } from "../src/adapters/index.js";
import { DEFAULT_PROCESSED_DIR } from "../src/composition/index.js";
import { resolveDocId } from "../src/composition/resolve-doc-id.js";
import {
  checkDatasetAgainstDocument,
  checkDatasetShape,
  countByKind,
  datasetMetaSchema,
  formatDatasetViolations,
  parseDataset,
  resolveGold,
} from "../src/eval/index.js";

const args = process.argv.slice(2);
const at = args.indexOf("--dataset");
const datasetPath = at === -1 ? "evals/datasets/v1.jsonl" : (args[at + 1] ?? "");
const target = args.find((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--dataset");
if (target === undefined || datasetPath === "") {
  console.error(
    "Usage: pnpm eval:validate <book.pdf or docId> [--dataset evals/datasets/v1.jsonl]",
  );
  process.exit(2);
}

try {
  const questions = parseDataset(await readFile(datasetPath, "utf8"));
  const meta = datasetMetaSchema.parse(
    JSON.parse(await readFile(datasetPath.replace(/\.jsonl$/, ".meta.json"), "utf8")),
  );
  const store = new FileDocumentStore(DEFAULT_PROCESSED_DIR);
  const docId = await resolveDocId(target);
  const doc = await store.load(docId);
  if (doc === undefined) {
    console.error(`No processed document ${docId}. Run: pnpm ingest <pdf>`);
    process.exit(1);
  }

  const violations = [
    ...checkDatasetShape(questions, meta),
    ...checkDatasetAgainstDocument(questions, meta, doc),
  ];
  const counts = countByKind(questions);
  const spans = questions.flatMap((q) => q.gold).length;
  console.log(
    `${datasetPath}: ${questions.length.toString()} questions ` +
      `(${counts.factual.toString()} factual, ${counts["multi-part"].toString()} multi-part, ` +
      `${counts.unanswerable.toString()} unanswerable), ${spans.toString()} gold passages`,
  );
  if (violations.length > 0) {
    console.error(formatDatasetViolations(violations));
    process.exit(1);
  }
  const resolved = questions.flatMap((q) => q.gold.map((g) => resolveGold(doc, g)));
  console.log(`OK: all ${resolved.length.toString()} gold quotes found once in "${doc.title}".`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
