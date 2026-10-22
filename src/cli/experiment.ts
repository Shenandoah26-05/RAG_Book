import { buildExperiment, describePlan, describeSummary } from "../composition/index.js";
import { EXPERIMENT_USAGE, parseExperimentArgs } from "./experiment-args.js";

const args = parseExperimentArgs(process.argv.slice(2));

if ("error" in args) {
  console.error(`${args.error}\n\n${EXPERIMENT_USAGE}`);
  process.exitCode = 2;
} else {
  try {
    const experiment = await buildExperiment({
      file: args.file,
      only: args.only,
      ...(args.limit === undefined ? {} : { limit: args.limit }),
      ...(args.outDir === undefined ? {} : { outDir: args.outDir }),
      ...(args.processedDir === undefined ? {} : { processedDir: args.processedDir }),
      ...(args.indexDir === undefined ? {} : { indexDir: args.indexDir }),
      ...(args.cacheDir === undefined ? {} : { cacheDir: args.cacheDir }),
    });

    if (args.dryRun) {
      console.log(describePlan(experiment.plan, experiment.location));
    } else {
      // Ctrl+C stops after the question in progress; what finished is already on disk
      const controller = new AbortController();
      process.once("SIGINT", () => {
        console.error("\nStopping after the current question...");
        controller.abort();
      });
      try {
        const summary = await experiment.run(controller.signal);
        console.log(describeSummary(summary, experiment.location));
        if (summary.variants.some((v) => v.error !== undefined || v.questions.failed > 0)) {
          process.exitCode = 1;
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        console.error(`Stopped. Results so far are in ${experiment.location}`);
        process.exitCode = 130;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
