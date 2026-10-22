import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildReport } from "../composition/index.js";
import { parseReportArgs, REPORT_USAGE } from "./report-args.js";

const args = parseReportArgs(process.argv.slice(2));

if ("error" in args) {
  console.error(`${args.error}\n\n${REPORT_USAGE}`);
  process.exitCode = 2;
} else {
  try {
    const report = await buildReport({
      target: args.target,
      ...(args.baseline === undefined ? {} : { baseline: args.baseline }),
      ...(args.metric === undefined ? {} : { metric: args.metric }),
      ...(args.top === undefined ? {} : { top: args.top }),
      ...(args.resultsDir === undefined ? {} : { resultsDir: args.resultsDir }),
    });
    const file = args.out ?? path.join(report.runDir, "report.md");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, report.markdown, "utf8");

    // the summary section is the answer; the rest is in the file
    const summary = /## Summary\n([\s\S]*?)\n## /.exec(report.markdown)?.[1]?.trim();
    console.log(`${summary ?? ""}\n\nReport written to ${file}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
