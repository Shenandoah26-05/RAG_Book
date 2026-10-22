import type { WireOutlineEntry } from "@rag-book/api-contract";

/** An entry of the table of contents, with where it sits, so a list can key and expand it. */
export interface OutlineNode {
  readonly entry: WireOutlineEntry;
  /** Positions from the top: `"2"` is the third chapter, `"2.0"` its first subsection. */
  readonly key: string;
  readonly children: readonly OutlineNode[];
}

/** The outline with a stable key on every entry. */
export function indexOutline(
  outline: readonly WireOutlineEntry[],
  prefix = "",
): readonly OutlineNode[] {
  return outline.map((entry, i) => {
    const key = prefix === "" ? i.toString() : `${prefix}.${i.toString()}`;
    return { entry, key, children: indexOutline(entry.children, key) };
  });
}

/**
 * The headings that contain `page`, from the chapter down to the deepest section: where the reader
 * is in the book. Two sections can share a page (one ends where the next starts); at each level the
 * later one wins, because it is the one that begins on that page.
 */
export function activeTrail(outline: readonly OutlineNode[], page: number): readonly OutlineNode[] {
  const trail: OutlineNode[] = [];
  let level = outline;
  for (;;) {
    const here = level.findLast((n) => n.entry.pageStart <= page && page <= n.entry.pageEnd);
    if (here === undefined) return trail;
    trail.push(here);
    level = here.children;
  }
}

/** The title of the section the reader is in, or undefined before the first heading. */
export function currentSectionTitle(
  outline: readonly OutlineNode[],
  page: number,
): string | undefined {
  return activeTrail(outline, page).at(-1)?.entry.title;
}
