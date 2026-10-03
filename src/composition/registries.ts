import type { Cleaner } from "../core/index.js";
import { RagError } from "../shared/index.js";
import {
  CleaningChain,
  DehyphenateCleaner,
  HeaderFooterCleaner,
  PageNumberCleaner,
  UnicodeCleaner,
} from "../strategies/index.js";

// Registries map a name from config to a new object. Adding a strategy is one new class and one
// line here.

const CLEANERS: ReadonlyMap<string, () => Cleaner> = new Map<string, () => Cleaner>([
  ["unicode", () => new UnicodeCleaner()],
  ["page-numbers", () => new PageNumberCleaner()],
  ["headers-footers", () => new HeaderFooterCleaner()],
  ["dehyphenate", () => new DehyphenateCleaner()],
]);

/** The names accepted in `ingestion.cleaners`. */
export const cleanerNames = (): readonly string[] => [...CLEANERS.keys()];

/**
 * Builds the cleaning chain for the names in `ingestion.cleaners`, in that order. Throws a
 * CONFIG_INVALID error naming the cleaners that exist if one is unknown.
 */
export function buildCleaner(names: readonly string[]): Cleaner {
  const cleaners = names.map((name) => {
    const create = CLEANERS.get(name);
    if (create === undefined) {
      throw new RagError(
        "CONFIG_INVALID",
        `Unknown cleaner "${name}" in ingestion.cleaners. Known cleaners: ${cleanerNames().join(", ")}`,
      );
    }
    return create();
  });
  return new CleaningChain(cleaners);
}
