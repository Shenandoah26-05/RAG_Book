# ADR-0002: PDF extractor

- **Status**: Proposed (decision rests on five test PDFs; confirm on the book itself, see "Follow-up")
- **Date**: 2026-10-03

## Context

Everything downstream (cleaning, heading detection, chunking, citations) starts from the text the
PDF loader produces, so a weak extractor limits the whole project. RAG-011 built the
`DocumentLoader` port and `PdfJsLoader` (pdf.js through `pdfjs-dist`). RAG-012 asked for a second
implementation behind the same port and a choice made from evidence.

Heading detection (RAG-014) is the main consumer of loader detail. It needs, for each fragment of
text, the font size and whether the font is bold, so that it can tell a chapter title from body
text.

## Options

### Option A: `pdfjs-dist` (PdfJsLoader)

- Pros: exposes the real font name (`Helvetica-Bold`, `Calibri-BoldItalic`) and a bold flag, once the
  page's drawing commands have been read. Full control over pdf.js options.
- Cons: more setup (font data path, quiet logging). About 3 to 4 times slower, because resolving
  fonts means reading every page's operator list.

### Option B: `unpdf` (UnpdfLoader)

- Pros: nearly no setup; one function returns positioned text items. Faster.
- Cons: items carry font size but only a generic family (`serif`, `sans-serif`, `monospace`), no real
  name and no bold flag. Prints font warnings by default (silenced by passing `verbosity: 0`).

`pdf-parse` was not tried. It is also built on pdf.js and returns plain text without positions or
fonts, so it could not meet the font requirement above.

Both options run the same pdf.js engine underneath (unpdf bundles its own copy). They therefore
cannot differ in how glyphs are decoded, only in what data they expose and how much setup they need.

## Evidence

`pnpm compare:extractors <file.pdf>` runs both loaders and diffs them page by page. It was run on
five PDFs: the 4-page generated fixture, lecture slides (25 pages), course notes (20 pages), a slide
deck (44 pages) and a scanned, handwritten-notes file (12 pages). Figures are from a single run on
the author's machine, so read the timings as an order of magnitude.

| PDF            | Pages | Text identical   | Bold items (pdfjs / unpdf) | Font names (pdfjs / unpdf) | Time per page (pdfjs / unpdf) |
| -------------- | ----: | ---------------- | -------------------------: | -------------------------: | ----------------------------: |
| Fixture        |     4 | 4 of 4 pages     |                      3 / 0 |                      2 / 1 |               (startup-bound) |
| Lecture slides |    25 | 25 of 25         |                    431 / 0 |                      7 / 3 |                 35 ms / 13 ms |
| Course notes   |    20 | 20 of 20         |                    200 / 0 |                      7 / 2 |                 35 ms / 13 ms |
| Slide deck     |    44 | 44 of 44         |                    539 / 0 |                     13 / 2 |                21 ms / 5.5 ms |
| Scanned notes  |    12 | 12 of 12 (empty) |                      0 / 0 |                      0 / 0 |                 35 ms / 10 ms |

Findings:

1. **The text is identical.** All pages matched exactly, characters and whitespace included, on every
   PDF. Font sizes matched too. Choosing between the two does not change what text the pipeline sees.
2. **Only pdf.js reports bold.** unpdf reported zero bold items on documents where pdf.js found
   hundreds, and collapsed 7 to 13 real font names into 2 or 3 generic families.
3. **pdf.js is slower but still cheap.** About 20 to 35 ms per page, so roughly 10 to 15 seconds for a
   400-page book, paid once because ingestion results are cached (RAG-015).
4. **A scanned PDF has no text for either loader** (22 characters in 12 pages). That is not a loader
   problem. It needs OCR, which is a separate ticket.

## Decision

Keep **`pdfjs-dist` as the default loader** (`ingestion.loader: "pdfjs"`, already the default in
`rag.config.json`). Keep **`UnpdfLoader` in the codebase as the second implementation** of
`DocumentLoader`.

The text is identical, so the decision rests on the extra data. Bold and the real font name make
heading detection more reliable, and the speed cost is small and paid once. Keeping unpdf costs
little (about 40 lines on top of shared code), and it demonstrates that the port works: adding it
required no change outside `adapters/loaders`, and one contract test runs against both loaders.

## Consequences

- **Easier**: heading detection (RAG-014) can use bold and real font names. A different loader can
  be selected by config (`ingestion.loader`) once the registry exists.
- **Harder**: PDF extraction is slower than it could be. If a future book has thousands of pages this
  may matter; the document cache limits the damage.
- **Obligations**: both loaders must keep passing the shared contract test in
  `tests/integration/pdf-loaders.test.ts`. `UnpdfLoader` always reports `isBold: false`; code must not
  assume that value means "regular weight" when the loader is unpdf.
- **Reversing**: cheap. The default is one config value, and nothing outside `adapters/loaders`
  depends on which loader produced a document.

## Follow-up

- **Run the comparison on the actual book** (`pnpm compare:extractors data/raw/book.pdf --out
data/processed/compare`) and compare the two text files in a diff viewer. The test PDFs are
  slides and notes, which are simpler than a typeset book (columns, footnotes, running headers,
  ligatures). If the book shows text differences, update this ADR before relying on the decision.
- When that run is done, change the status above to Accepted.
