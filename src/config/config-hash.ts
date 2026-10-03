import { contentHash } from "../core/index.js";
import type { RagConfig } from "./schema.js";

/** JSON with object keys sorted, so the same settings always serialise the same way. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Stable SHA-256 (hex) of a configuration, independent of key order. Experiment results are tagged
 * with it so a number can always be traced back to the exact settings that produced it.
 */
export function hashConfig(config: RagConfig): string {
  return contentHash("config", canonicalJson(config));
}
