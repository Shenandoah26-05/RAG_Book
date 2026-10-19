import type { FilterClause, MetadataFilter } from "../core/index.js";

/** The flags this module reads. A command that parses its own flags too can skip these. */
export const FILTER_FLAGS = ["--doc", "--strategy", "--chapter", "--section", "--pages"] as const;

/** The help lines for the filter flags, to paste into a command's usage text. */
export const FILTER_USAGE =
  "  --doc <id>         only chunks of this document (repeat the flag to allow several)\n" +
  "  --strategy <name>  only chunks made by this chunking strategy (repeat to allow several)\n" +
  '  --chapter <title>  only chunks under this chapter, e.g. --chapter "Chapter 3"\n' +
  '  --section <path>   only chunks under this section, titles joined by ">", e.g.\n    --section "Chapter 3 > 3.2 Embeddings"\n' +
  "  --pages <range>    only chunks touching these pages: 12, 10-20, 10- (from 10) or -20 (up to 20)";

type Flag = (typeof FILTER_FLAGS)[number];

const isFilterFlag = (name: string): name is Flag =>
  (FILTER_FLAGS as readonly string[]).includes(name);

/** `10-20`, `10-`, `-20` or `12` as a page range clause; undefined if it is not one. */
function parsePages(raw: string): FilterClause | undefined {
  const match = /^(\d*)(-?)(\d*)$/.exec(raw.trim());
  if (match === null) return undefined;
  const [, first = "", dash = "", second = ""] = match;
  if (first === "" && second === "") return undefined;
  const from = first === "" ? undefined : Number(first);
  const to = dash === "" ? from : second === "" ? undefined : Number(second);
  if ((from !== undefined && from < 1) || (to !== undefined && to < 1)) return undefined;
  if (from !== undefined && to !== undefined && from > to) return undefined;
  return {
    kind: "pageRange",
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

/** One value as `equals`, several as `in`. */
function oneOrMany(field: "docId" | "strategy", values: readonly string[]): FilterClause {
  return values.length === 1 && values[0] !== undefined
    ? { kind: "equals", field, value: values[0] }
    : { kind: "in", field, values };
}

/**
 * Reads the filter flags of a search-like command into a `MetadataFilter`: `--doc`, `--strategy`,
 * `--chapter`, `--section` and `--pages`. They combine with "and". Arguments that are not filter
 * flags are ignored, so a command can run this next to its own parser.
 *
 * Each flag takes its value as `--flag value` or `--flag=value`. `--doc` and `--strategy` may be
 * repeated. `--chapter`, `--section` and `--pages` may be given once, and `--chapter` cannot be
 * combined with `--section`, since a section path already starts with its chapter.
 */
export function parseFilterArgs(
  argv: readonly string[],
): { readonly filter: MetadataFilter } | { readonly error: string } {
  const docs: string[] = [];
  const strategies: string[] = [];
  let section: { readonly flag: Flag; readonly path: readonly string[] } | undefined;
  let pages: FilterClause | undefined;
  let pagesGiven = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const name = arg.split("=")[0] ?? "";
    if (!isFilterFlag(name)) continue;

    let value: string | undefined;
    if (arg.includes("=")) {
      value = arg.slice(name.length + 1);
    } else {
      value = argv[i + 1];
      i++;
    }
    if (
      value === undefined ||
      value.trim() === "" ||
      (!arg.includes("=") && value.startsWith("--"))
    ) {
      return { error: `${name} needs a value` };
    }

    switch (name) {
      case "--doc":
        docs.push(value.trim());
        break;
      case "--strategy":
        strategies.push(value.trim());
        break;
      case "--chapter":
      case "--section": {
        if (section !== undefined) {
          return {
            error:
              section.flag === name
                ? `${name} was given twice`
                : "Use --chapter or --section, not both: a section path starts with its chapter",
          };
        }
        const path = (name === "--chapter" ? [value] : value.split(">")).map((t) => t.trim());
        if (path.some((title) => title === "")) {
          return { error: `${name} has a blank title: "${value}"` };
        }
        section = { flag: name, path };
        break;
      }
      case "--pages":
        if (pagesGiven) return { error: "--pages was given twice" };
        pagesGiven = true;
        pages = parsePages(value);
        if (pages === undefined) {
          return {
            error: `--pages "${value}" is not a page range: use 12, 10-20, 10- or -20 (pages start at 1)`,
          };
        }
        break;
    }
  }

  return {
    filter: [
      ...(docs.length === 0 ? [] : [oneOrMany("docId", docs)]),
      ...(strategies.length === 0 ? [] : [oneOrMany("strategy", strategies)]),
      ...(section === undefined ? [] : [{ kind: "section", path: section.path } as const]),
      ...(pages === undefined ? [] : [pages]),
    ],
  };
}
