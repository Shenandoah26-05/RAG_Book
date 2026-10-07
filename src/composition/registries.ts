import { ApproxTokenizer, PdfJsLoader, TiktokenTokenizer, UnpdfLoader } from "../adapters/index.js";
import type { Cleaner, DocumentLoader, Tokenizer } from "../core/index.js";
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

const LOADERS: ReadonlyMap<string, () => DocumentLoader> = new Map<string, () => DocumentLoader>([
  ["pdfjs", () => new PdfJsLoader()],
  ["unpdf", () => new UnpdfLoader()],
]);

/** The names accepted in `ingestion.loader`. */
export const loaderNames = (): readonly string[] => [...LOADERS.keys()];

/** Builds the loader named in `ingestion.loader`. Throws CONFIG_INVALID if there is no such loader. */
export function buildLoader(name: string): DocumentLoader {
  const create = LOADERS.get(name);
  if (create === undefined) {
    throw new RagError(
      "CONFIG_INVALID",
      `Unknown loader "${name}" in ingestion.loader. Known loaders: ${loaderNames().join(", ")}`,
    );
  }
  return create();
}

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

const TOKENIZERS: ReadonlyMap<string, () => Tokenizer> = new Map<string, () => Tokenizer>([
  ["approx", () => new ApproxTokenizer()],
  ["tiktoken", () => new TiktokenTokenizer()],
]);

/** The names accepted in `chunking.tokenizer`. */
export const tokenizerNames = (): readonly string[] => [...TOKENIZERS.keys()];

/** Builds the tokenizer named in `chunking.tokenizer`. Throws CONFIG_INVALID if there is no such tokenizer. */
export function buildTokenizer(name: string): Tokenizer {
  const create = TOKENIZERS.get(name);
  if (create === undefined) {
    throw new RagError(
      "CONFIG_INVALID",
      `Unknown tokenizer "${name}" in chunking.tokenizer. Known tokenizers: ${tokenizerNames().join(", ")}`,
    );
  }
  return create();
}
