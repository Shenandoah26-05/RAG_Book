import type { ChunkMetadata, MetadataFilter } from "../../core/index.js";
import { RagError } from "../../shared/index.js";

const isPage = (n: number | undefined): boolean =>
  n === undefined || (Number.isInteger(n) && n >= 1);

/**
 * Checks that a filter can be evaluated: page numbers are whole numbers of 1 or more and `from` is
 * not above `to`. A filter that breaks this is a mistake in the caller, not "no results".
 * @throws RagError INVALID_ARGUMENT
 */
export function assertValidFilter(filter: MetadataFilter): void {
  for (const clause of filter) {
    if (clause.kind !== "pageRange") continue;
    const { from, to } = clause;
    if (!isPage(from) || !isPage(to) || (from !== undefined && to !== undefined && from > to)) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `Invalid page range { from: ${String(from)}, to: ${String(to)} }: pages are whole numbers of 1 or more and from must not exceed to`,
      );
    }
  }
}

/** Whether a chunk's metadata satisfies **every** clause of the filter. An empty filter allows all. */
export function matchesFilter(metadata: ChunkMetadata, filter: MetadataFilter): boolean {
  return filter.every((clause) => {
    switch (clause.kind) {
      case "equals":
        return metadata[clause.field] === clause.value;
      case "in":
        return clause.values.includes(metadata[clause.field]);
      case "pageRange":
        // the chunk touches the range if it ends on or after `from` and starts on or before `to`
        return (
          (clause.from === undefined || metadata.pageEnd >= clause.from) &&
          (clause.to === undefined || metadata.pageStart <= clause.to)
        );
    }
  });
}
