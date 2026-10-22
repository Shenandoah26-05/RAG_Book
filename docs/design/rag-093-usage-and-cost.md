# RAG-093 design: usage and cost tracking

**Ticket:** M9, feature, 2 points. Depends on RAG-092 (resilience decorators).
**Status:** **built** (2026-10-22).

## 1. What this ticket delivers

What an answer costs, in tokens, time and money, recorded where the answer is recorded.

| Piece                                                                    | Where                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------ |
| `MeteredProvider`, `MeteredEmbedder`: record every call on the trace     | `src/strategies/usage/metered.ts`                      |
| `withTrace`, `currentTrace`: the trace of the question in scope          | `src/shared/trace-scope.ts`                            |
| `usageOf`, `totalUsage`, `costOf`, `formatMoney`: read a trace, price it | `src/shared/usage.ts`                                  |
| `pricing` in the config                                                  | `src/config/`, `rag.config.json`                       |
| Usage and cost on every experiment result and summary                    | `src/core/types/experiment.ts`, `src/eval/experiment/` |
| The cost section of the report                                           | `src/eval/report/cost-section.ts`                      |
| A usage line after each chat answer                                      | `src/composition/usage-format.ts`, `chat-session.ts`   |

| Acceptance criterion                                         | Met by                                                                           |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Tokens in and out and latency recorded per call in the trace | one `model-call` stage per call, with tokens, time to first token and total time |
| Price table in config                                        | `pricing.currency` and `pricing.models["<model id>"]`, per million tokens        |
| Experiment reports show cost per 100 questions               | "Cost per 100 questions" under "Latency and token cost" in the report            |

## 2. How a call gets onto a trace

```
RagPipeline.ask ── withTrace(trace) ──┐
                                      ▼
   transform   ─ model call (rewrite) ─┐
   retrieve    ─ embed call (question) ─┤   each is a MeteredProvider / MeteredEmbedder
   rerank      ─ model calls (LLM)     ─┤   finding currentTrace() and adding a stage to it
   generate    ─ model call (answer)  ─┘
                                      │
   trace.snapshot().stages ── usageOf ── totalUsage ── costOf(prices)
```

The decorator is built once, by `buildLlmProvider` and `buildEmbedder`, so **every use of the model is
counted**, not only the answer: the reranker, query rewriting and the judge call providers made the
same way. Nothing between the pipeline and the model has to carry the trace.

## 3. Decisions

| #   | Decision                                                                             | Why                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | The trace is the one record; totals and cost are computed from it                    | A separate counter could drift from the trace. `usageOf` reads the stages back, so what `/debug` shows and what the report sums are the same numbers.                                                                                                             |
| D2  | The trace is found in an `AsyncLocalStorage` scope, **read when `chat()` is called** | The answer is a lazily-run stream: it is read long after `ask` returned, in the reader's context, where the scope is gone. The decorator captures the trace at the call, and the pipeline puts the trace back in scope for the `generate` call. A test pins this. |
| D3  | Metering goes outermost on a model, inside the cache for an embedder                 | Outermost on a model: it records what the caller experienced, retries and waits included. Inside the cache on an embedder: a cached vector is not a call and costs nothing.                                                                                       |
| D4  | Outside a question the decorator does nothing                                        | With no trace in scope it returns the model's own stream, so metering can stay on everywhere (indexing, the CLI, tests).                                                                                                                                          |
| D5  | A failed or abandoned call is recorded too                                           | A stopped answer still cost tokens. The stage says `completed: false`; `Trace` lets a failed stage keep its summary so the model is not lost.                                                                                                                     |
| D6  | Tokens are the provider's, never invented; embeddings are estimated                  | A model that reports none is counted in `callsWithoutTokens`. An embedder reports no tokens, so they are estimated from characters (4 per token), marked `estimated`, and kept apart from model tokens.                                                           |
| D7  | A model with no price costs nothing, and its tokens are named                        | Free local models and forgotten prices must not look alike. The cost leaves unpriced tokens out and the report says how many there were. List a local model at 0 to say it is free.                                                                               |
| D8  | No prices ship in the defaults                                                       | Prices change and the default models are local. The table is empty; the user adds the model ids they use, with the current prices.                                                                                                                                |
| D9  | Cost per 100 questions divides by the questions that ran                             | A failed question is left out of the total, so it must be left out of the divisor, or a variant that fails would look cheaper.                                                                                                                                    |
| D10 | The judge is counted apart from the system                                           | It measures the system and is not part of what answering costs. Its calls go on a trace of their own (the runner puts one in scope around `judge()`), so they cannot be mixed into the system's total.                                                            |
| D11 | The `generate` stage of the pipeline stays as it was                                 | It already recorded tokens for the answer. Totals count only `model-call` stages, so the answer is not counted twice.                                                                                                                                             |

## 4. Known limits

- **Latency is the sum of calls.** Calls that overlap (the reranker scores candidates in parallel) are
  each counted in full, so "model time" can exceed the question's wall time. It is a measure of work,
  not of waiting.
- **Indexing is not costed.** Embedding a book happens outside any question, so it has no trace. The
  embedder is metered, and a future indexing report could put a trace in scope around the build.
- **Embedding tokens are estimates.** Good enough to price a hosted embedding model to within a few
  percent; not a bill.
- **Money is only as good as the table.** The table is typed by hand and not checked against any
  provider.

## 5. Testing

- `usageOf`, `totalUsage`, `costOf`, `formatMoney`: reading stages back, the unreported tokens, failed
  calls, hand-computed prices, free against unpriced, the prototype.
- `withTrace`: nesting, concurrent scopes, and that a generator read outside the scope does not see it.
- `MeteredProvider`: tokens, time to first token, **a reply read outside the scope is still recorded**,
  concurrent questions kept apart, nothing outside a question, a failed call, a stopped reply.
- `MeteredEmbedder`: the estimate, failure, empty input, no trace.
- The pipeline end to end: rewrite, rerank and the answer all land on the question's trace; the answer
  is recorded although it is read after `ask` returned; two questions at once stay apart.
- The experiment runner: usage and cost on results, the judge on its own trace, per 100 questions
  dividing by questions that ran, no price table.
- `buildExperiment` with the real decorators and a price table: costs by hand, a refused question with
  no usage, the judge apart, the report section, and no money without prices.
- The report: the cost section with and without prices, fractions of a cent, unpriced tokens, the
  judge, old files without a cost.

Writing these found a real bug: when `formatMoney` moved, its regex lost an escape and cut the last
digit of every amount (`0.00045` became `0.0004`). Four tests caught it.
