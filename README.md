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

| Script            | What it does                                    |
| ----------------- | ----------------------------------------------- |
| `pnpm dev`        | Run `src/index.ts` with tsx in watch mode       |
| `pnpm build`      | Compile to `dist/` with tsc                     |
| `pnpm typecheck`  | Type-check without emitting (strict mode)       |
| `pnpm lint`       | ESLint                                          |
| `pnpm test`       | Run vitest once                                 |
| `pnpm format`     | Format everything with Prettier                 |
| `pnpm run doctor` | Check that Ollama is running and has the models |
| `pnpm deps:check` | Check the layer rules in `docs/architecture.md` |

## Documentation

- [docs/setup.md](docs/setup.md): install Ollama, pull the models, run `pnpm run doctor`.
- [docs/architecture.md](docs/architecture.md): layers and import rules.
- [docs/adr/](docs/adr/): architecture decision records. Start with
  [ADR-0001: ports and adapters](docs/adr/0001-ports-and-adapters.md). Copy
  [0000-template.md](docs/adr/0000-template.md) for new ones.

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
