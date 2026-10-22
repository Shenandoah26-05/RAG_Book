import { describeRegression, runSmoke } from "../composition/index.js";
import { parseSmokeArgs, SMOKE_USAGE } from "./smoke-args.js";

const args = parseSmokeArgs(process.argv.slice(2));

if ("error" in args) {
  console.error(`${args.error}\n\n${SMOKE_USAGE}`);
  process.exitCode = 2;
} else {
  // Ctrl+C stops after the question in progress; nothing is recorded or compared
  const controller = new AbortController();
  process.once("SIGINT", () => {
    console.error("\nStopping...");
    controller.abort();
  });
  try {
    const outcome = await runSmoke(
      {
        updateBaseline: args.updateBaseline,
        ...(args.margin === undefined ? {} : { margin: args.margin }),
        ...(args.baselineFile === undefined ? {} : { baselineFile: args.baselineFile }),
        ...(args.outDir === undefined ? {} : { outDir: args.outDir }),
        ...(args.processedDir === undefined ? {} : { processedDir: args.processedDir }),
        ...(args.indexDir === undefined ? {} : { indexDir: args.indexDir }),
        ...(args.cacheDir === undefined ? {} : { cacheDir: args.cacheDir }),
      },
      controller.signal,
    );
    if (outcome.kind === "recorded") {
      const before = outcome.previous === undefined ? "none" : outcome.previous.recall.toFixed(3);
      console.log(
        `Recorded baseline: recall@${outcome.baseline.k.toString()} ${outcome.baseline.recall.toFixed(3)} ` +
          `(was ${before}), margin ${outcome.baseline.margin.toString()}.\n` +
          "Commit evals/baselines/smoke.json and say in the PR why it changed.",
      );
    } else {
      console.log(describeRegression(outcome.report));
      if (outcome.report.verdict === "regression") process.exitCode = 1;
      else if (outcome.report.verdict === "invalid") process.exitCode = 2;
    }
  } catch (error) {
    if (controller.signal.aborted) {
      console.error("Stopped.");
      process.exitCode = 130;
    } else {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  }
}
