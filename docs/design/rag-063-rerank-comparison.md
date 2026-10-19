# RAG-063 design: Rerank on/off comparison test

**Ticket:** M6, test, 1 point. Depends on RAG-061 (LLM reranker) and RAG-055 (search CLI).

## 1. What this ticket delivers

A test that proves the `rerank.enabled` flag does what it says. It is a test of the **wiring**, not of
the reranker: the reranker has its own tests (RAG-060, 061, 062). What can go wrong here is that the
configuration says one thing and the composition root does another: the flag is read but the wrong
reranker is built, the candidates are not fetched, the model is not the one in `generation`, or a
failing judge breaks the search.

| Piece                                 | Where                                                           |
| ------------------------------------- | --------------------------------------------------------------- |
| The comparison test and its snapshots | `tests/integration/rerank-comparison.test.ts`, `__snapshots__/` |
| `SearchReport.candidates`             | `src/composition/build-searcher.ts`                             |
| "Before reranking" in the text report | `src/composition/search-summary.ts`                             |
| The `rerank-llm` variant              | `configs/variants/rerank-llm.json`                              |

| Acceptance criterion                                | Met by                                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Same query run with `rerank.enabled` false and true | `search()` in the test, off by the real `rag.config.json`, on by the `rerank-llm` variant or a flag |
| Trace shows the original and reranked orders        | `SearchReport.candidates` (the retriever's order) and `results` (the reranker's), both printed      |
| Snapshot test of the trace                          | the text report with reranking off and on, and the trace stages, in `__snapshots__/`                |

## 2. What was missing, and the one production change

The search report (RAG-055) listed what each retriever found and the final result, but not what the
reranker was **given**. For a hybrid retriever that list (the fused ranking) was not shown anywhere, so
"original order" could not be read from the trace. `buildSearcher` now watches the retriever beneath the
reranker and records the list in `candidates`:

```
question --> dense, bm25 (watched) --> fusion --> [candidates]  --> reranker --> results
                                                    watched here                  k chunks
```

With reranking off, `candidates` equals `results` (the no-op reranker changes nothing), so a report
always has both. With it on, `candidates` is `rerank.candidates` long and `results` is the reranker's
`k`. The text form prints "Candidates (...), before reranking" followed by "Reranked (..., llm)".

## 3. How the test works

The fixture index (five chunks about cats and other things) is searched for "cats" with `k = 2`. A fake
Ollama server answers two kinds of request: `/api/embed` for the question, and `/api/chat` as the
**judge**, which reads the passage in the prompt and replies `{"score": n}`. The judge's opinion is
deliberately not the retriever's:

| Chunk                    | Retriever's rank (fused) | Judge's score |
| ------------------------ | ------------------------ | ------------- |
| kittens are young cats   | 1                        | 3             |
| cats purr                | 2                        | 8             |
| furry animals such as... | **3**                    | **10**        |
| dogs bark and fetch      | 4                        | 2             |
| cars have four wheels    | 5                        | 0             |

Off, the answer is `[young, purr]`. On, it is `[furry, purr]`: the judge's favourite was third, outside
`k`, so reranking can only get it in because `rerank.candidates` chunks were fetched.

| Test                                            | What it proves                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| off keeps the order and calls no judge          | the default config (read from the real `rag.config.json`) builds the no-op reranker; `candidates` equals `results` |
| on reorders and reaches past `k`                | candidates in the retriever's order, results in the judge's order with its scores, ranks 1..k, `retriever` kept    |
| on asks the generation model once per candidate | five requests, model `llama3.2` from `generation`, the question and each passage in the prompt                     |
| on by a variant, and by flags                   | `--variant rerank-llm` and `--rerank.enabled=true` build the same thing                                            |
| `rerank.candidates` limits what is fetched      | three candidates fetched, three judged, the other two never seen                                                   |
| both runs retrieve the same                     | dense and bm25 lists identical (ids and scores); what reranking was given starts with what the off run returned    |
| the judge cannot be reached                     | results are the retriever's first `k` (never worse than not reranking), and the log says "llm rerank failed"       |
| three snapshots                                 | the text trace off and on (both orders on the page), and the trace stages of both runs                             |

## 4. Decisions

| #   | Decision                                                     | Why                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Test through `buildSearcher`, not `RerankingRetriever`       | The ticket is about the composition root's wiring. `buildSearcher` goes through the real config loading, variant resolution, `buildRetriever`, `buildRerankingRetriever` and `OllamaProvider`; only the network is fake.                 |
| D2  | A fake `fetch`, not a fake `LlmProvider`                     | It exercises the real `OllamaProvider`, so the model name and the prompt that reach the server are checked too. The same `fetch` option already exists for the embedder.                                                                 |
| D3  | `candidates` in the report, not a second trace               | The reranker's input is data the report should carry (it appears in `--json` too), and it needs no new concept. It reuses `ObservedRetriever`; the trace it writes to is discarded.                                                      |
| D4  | Snapshot the text report and the stages, with timings zeroed | Durations change every run. The report is normalised (timings zero, retrievers and stages sorted by name, because a hybrid runs them side by side and the finishing order is not fixed). Snapshots are pinned to LF in `.gitattributes`. |
| D5  | The judge's scores are not the retriever's                   | A reranker that agrees with the retriever would pass a test even if it did nothing. The favourite is placed outside `k` so the test fails if candidates are not fetched or the order is not applied.                                     |

## 5. Fixed in passing

- `vitest.config.ts` sets a test timeout of 30 seconds (the default is 5). The HNSW tests and the ones
  that run a command as a process take a few seconds alone and more under the parallel suite, and
  failed at random. `eslint.config.js` no longer lists `*.config.ts` under `allowDefaultProject`, since
  there is now one and `tsconfig.json` already includes it.
- The variant `rerank-llm` (`rerank.enabled`, strategy `llm`, 20 candidates) so that
  `pnpm search "..." --variant rerank-llm` shows both orders.

## 6. Not in this ticket

Measuring what reranking buys (RAG-062's benchmark and the evaluation runner, RAG-083), and the
cross-encoder in this test (it downloads a model, so it is covered by its own tests and a benchmark).
