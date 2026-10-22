# RAG-101 design: HTTP API

**Ticket:** M10, feature, 3 points. Depends on RAG-100 (the stack decision, [ADR-0006](../adr/0006-web-stack-and-workspace.md))
and RAG-072 (the pipeline).
**Status:** **built** (2026-10-22).

## 1. What this ticket delivers

The pipeline, served to the web app: `pnpm api` starts it on `127.0.0.1:8787`.

| Piece                                                                  | Where                          |
| ---------------------------------------------------------------------- | ------------------------------ |
| The wire format: request schemas, response and event types, SSE reader | `packages/api-contract/`       |
| The Hono app: three routes, validation, CORS, error mapping            | `src/api/app.ts`, `errors.ts`  |
| Library types to wire types, and back                                  | `src/api/mappers.ts`           |
| The entry point and its flags                                          | `src/api/serve.ts`, `args.ts`  |
| What the API reads: pipeline, document and chunk stores, prices        | `src/composition/build-api.ts` |

| Acceptance criterion                                                        | Met by                                                                      |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `POST /ask` streams tokens, then citations and trace, as server-sent events | `token`\*, `citations`, `trace`, `done` (and `error`)                       |
| `GET /pages/:n` and `GET /chunks/:id`                                       | the two routes; a page says where it sits in the document's text            |
| Request validation with zod; CORS for local development                     | the contract's schemas, checked in each route; `cors()` for the Vite server |

## 2. The routes

```
POST /ask         { question, k?, history?, filter? }   -> text/event-stream
GET  /pages/:n    ?doc=<id> when the index holds several -> { docId, title, number, pageCount, text, span }
GET  /chunks/:id                                          -> { id, docId, text, parentId?, pages, sectionPath, span, strategy }
```

The stream of `POST /ask`, in this order:

```
event: token       data: {"text":"Embeddings "}        any number of these
event: citations   data: {"citations":[{...}]}         the sources, [n] is citations[n-1]
event: trace       data: {"trace":{"totalMs":..,"stages":[..],"usage":{..}}}
event: done        data: {"answered":true,"cited":[1],"unknownCitations":[],"complete":true}
```

A failure **after** the stream began is an `error` event and nothing follows. A failure **before** it
began (a bad request, the model unreachable while the sources are looked up) is an ordinary JSON error
with a status code, because a client can still be told properly.

## 3. Decisions

| #   | Decision                                                          | Why                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | The API is an entry point over `buildPipelineWithConfig`          | It builds the same pipeline from the same config as `pnpm chat`. Routes hold no retrieval, ranking or prompting; `ApiServices` is everything they read.                                                                  |
| D2  | The server keeps no conversation; the client sends `history`      | A stateless server needs no sessions, expiry or storage, and two tabs cannot mix their talks. The cost is that the client sends the turns each time, capped at 10.                                                       |
| D3  | The wire filter is its own shape, translated at the edge          | `documents`, `strategies`, `section`, `pages` are what a UI has; the library's `FilterClause` can change without the browser noticing. One place maps them (`toMetadataFilter`).                                         |
| D4  | Every response is mapped by field name (`mappers.ts`)             | A library type that gains a field does not reach the browser until someone adds it to the contract. Tests check that no stray field leaks.                                                                               |
| D5  | Validation is the contract's zod schema, called in the route      | The same schema is what a client can use to build a request. Errors list the path and the message of each problem (`issues`), so a form can show them.                                                                   |
| D6  | `POST /ask` insists on `application/json`                         | A page on another site can send `text/plain` to a local server without being asked for permission (no preflight). Requiring JSON makes the browser ask, and CORS then refuses it. The API has no login, so this matters. |
| D7  | CORS allows the Vite dev server by default, and nothing else      | The API is on the same machine as every page, but only the web app should be able to **read** an answer. `--origin` adds more.                                                                                           |
| D8  | The error text of the library is passed on; anything else is not  | A `RagError` is written for a person and has any key removed. Any other error may name a path or hold a stack, so the client gets a plain sentence and the real error is logged.                                         |
| D9  | The work stops when the reader goes away                          | The request's signal is passed to the pipeline, so a closed tab stops the retrieval and the model call. A reader already gone before the handler runs is caught too.                                                     |
| D10 | Pages are read once and kept; a failed read is not kept           | A reader turns pages quickly and the processed book is one JSON file. Caching the promise means two requests at once share one read; dropping it on failure means the next request tries again.                          |
| D11 | The path parameter of `/pages/:n` is digits only                  | `Number("1e2")` and `Number("0x10")` are numbers. A test found that `1e2` was read as page 100, so the schema is a regex, not a coercion.                                                                                |
| D12 | The body is limited to 256 KB                                     | A question and ten turns fit in far less; a larger body is not a question.                                                                                                                                               |
| D13 | The contract is TypeScript source, imported by its workspace name | `exports` points at `src/index.ts`, so there is no build step between editing the contract and using it. `tsx`, Vitest and `tsc` all read it. (`pnpm build` compiles `src/` only; nothing runs from `dist/`.)            |

## 4. The boundary rules, checked

ADR-0006 asked to verify that dependency-cruiser sees imports of `@rag-book/api-contract` through the
pnpm link. It does. Two imports were added on purpose to be refused, and both were:

- `src/shared/` importing the contract: `only-the-api-uses-the-contract`.
- the contract importing `node:path`: `web-and-contract-are-browser-code`.

Both were removed again. `pnpm deps:check` stays clean.

## 5. Known limits

- **No login.** The API binds to `127.0.0.1` and has none, as ADR-0006 decided. `--host` can bind
  elsewhere and the usage text says not to. It also does not check the `Host` header, so a page that
  tricks the browser's DNS into pointing a name at `127.0.0.1` could reach it; the JSON-only rule and
  CORS stop it reading answers, not asking.
- **The PDF itself is not served.** Pages come as text. How the reader gets the file for pdf.js is
  RAG-102's decision (ADR-0006).
- **One answer at a time per question, not per server.** Several readers can ask at once; the model
  host decides whether it serves them in parallel.
- **`done` comes last.** The guardrail report needs the whole text, so a client sees citations and
  the trace before it knows whether the answer cited a source it was not given.

## 6. Testing

- **The contract** (60 tests): every request schema (bounds, unknown fields, ids, page ranges), the
  response shapes, the SSE parser (every cut point of a frame, CR, LF and CRLF including a CRLF split
  between packets, comments, multi-line data), the event decoder, and the stream reader (packets,
  a character cut in two, closing the stream early).
- **The routes** (`app.request`, no socket): the order and content of the events, the filter
  translation, validation with paths, 415 and 413, every kind of failure before and after the stream
  began, no leaking of an internal message, cost on the trace, the pages and chunks routes, caching,
  CORS for the dev server and for other origins, and stopping the model when the reader goes away.
- **Over a socket, with the real pipeline and an index on disk:** a real HTTP server, a real
  `fetch`, the answer read with the contract's reader, a citation followed to its page and chunk, a
  page filter, cost on the trace, the preflight, and a reader closing the connection.
- Writing the tests found two real faults, both fixed: a page number of `1e2` (and `0x10`) was accepted
  as a page, and a client that had gone before the handler ran did not stop the work.
