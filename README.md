# RAG Book

A RAG (retrieval-augmented generation) pipeline over a book PDF, built milestone by milestone
(see the Build Board).

## Prerequisites

- **Node 22 LTS** (pinned in `.nvmrc` and the `engines` field of `package.json`). Use a version
  manager that reads `.nvmrc`, e.g. [fnm](https://github.com/Schniz/fnm) or nvm.
- **pnpm** (`npm install -g pnpm`)

## Setup

```sh
fnm use          # or: nvm use (reads .nvmrc)
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

## Scripts

| Script                          | What it does                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                      | Run `src/index.ts` with tsx in watch mode                                                                                             |
| `pnpm build`                    | Compile to `dist/` with tsc                                                                                                           |
| `pnpm typecheck`                | Type-check without emitting (strict mode)                                                                                             |
| `pnpm lint`                     | ESLint                                                                                                                                |
| `pnpm test`                     | Run vitest once                                                                                                                       |
| `pnpm format`                   | Format everything with Prettier                                                                                                       |
| `pnpm compare:extractors <pdf>` | Compare the two PDF loaders on a file (ADR-0002)                                                                                      |
| `pnpm ingest <pdf> [--force]`   | Turn a PDF into a processed document in `data/processed/`                                                                             |
| `pnpm chunks <pdf or docId>`    | Chunk a processed document; print stats, write the chunks file                                                                        |
| `pnpm export:markdown <pdf>`    | Load, clean and find sections; print an outline, write Markdown                                                                       |
| `pnpm run doctor`               | Check that Ollama is running and has the models                                                                                       |
| `pnpm deps:check`               | Check the layer rules in `docs/architecture.md`                                                                                       |
| `pnpm eval:validate <pdf>`      | Check the evaluation dataset against the ingested book                                                                                |
| `pnpm experiment <file>`        | Run the variants of an experiment over the evaluation dataset                                                                         |
| `pnpm api`                      | Serve the pipeline and the book over HTTP on 127.0.0.1:8787 (`/ask`, `/book`, `/book/pdf`, `/pages/:n`, `/highlights`, `/chunks/:id`) |
| `pnpm web`                      | The browser app (book reader) on http://localhost:5173; needs `pnpm api` running                                                      |
| `pnpm web:build`                | Type-check and build the browser app to `apps/web/dist`                                                                               |
| `pnpm eval:smoke`               | Retrieval regression check: 10 questions, fails if recall drops                                                                       |
| `pnpm report <run>`             | Turn an experiment run into a Markdown A/B report                                                                                     |

## Ingesting a book

```sh
pnpm ingest data/raw/book.pdf
```

This loads the PDF, cleans it, finds its sections, and stores the result as
`data/processed/<docId>.json`. The `docId` is a UUID computed from the hash of the file, so the
same file always gets the same id. Running it again on
the same file does nothing; add `--force` to process it again. The cache looks only at the file's
hash, so after changing `ingestion.cleaners` or the section detector, run with `--force`.
The `data/` folder is git-ignored.

## Documentation

- [docs/setup.md](docs/setup.md): install Ollama, pull the models, run `pnpm run doctor`.
- [docs/architecture.md](docs/architecture.md): layers, import rules, and how to add a chunking strategy.
- [docs/sequence/](docs/sequence/README.md): sequence diagrams, one for the M0 to M3 pipeline and one per module down to function level.
- [docs/design/](docs/design/rag-020-chunker-port.md): design documents, with diagrams (RAG-020: the chunk contract).
- [docs/adr/](docs/adr/): architecture decision records. Start with
  [ADR-0001: ports and adapters](docs/adr/0001-ports-and-adapters.md). Copy
  [0000-template.md](docs/adr/0000-template.md) for new ones.

## Reading the book in a browser

```sh
pnpm ingest data/raw/book.pdf   # once; keep the PDF in data/raw so the reader can show its pages
pnpm index                      # once
pnpm api                        # terminal 1
pnpm web                        # terminal 2, then open http://localhost:5173
```

Page controls, the table of contents and `#page=12` in the address; the page you were on is
remembered. Ask a question in the chat beside the page: the answer streams in, and each numbered mark
in it takes you to the cited page and highlights the passage. See [apps/web/README.md](apps/web/README.md) and
[docs/design/rag-102-book-reader.md](docs/design/rag-102-book-reader.md) and
[docs/design/rag-103-chat-citations.md](docs/design/rag-103-chat-citations.md).

## Before merging a retrieval change

```sh
pnpm eval:smoke                     # compare recall@5 with evals/baselines/smoke.json
pnpm eval:smoke --update-baseline   # only when the change is meant to move recall
```

Needs Ollama running and the book ingested. Exit code 0 is a pass, 1 a regression, 2 a run that could
not be compared. See [docs/design/rag-085-retrieval-regression.md](docs/design/rag-085-retrieval-regression.md).
The pull request template carries this as a checklist item.

## Commits

`pnpm install` activates Git hooks (husky):

- **pre-commit**: lint-staged runs ESLint and Prettier on staged files.
- **commit-msg**: commitlint requires [Conventional Commits](https://www.conventionalcommits.org),
  e.g. `feat(core): add chunk types`, `fix: handle empty page`, `chore: bump deps`.

`console.log` is banned outside `src/cli`; use the Logger.

## Tooling at a glance

- **tsc** type-checks and compiles (`typecheck`, `build`).
- **tsx** runs TypeScript directly, no build step (`dev`).
- **vitest** runs tests.

TypeScript is ESM (`module: NodeNext`): relative imports need a `.js` extension, e.g.
`import { x } from "./x.js"`.
