# packages/api-contract

The shapes that cross the HTTP boundary between the API (`src/api/`) and the web app (`apps/web`):
zod schemas for requests, and the types of responses and stream events (RAG-101).
Chosen in [ADR-0006](../../docs/adr/0006-web-stack-and-workspace.md). **No code yet.**

## Why it exists

The web app must not import the library, and the API should not hand the browser its domain types.
This package is the one thing both sides import, so the wire format is a decision made in one place.
`src/api/` maps domain types (`Citation`, `Trace`, ...) to these shapes, which means a refactor of
the library cannot change what the browser receives by accident.

## Rules (enforced by `pnpm deps:check`)

- It imports `zod` and nothing else: not `src/`, not `apps/`, not Node built-ins (the browser loads it).
- In `src/`, only `src/api/` may import it.
- The web app and the API both import it by its workspace name, `@rag-book/api-contract`.
