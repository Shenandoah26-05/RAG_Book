# packages/api-contract

The shapes that cross the HTTP boundary between the API (`src/api/`) and the web app (`apps/web`):
zod schemas for requests, and the types of responses and stream events (RAG-101), the book and its
outline (RAG-102), the boxes that place a passage on a page (RAG-103) and the `inspection` event that
explains an answer (RAG-105; sent only when the request sets `inspect`).
outline (RAG-102) the boxes that place a passage on a page (RAG-103) and the passage a reader selected to ask about
(RAG-104).
Chosen in [ADR-0006](../../docs/adr/0006-web-stack-and-workspace.md). Built in RAG-101.

## What is in it

| File             | Holds                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `src/schemas.ts` | Request schemas (`askRequestSchema`, ...), response and error shapes, and the events of `POST /ask` |
| `src/sse.ts`     | `readAskEvents(body)`: reads the answer stream with `fetch`, for the browser (and for the tests)    |

Every type is `z.infer` of a schema, so the schema is the one definition. The API validates requests
with it, and a client can validate responses with it.

## Why it exists

The web app must not import the library, and the API should not hand the browser its domain types.
This package is the one thing both sides import, so the wire format is a decision made in one place.
`src/api/` maps domain types (`Citation`, `Trace`, ...) to these shapes, which means a refactor of
the library cannot change what the browser receives by accident.

## Rules (enforced by `pnpm deps:check`)

- It imports `zod` and nothing else: not `src/`, not `apps/`, not Node built-ins (the browser loads it).
- In `src/`, only `src/api/` may import it.
- The web app and the API both import it by its workspace name, `@rag-book/api-contract`.
