# RAG-092 design: resilience decorators

**Ticket:** M9, feature, 2 points. Depends on RAG-091 (the OpenAI-compatible provider).
**Status:** **built** (2026-10-22).

## 1. What this ticket delivers

Retries, timeouts and rate limits for any model or embedder, added around an adapter and never inside
it, and switched on from the config.

| Piece                                                               | Where                                                          |
| ------------------------------------------------------------------- | -------------------------------------------------------------- |
| `RetryingProvider` / `RetryingEmbedder`, and the rules in `Retrier` | `src/strategies/resilience/retrying.ts`, `retrier.ts`          |
| `TimeoutProvider` / `TimeoutEmbedder`                               | `src/strategies/resilience/timeout.ts`                         |
| `RateLimitedProvider` / `RateLimitedEmbedder`, and `RateLimiter`    | `src/strategies/resilience/rate-limited.ts`, `rate-limiter.ts` |
| `Resilience`: stacks them from the config                           | `src/composition/build-resilience.ts`                          |
| `RagError.retryable` and `retryAfterMs`                             | `src/shared/errors.ts`                                         |
| What each adapter says about its failures                           | `src/adapters/http-failure.ts` and the adapters                |
| `Clock` (real and fake time)                                        | `src/shared/clock.ts`, `src/testing/fake-clock.testing.ts`     |
| `resilience.generation` and `resilience.embedding`                  | `src/config/`, `rag.config.json`                               |

| Acceptance criterion                                                   | Met by                                                                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Retrying, Timeout and RateLimited wrap any `LlmProvider` or `Embedder` | Each exists for both ports (six small classes over three pieces of shared logic) |
| Composed in the composition root from config                           | `Resilience`, called by `buildLlmProvider` and `buildEmbedder`                   |

The ticket names three decorators that wrap "any `LlmProvider` or `Embedder`". A class cannot
implement both ports (`chat` and `embed` are different shapes), so each decorator has a provider
version and an embedder version. They share the same logic: `Retrier`, `RateLimiter`, and one timer.

## 2. How a call is protected

```
caller
  └─ Retrying        waits and tries again, only for a failure that says it may pass
       └─ RateLimited    waits for a turn: calls per minute, calls at once
            └─ Timeout       gives up on silence
                 └─ adapter  (Ollama, an OpenAI-compatible server, ...)
```

For an embedder, the cache goes outside all of it (`Caching( Retrying( RateLimited( Timeout( adapter ) ) ) )`),
so a cached vector costs no turn and no retry.

## 3. Decisions

| #   | Decision                                                                            | Why                                                                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Decorators live in `strategies/`, never in an adapter                               | "Cross-cutting concerns as decorators." They are logic over ports, so they work for any provider, including one written later. Time is injected (`Clock`), which keeps them pure and makes every test run on a fake clock without sleeping.                                                        |
| D2  | The adapter says whether a failure is `retryable`; the decorator decides what to do | Only the adapter knows a 404 (missing model) from a 429 (busy). It marks its errors (a dropped connection, a timeout, 429 and 5xx are retryable; 400, 401, 403, 404 are not). The retry policy stays outside. **An error with no mark is never retried**: guessing wrong means retrying a mistake. |
| D3  | A reply is retried only before its first event                                      | Once text has reached the caller, a retry would start the answer again and the reader would see the beginning twice. After that the failure is thrown as it is. This is the rule the adapters were relying on when they said they never retry.                                                     |
| D4  | Exponential backoff with full jitter                                                | The wait is a random point below a cap that doubles. Callers that failed together do not come back together.                                                                                                                                                                                       |
| D5  | `Retry-After` is honoured, and a wait longer than `maxBackoffMs` is refused         | The wait is at least what the server asked. If it asked for ten minutes and the cap is eight seconds, the caller cannot wait that long, so it hears about the failure now instead of hanging.                                                                                                      |
| D6  | The timeout is on **silence**, not on length                                        | For a reply the clock restarts with every event, so a long answer that keeps arriving is never cut, while a model that never starts (still loading) or stops half-way is abandoned. For an embedder it is the whole call. A timeout is retryable.                                                  |
| D7  | The timeout both aborts the request and races it                                    | The signal makes the adapter close its connection; the race frees the caller even from a provider that ignores the signal. The embedder port has no cancel, so an abandoned embedding runs on in the background and its result is dropped.                                                         |
| D8  | The rate limit is a sliding window, plus a concurrency cap                          | "N calls in any minute" matches how providers count; a counter that resets would let a burst across the boundary double the rate. A call over the limit waits its turn, first come first served. It is not rejected.                                                                               |
| D9  | Order: Retrying outside, RateLimited inside it, Timeout innermost                   | Timeout innermost so it measures the call and not the wait for a turn. Rate limit inside retrying so every attempt takes a turn: a retry is another request to the provider. Retrying outside so it waits without holding a turn.                                                                  |
| D10 | One `Resilience` per run owns the limiters                                          | The answering model, the reranker and the judge call the same service and must share its limit, so the limiter belongs to the run and not to each provider.                                                                                                                                        |
| D11 | A setting of 0 leaves the layer out                                                 | A configuration that turns everything off adds no wrapper. The defaults retry twice, wait up to 2 minutes of silence for a model (60 seconds for an embedder), and set no rate limit, which suits local models.                                                                                    |
| D12 | With resilience on, the Ollama embedder's own retry loop is off                     | It already retried inside the adapter. Both would multiply (3 times 3 attempts), and `retries: 0` would not mean off. The adapter's code and its option stay for anyone who builds it directly.                                                                                                    |

## 4. Known limits

- A timeout on an embedder cannot cancel the request underneath (the port has no signal). A hung
  server keeps the connection until the adapter's own timeout (60 s by default) closes it.
- Errors with no mark are not retried. The adapters mark the cases they can classify; a reply that is
  not what was expected, and an error line in the middle of a stream, are left unmarked on purpose.
- The reranker and judge share the generation limit; an embedder has its own. A provider that applies
  one limit to both would need `requestsPerMinute` split by hand.
- The Ollama embedder still contains its retry loop (see D12). Removing it is a follow-up once nothing
  builds it without `Resilience`.

## 5. Testing

- `Retrier`: delays by hand (doubling, cap, jitter, `Retry-After`, too long a wait), what is and is not
  retryable, logging, abort.
- `RetryingProvider`: a good reply untouched; retried before the first event; **not** retried after
  text was passed on; permanent errors; running out of retries; abort while waiting; closing the
  reply when the caller stops early; the same messages and options each attempt; lazy.
- `TimeoutProvider`: a model that never starts, one that stops half-way (earlier text kept), a long
  steady answer that is not cut, the request aborted underneath, a provider that ignores the signal,
  the caller's own abort, no timer left behind.
- `RateLimiter`: the sliding window (a burst across a boundary), FIFO, concurrency, both together,
  an aborted waiter, release called twice, no timer left.
- The decorators over a fake limiter: a turn held until the stream ends, given back on a `break` and
  on failure, one limit shared between wrappers.
- Every adapter (Ollama and OpenAI-compatible, model and embedder): what it says for an unreachable
  server, 429, 5xx, 4xx, and `Retry-After`.
- `Resilience` and the real builders with a fake server: retried 503, `Retry-After`, a missing model
  not retried, the cache outside (a cached text costs no call and no turn), the adapter not retrying
  on top of the decorator.
- The config section: defaults, per kind, file/environment/flags, 0 as off, bad values.
