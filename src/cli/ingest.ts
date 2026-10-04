import { buildIngest } from "../composition/index.js";
import { INGEST_USAGE, parseIngestArgs } from "./ingest-args.js";

const args = parseIngestArgs(process.argv.slice(2));

if ("error" in args) {
  console.error(`${args.error}\n\n${INGEST_USAGE}`);
  process.exitCode = 2;
} else {
  try {
    const ingester = await buildIngest(args.outDir === undefined ? {} : { outDir: args.outDir });
    // progress, page and section counts and timing are logged by the pipeline
    await ingester.run(args.file, { force: args.force });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
