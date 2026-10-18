# RAG-043 design: Metadata filtering

**Ticket:** M4, feature, 2 points. Depends on RAG-041 (flat vector store).
**Status:** **built** (2026-10-19).

## 1. What this ticket delivers

Searches restricted to a document, a chunking strategy, a chapter or section, or a page range. RAG-040
and RAG-041 had already built the port, `matchesFilter` and the pre-filtering search for `docId`,
`strategy` and `pageRange`. This ticket adds what was left:

| Piece                                              | Where                                                        |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `section` clause (chapter or section)              | `src/core/types/filter.ts`                                   |
| `section` in `matchesFilter` / `assertValidFilter` | `src/strategies/in-memory-index/metadata-filter.ts`          |
| `section` in the shared store contract             | `src/testing/vector-store-contract.testing.ts`               |
| Filter flags for a command line                    | `src/cli/filter-args.ts` (`parseFilterArgs`, `FILTER_USAGE`) |
| Pre- vs post-filtering demonstrated                | `flat-vector-store-filter.test.ts`                           |

| Acceptance criterion           | Met by                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Filters applied before scoring | `FlatVectorStore.search` skips non-matching entries before computing a score; test shows post-filtering returns nothing |
| Tests for each filter type     | Unit tests per clause kind, the shared contract (16 filter cases), and flat-store end-to-end tests                      |
| Exposed in the search CLI      | `parseFilterArgs` is ready; **`pnpm search` does not exist yet** (RAG-055), which mounts it (see D4)                    |

## 2. The `section` clause

`{ kind: "section", path: ["Chapter 3", "3.2 Embeddings"] }` matches a chunk whose `sectionPath`
**starts with** `path`, title by title.

- One title is a chapter filter; more titles narrow to a section. One rule covers both.
- A chunk deeper than the path still matches (a chapter includes all its sections). A sibling does not.
- A title that is only part of another (`Chapter 3` vs `Chapter 33`) does not match.
- A chunk with no known section never matches.

## 3. Decisions

| #   | Decision                                                             | Why                                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | One `section` clause with a prefix path, not `chapter` and `section` | A chapter is a path of length one. Two kinds would need two rules that must agree. RAG-104 ("ask about this chapter") uses a one-title path.                                                                          |
| D2  | Titles compare ignoring case and surrounding spaces                  | A person types `--chapter "chapter 3"`. Exact matching would make the command line unforgiving; the chapter titles of one book do not differ only by case.                                                            |
| D3  | A blank or empty path is `INVALID_ARGUMENT`, not "no hits"           | Same rule as a bad page range: it is a mistake in the caller, and an empty `path` would otherwise match everything and quietly drop the restriction.                                                                  |
| D4  | The CLI piece is a parser, wired by RAG-055                          | There is no retriever or `pnpm search` yet (RAG-050 to 052 are unbuilt). `parseFilterArgs` is pure, tested, and ignores flags it does not own, so the search command only calls it and passes the result to `search`. |
| D5  | `--chapter` and `--section` cannot be combined                       | A section path already begins with its chapter, so both flags would either repeat or contradict each other. An error is clearer than silently picking one.                                                            |
| D6  | `matchesFilter` stays the single shared function                     | As D5 of RAG-041 said. The contract keeps its own independent matcher on purpose.                                                                                                                                     |

## 4. Pre-filtering vs post-filtering

**Post-filtering** takes the best `k` of the whole index, then drops hits that fail the filter. It can
return fewer than `k`, or nothing: if every one of the top 3 is in chapter 1, asking for chapter 2
leaves an empty list although chapter 2 has relevant chunks. **Pre-filtering** (what the store does)
only scores chunks that pass, so the best `k` of them come back.

The cost is that an exact store checks the filter for every entry, which is cheap next to computing a
cosine. An approximate index (RAG-044) is where pre-filtering gets hard: its graph is built over all
vectors, so a restrictive filter can leave it with too few reachable candidates.

`flat-vector-store-filter.test.ts` builds that situation: ten chunks where all of chapter 1 outranks
chapter 2. Post-filtering the top 3 for chapter 2 gives `[]`; the store gives 3 hits. The shared
contract also has a broken store that filters after taking `k`, and checks it is caught.

## 5. Command-line flags

`parseFilterArgs(argv)` returns `{ filter }` or `{ error }`:

| Flag                                     | Becomes                                     |
| ---------------------------------------- | ------------------------------------------- |
| `--doc <id>` (repeatable)                | `equals` on `docId`, or `in` if repeated    |
| `--strategy <name>` (repeatable)         | `equals` on `strategy`, or `in` if repeated |
| `--chapter "Chapter 3"`                  | `section` with one title                    |
| `--section "Chapter 3 > 3.2 Embeddings"` | `section` with the whole path               |
| `--pages 12` / `10-20` / `10-` / `-20`   | `pageRange`                                 |

Clauses combine with "and". `FILTER_FLAGS` lets a command skip these flags in its own parser, and
`FILTER_USAGE` is the help text to paste into its usage.

## 6. Not in this ticket

The search command itself (RAG-055), retrievers passing a filter through (RAG-050), and filtering by
anything but the four fields above. Adding another clause kind stays additive.
