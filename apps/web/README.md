# apps/web

The browser app of the live book (RAG-102 onwards): a Vite + React + TypeScript single-page app that
reads the PDF, shows the chat and the retrieval inspector, and talks to the API over HTTP.
Chosen in [ADR-0006](../../docs/adr/0006-web-stack-and-workspace.md). **No code yet.**

## Rules (enforced by `pnpm deps:check`)

- It may **not** import anything from `src/`. The library reads files and loads native modules; a
  browser bundle must never reach it. Types and schemas come from `packages/api-contract`.
- It may not import Node built-ins, except in its build config (`vite.config.ts`) and its tests.
- Nothing in `src/` may import from here.

## Talking to the API

`POST /ask` streams server-sent events, read with `fetch` (not `EventSource`, which cannot POST). The
event shapes and the frame parser live in `packages/api-contract`. In development Vite proxies `/api`
to the Hono server (`src/api/`, RAG-101), which binds to `127.0.0.1`.
