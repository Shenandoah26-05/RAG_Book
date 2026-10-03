import type { Cleaner, ParsedDocument } from "../../core/index.js";

/**
 * Runs cleaners one after another, each on the result of the one before (chain of responsibility).
 * The chain is itself a Cleaner, so it can be used wherever a single cleaner is expected.
 */
export class CleaningChain implements Cleaner {
  readonly name = "chain";
  readonly #cleaners: readonly Cleaner[];

  constructor(cleaners: readonly Cleaner[]) {
    this.#cleaners = cleaners;
  }

  clean(doc: ParsedDocument): ParsedDocument {
    return this.#cleaners.reduce((current, cleaner) => cleaner.clean(current), doc);
  }
}
