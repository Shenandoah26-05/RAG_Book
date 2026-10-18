import { buildIndexer, describeIndex } from "../composition/index.js";
import { INDEX_USAGE, parseIndexArgs } from "./index-args.js";

const args = parseIndexArgs(process.argv.slice(2));

if ("error" in args) {
  console.error(`${args.error}\n\n${INDEX_USAGE}`);
  process.exitCode = 2;
} else {
  try {
    const indexer = await buildIndexer({
      ...(args.processedDir === undefined ? {} : { processedDir: args.processedDir }),
      ...(args.indexDir === undefined ? {} : { indexDir: args.indexDir }),
      ...(args.cacheDir === undefined ? {} : { cacheDir: args.cacheDir }),
    });
    const result = await indexer.run({
      targets: args.targets,
      force: args.force,
      ...(args.chunker === undefined ? {} : { chunker: args.chunker }),
      ...(args.embedder === undefined ? {} : { embedder: args.embedder }),
    });
    console.log(describeIndex(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
