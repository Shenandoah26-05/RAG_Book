import type { Query, QueryTransformer, TransformOptions } from "../../core/index.js";

/** How much of a selected passage is searched for. An embedding model reads a few hundred tokens at most. */
export const MAX_SELECTION_SEARCH_CHARS = 1000;

/** The selected passage as a search text: its words with the whitespace of the page squeezed out. */
export function selectionSearchText(selection: string): string {
  return selection.replace(/\s+/g, " ").trim().slice(0, MAX_SELECTION_SEARCH_CHARS);
}

/**
 * Makes retrieval look for what the reader selected as well as for what they asked.
 *
 * "Explain this" or "why does that matter?" say nothing a search can use: the meaning is in the
 * passage the reader pointed at. So the passage is added to `query.variants`, and the
 * `MultiQueryRetriever` searches for the question and for the passage and fuses the two rankings. The
 * passage's own chunk is usually among the best hits, so it reaches the model as an ordinary numbered
 * source that can be cited and opened, along with the passages around it in meaning.
 *
 * The question (`text`) is not touched: it is what the answering model is asked, and the selection
 * reaches that model separately, as quoted context in the prompt.
 *
 * A **decorator**: it wraps the transformer the configuration built and reports its name, so an
 * experiment or a trace that has nothing to do with selections reads exactly as it did before. Without
 * a selection it returns what the wrapped transformer returned, and costs nothing.
 */
export class SelectionTransformer implements QueryTransformer {
  readonly name: string;
  readonly #inner: QueryTransformer;

  constructor(inner: QueryTransformer) {
    this.#inner = inner;
    this.name = inner.name;
  }

  async transform(query: Query, options: TransformOptions = {}): Promise<Query> {
    const transformed = await this.#inner.transform(query, options);
    const selection = transformed.selection;
    if (selection === undefined) return transformed;
    const text = selectionSearchText(selection.text);
    if (text === "") return transformed;
    return { ...transformed, variants: [...(transformed.variants ?? []), text] };
  }
}
