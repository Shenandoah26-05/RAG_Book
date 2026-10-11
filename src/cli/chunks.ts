import { buildInspect, describeInspection } from "../composition/index.js";
import { CHUNKS_USAGE, parseChunksArgs } from "./chunks-args.js";

const args = parseChunksArgs(process.argv.slice(2));

if ("error" in args) {
  console.error(`${args.error}\n\n${CHUNKS_USAGE}`);
  process.exitCode = 2;
} else {
  try {
    const inspector = await buildInspect(args.dir === undefined ? {} : { processedDir: args.dir });
    const result = await inspector.run(args.target, {
      ...(args.strategy === undefined ? {} : { strategy: args.strategy }),
      ...(args.samples === undefined ? {} : { samples: args.samples }),
      ...(args.seed === undefined ? {} : { seed: args.seed }),
    });
    console.log(describeInspection(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
