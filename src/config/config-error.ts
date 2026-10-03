import { RagError } from "../shared/index.js";

/** Thrown at startup when the configuration cannot be used. `message` lists every problem found. */
export class ConfigError extends RagError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      "CONFIG_INVALID",
      `Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`,
    );
    this.name = "ConfigError";
    this.issues = issues;
  }
}
