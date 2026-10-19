import type {
  AssembledPrompt,
  ContextAssembler,
  DroppedChunk,
  PromptTemplate,
  Query,
  RetrievedChunk,
  Tokenizer,
} from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { formatSource, makeCitation } from "./format-source.js";
import { removeNearDuplicates } from "./near-duplicates.js";
import { orderForPrompt } from "./ordering.js";
import type { OrderingName } from "./ordering.js";
import { SOURCES_PLACEHOLDER } from "./prompt-template.js";

/** Shown in place of the sources when retrieval found nothing (or nothing fits the budget). */
export const NO_SOURCES = "(no sources were found)";

const SOURCE_SEPARATOR = "\n\n";
/** Two chunks sharing at least this much of their text count as the same passage. */
export const DEFAULT_DUPLICATE_THRESHOLD = 0.8;

export interface TemplateContextAssemblerOptions {
  /** Counts tokens for the budget. Use the tokenizer that matches the generation model. */
  readonly tokenizer: Tokenizer;
  readonly template: PromptTemplate;
  /** `generation.contextBudgetTokens`: the most tokens the numbered sources may use. */
  readonly budgetTokens: number;
  /** `generation.ordering`. */
  readonly ordering: OrderingName;
  /** Similarity from 0 to 1 at which a chunk is dropped as a copy of a better one. */
  readonly duplicateThreshold?: number;
}

/**
 * Builds the prompt from retrieved chunks, in four steps:
 *
 *   1. remove near-duplicates      (the better-ranked copy stays)
 *   2. fit the token budget        (best first; a chunk that does not fit is skipped)
 *   3. order for the prompt        (relevance-first or sandwich)
 *   4. number, cite and render     ([1], [2], ... then into the template)
 *
 * Fitting happens before ordering because the budget decides *which* chunks are in, while the
 * ordering only decides *where* they sit. A chunk larger than the whole budget is dropped, not cut:
 * a half passage with a page citation would claim more than the book says there.
 */
export class TemplateContextAssembler implements ContextAssembler {
  readonly #tokenizer: Tokenizer;
  readonly #template: PromptTemplate;
  readonly #budget: number;
  readonly #ordering: OrderingName;
  readonly #threshold: number;

  /**
   * @throws RagError INVALID_ARGUMENT for a budget that is not a whole number of 1 or more, or a
   * duplicate threshold outside (0, 1]
   */
  constructor(options: TemplateContextAssemblerOptions) {
    const { budgetTokens, duplicateThreshold = DEFAULT_DUPLICATE_THRESHOLD } = options;
    if (!Number.isInteger(budgetTokens) || budgetTokens < 1) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `The context budget must be a whole number of tokens, 1 or more, got ${String(budgetTokens)}`,
      );
    }
    if (!(duplicateThreshold > 0 && duplicateThreshold <= 1)) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `The duplicate threshold must be above 0 and at most 1, got ${String(duplicateThreshold)}`,
      );
    }
    this.#tokenizer = options.tokenizer;
    this.#template = options.template;
    this.#budget = budgetTokens;
    this.#ordering = options.ordering;
    this.#threshold = duplicateThreshold;
  }

  assemble(query: Query, chunks: readonly RetrievedChunk[]): AssembledPrompt {
    if (query.text.trim() === "") {
      throw new RagError("INVALID_ARGUMENT", "Cannot assemble a prompt for a blank question");
    }

    const dropped: DroppedChunk[] = [];
    const bestFirst = [...chunks].sort((a, b) => a.rank - b.rank);

    const { kept, duplicates } = removeNearDuplicates(
      bestFirst,
      (item) => item.chunk.text,
      this.#threshold,
    );
    for (const item of duplicates) dropped.push({ chunk: item, reason: "duplicate" });

    const selected = this.#fitBudget(kept, dropped);
    let ordered = orderForPrompt(selected, this.#ordering);
    let block = this.#renderSources(ordered);
    let tokens = ordered.length === 0 ? 0 : this.#tokenizer.count(block);

    // The estimate above numbers chunks by relevance. Ordering renumbers them (and "[9]" becomes
    // "[10]" at the end of a sandwich), so the real cost is checked on the finished block, and the
    // weakest chunk is dropped until it fits.
    while (tokens > this.#budget && selected.length > 0) {
      dropped.push({ chunk: selected.pop() as RetrievedChunk, reason: "over-budget" });
      ordered = orderForPrompt(selected, this.#ordering);
      block = this.#renderSources(ordered);
      tokens = ordered.length === 0 ? 0 : this.#tokenizer.count(block);
    }

    return {
      system: this.#template.text.replace(SOURCES_PLACEHOLDER, () =>
        ordered.length === 0 ? NO_SOURCES : block,
      ),
      user: query.text,
      promptVersion: `${this.#template.id}@${this.#template.version}`,
      included: ordered,
      citations: ordered.map((item, position) => makeCitation(position + 1, item.chunk)),
      dropped,
      sourceTokens: tokens,
      budget: this.#budget,
    };
  }

  /** Takes chunks best first while they fit; one that does not fit is dropped and the rest tried. */
  #fitBudget(bestFirst: readonly RetrievedChunk[], dropped: DroppedChunk[]): RetrievedChunk[] {
    const selected: RetrievedChunk[] = [];
    let used = 0;
    for (const item of bestFirst) {
      const cost =
        this.#tokenizer.count(formatSource(selected.length + 1, item.chunk)) +
        (selected.length === 0 ? 0 : this.#tokenizer.count(SOURCE_SEPARATOR));
      if (used + cost <= this.#budget) {
        selected.push(item);
        used += cost;
      } else {
        dropped.push({ chunk: item, reason: "over-budget" });
      }
    }
    return selected;
  }

  #renderSources(ordered: readonly RetrievedChunk[]): string {
    return ordered
      .map((item, position) => formatSource(position + 1, item.chunk))
      .join(SOURCE_SEPARATOR);
  }
}
