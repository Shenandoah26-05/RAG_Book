import type { ChunkMetadata, MetadataFilter } from "../../core/index.js";
import { RagError } from "../../shared/index.js";

const isPage = (n: number | undefined): boolean =>
  n === undefined || (Number.isInteger(n) && n >= 1);

/** A title as compared by a `section` clause: no surrounding spaces, no case. */
const fold = (title: string): string => title.trim().toLowerCase();

/**
 * Checks that a filter can be evaluated: page numbers are whole numbers of 1 or more, `from` is not
 * above `to`, and a section path holds at least one title and no blank one. A filter that breaks
 * this is a mistake in the caller, not "no results".
 * @throws RagError INVALID_ARGUMENT
 */
export function assertValidFilter(filter: MetadataFilter): void {
  for (const clause of filter) {
    if (clause.kind === "section") {
      if (clause.path.length === 0 || clause.path.some((title) => fold(title) === "")) {
        throw new RagError(
          "INVALID_ARGUMENT",
          `Invalid section path ${JSON.stringify(clause.path)}: give at least one title, none blank`,
        );
      }
      continue;
    }
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
      case "section":
        // the chunk's section path starts with the clause's path, title by title
        return clause.path.every((title, i) => {
          const have = metadata.sectionPath[i];
          return have !== undefined && fold(have) === fold(title);
        });
      case "pageRange":
        // the chunk touches the range if it ends on or after `from` and starts on or before `to`
        return (
          (clause.from === undefined || metadata.pageEnd >= clause.from) &&
          (clause.to === undefined || metadata.pageStart <= clause.to)
        );
    }
  });
}
