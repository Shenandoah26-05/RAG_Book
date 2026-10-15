/** The text fields of `ChunkMetadata` that a filter can test for equality. */
export type FilterableField = "docId" | "strategy";

/** One condition on a chunk's metadata. */
export type FilterClause =
  /** The field is exactly `value`. */
  | { readonly kind: "equals"; readonly field: FilterableField; readonly value: string }
  /** The field is one of `values` (an empty list matches nothing). */
  | { readonly kind: "in"; readonly field: FilterableField; readonly values: readonly string[] }
  /**
   * The chunk touches at least one page from `from` to `to`, both inclusive and both optional (a
   * missing end is open). A chunk on pages 4 to 6 matches `{ from: 6 }` and `{ to: 4 }`, but not
   * `{ from: 7 }`. Pages are whole numbers of 1 or more and `from` must not exceed `to`.
   */
  | { readonly kind: "pageRange"; readonly from?: number; readonly to?: number };

/**
 * Which chunks a search may return: the chunks that satisfy **every** clause. An empty list allows
 * all chunks. There is no "or" and no "not" (use `in` to allow several values of one field).
 */
export type MetadataFilter = readonly FilterClause[];
