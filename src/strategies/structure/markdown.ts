import type { ParsedDocument, Section } from "../../core/index.js";

interface Heading {
  readonly start: number;
  readonly end: number;
  readonly level: number;
  readonly title: string;
}

/** All sections of the tree, in document order. */
function flatten(sections: readonly Section[]): Heading[] {
  return sections.flatMap((section) => [
    {
      start: section.titleSpan.start,
      end: section.titleSpan.end,
      level: section.level,
      title: section.title,
    },
    ...flatten(section.children),
  ]);
}

/**
 * The whole document as Markdown, for reading it the way the pipeline sees it: headings become
 * `#` lines by level, and `<!-- page N -->` comments mark where each page starts. It exists to
 * check that cleaning and heading detection did the right thing; it is not used for anything else.
 */
export function documentToMarkdown(doc: ParsedDocument): string {
  type Event =
    | { readonly kind: "page"; readonly at: number; readonly number: number }
    | { readonly kind: "heading"; readonly at: number; readonly heading: Heading };

  const events: Event[] = [
    ...doc.pages.map((page): Event => ({ kind: "page", at: page.span.start, number: page.number })),
    ...flatten(doc.sections).map((heading): Event => ({
      kind: "heading",
      at: heading.start,
      heading,
    })),
  ].sort((a, b) => a.at - b.at || (a.kind === "page" ? -1 : 1) - (b.kind === "page" ? -1 : 1));

  let markdown = "";
  let cursor = 0;
  for (const event of events) {
    if (event.at > cursor) {
      markdown += doc.text.slice(cursor, event.at);
      cursor = event.at;
    }
    if (event.kind === "page") {
      markdown += `\n\n<!-- page ${event.number.toString()} -->\n\n`;
    } else {
      const { level, title, end } = event.heading;
      markdown += `\n\n${"#".repeat(Math.min(level, 6))} ${title}\n\n`;
      cursor = Math.max(cursor, end);
    }
  }
  markdown += doc.text.slice(cursor);

  return `${markdown
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

/** The section tree as an indented outline with page ranges, for a quick look at the structure. */
export function outline(sections: readonly Section[], indent = ""): string {
  return sections
    .map((section) => {
      const pages =
        section.pageStart === section.pageEnd
          ? `p.${section.pageStart.toString()}`
          : `pp.${section.pageStart.toString()}-${section.pageEnd.toString()}`;
      const line = `${indent}${section.title}  (${pages})`;
      return section.children.length === 0
        ? line
        : `${line}\n${outline(section.children, `${indent}  `)}`;
    })
    .join("\n");
}
