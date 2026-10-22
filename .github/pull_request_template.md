## What and why

<!-- One or two sentences. Link the ticket, e.g. RAG-0xx. -->

## Checklist

- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass
- [ ] **Retrieval changes only** (chunking, embedding, indexing, retrieval, reranking, config defaults for these): `pnpm eval:smoke` passes, or the baseline was re-recorded on purpose
  - Needs Ollama running and the book ingested (`pnpm run doctor`)
  - If `evals/baselines/smoke.json` changed, say here why the new number is right

## Smoke result

<!-- Paste the last lines of `pnpm eval:smoke`, or write "not a retrieval change". -->
