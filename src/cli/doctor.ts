import { existsSync } from "node:fs";
import { buildDoctor } from "../composition/index.js";
import { formatReport, hasFailures } from "./doctor-report.js";

try {
  // Settings in .env fill in what the shell has not set; real environment variables win.
  if (existsSync(".env")) process.loadEnvFile(".env");

  const doctor = await buildDoctor();
  const results = await doctor.run();
  console.log(formatReport(results));
  if (hasFailures(results)) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
