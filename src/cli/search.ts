import { buildSearcher, describeSearch, searchToJson } from "../composition/index.js";
import { createConsoleLogger } from "../shared/index.js";
import { parseSearchArgs, SEARCH_USAGE } from "./search-args.js";

const args = parseSearchArgs(process.argv.slice(2));

if ("error" in args) {
  console.error(`${args.error}\n\n${SEARCH_USAGE}`);
  process.exitCode = 2;
} else {
  try {
    // with --json nothing but the JSON goes to standard output; progress logs stay on standard error
    const searcher = await buildSearcher({
      logger: createConsoleLogger(),
      ...(args.variant === undefined ? {} : { variant: args.variant }),
      ...(args.indexDir === undefined ? {} : { indexDir: args.indexDir }),
      ...(args.cacheDir === undefined ? {} : { cacheDir: args.cacheDir }),
    });
    const report = await searcher.search(args.question, {
      filter: args.filter,
      ...(args.k === undefined ? {} : { k: args.k }),
      ...(args.chunker === undefined ? {} : { chunker: args.chunker }),
      ...(args.embedder === undefined ? {} : { embedder: args.embedder }),
    });
    console.log(args.json ? searchToJson(report) : describeSearch(report));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
