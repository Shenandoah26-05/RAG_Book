# apps/web

The browser app of the live book: a Vite + React + TypeScript single-page app. It is the book reader
(RAG-102: the PDF drawn with pdf.js, the table of contents, page controls, a remembered reading
position) with a chat panel beside it (RAG-103: answers stream in, each `[n]` is a button that goes to
the cited page and marks the passage). Chosen in
[ADR-0006](../../docs/adr/0006-web-stack-and-workspace.md); the designs are in
[docs/design/rag-102-book-reader.md](../../docs/design/rag-102-book-reader.md) and
[docs/design/rag-103-chat-citations.md](../../docs/design/rag-103-chat-citations.md).

## Run it

```sh
pnpm api    # terminal 1: the HTTP API on http://127.0.0.1:8787 (needs `pnpm ingest` and `pnpm index` first)
pnpm web    # terminal 2: this app on http://localhost:5173
```

In development Vite forwards `/api/...` to the API, so the browser sees one origin. The source PDF is
looked for in `data/raw` by its content hash (`pnpm api --raw-dir <folder>` to change that); without
it the reader shows the extracted text. `?doc=<id>` in the address picks the book when the index holds
several. `#page=12` opens at page 12.

The chat needs the model (`pnpm api` builds the same pipeline as `pnpm chat`, so Ollama must be running).
Enter sends a question, Shift+Enter starts a new line, Stop ends an answer, and Esc clears the passage
marked on the page.

**Ask about a passage** (RAG-104): select text on the page and press "Ask about this". The passage appears
above the box (with "Explain" and "Summarize"), is sent with your next question as extra context, and the
search is limited to the chapter you are in. "Whole book" widens it, and a question that found nothing in
a chapter offers to ask the whole book instead.

| Command          | Does                                                 |
| ---------------- | ---------------------------------------------------- |
| `pnpm web`       | Dev server with hot reload                           |
| `pnpm web:build` | Type-check and build to `apps/web/dist`              |
| `pnpm typecheck` | The library, then this app (`tsc` with the DOM libs) |
| `pnpm test`      | Includes this app's tests (jsdom, no browser needed) |

To serve a build from somewhere else, set `VITE_API_URL` (for example `http://127.0.0.1:8787`) when
building, and start the API with `--origin <the page's address>` so the browser may call it.

## Layout

```
src/
  main.tsx            entry: builds the API client and renders <App/>
  App.tsx             loads the book; shows the reader, or what went wrong with "Try again"
  api/client.ts       fetch + the contract's schemas; errors a reader can act on
  reader/             pure logic and hooks: outline, #page=N, saved position, usePage, usePdf
  pdf/                the PdfBook interface (what components know) and the pdf.js implementation
  chat/               the conversation: reducer, history, streaming hook, `[n]` parsing
  highlight/          where a cited passage is on the page: geometry, fetching, marking text
  selection/          reading what the reader selected on the page, and cleaning it into a passage
  components/         Reader, Toc, PageNav, PdfPage (canvas + marks), TextPage (fallback),
                      ChatPanel, AnswerText, SourceBar, SelectionPopover
```

Components know a `PdfBook` interface, not pdf.js, so pdf.js (a large library) loads only when a book is
opened and tests use a fake.

## Rules (enforced by `pnpm deps:check`)

- It may **not** import anything from `src/`. The library reads files and loads native modules; a
  browser bundle must never reach it. Types and schemas come from `packages/api-contract`.
- It may not import Node built-ins, except in its build config (`vite.config.ts`) and its tests.
- Nothing in `src/` may import from here.

## Talking to the API

`GET /book` (title, page count, section tree, whether a PDF exists), `GET /book/pdf` (the file, in
byte ranges), `GET /pages/:n` (a page as text, for the fallback), `GET /highlights?from&to` (where a
cited passage is on its pages, as boxes in PDF points). `POST /ask` streams server-sent events, read with
`fetch` (not `EventSource`, which cannot POST); the event shapes and the frame parser are in
`packages/api-contract`.
