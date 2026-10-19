# RAG-062 design: Cross-encoder reranker (transformers.js)

**Ticket:** M6, feature, 3 points. Depends on RAG-060 (reranker port and wiring).
**Status:** **built** (2026-10-19).

## 1. What this ticket delivers

A reranker that runs a purpose-built relevance model **inside the Node process**. Ollama does not serve
cross-encoders, so this one loads the model itself with `@huggingface/transformers`.

| Piece                                          | Where                                                          |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `RelevanceScorer` port                         | `src/core/ports/relevance-scorer.ts`                           |
| `ScoringReranker` (any scorer -> a `Reranker`) | `src/strategies/reranking/scoring-reranker.ts`                 |
| `CrossEncoderScorer` (batches, lazy load)      | `src/adapters/rerankers/cross-encoder-scorer.ts`               |
| transformers.js glue                           | `src/adapters/rerankers/transformers-backend.ts`               |
| `rerank.strategy: "cross-encoder"`             | one line in `src/composition/build-reranker.ts`                |
| Real-model test (opt-in), timing script        | `tests/integration/cross-encoder.test.ts`, `pnpm bench:rerank` |

| Acceptance criterion                                              | Met by                                                                                                                                                                                       |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@huggingface/transformers` with an MS MARCO MiniLM cross-encoder | `Xenova/ms-marco-MiniLM-L-6-v2`, 8-bit ONNX build                                                                                                                                            |
| Scores query-chunk pairs in batches                               | `CrossEncoderScorer`, `batchSize` 8 by default                                                                                                                                               |
| Latency and quality compared with the LLM reranker                | **Not yet:** the LLM reranker (RAG-061) is not built. The cross-encoder's own numbers are in section 5 and `pnpm bench:rerank <strategy>` will time the LLM one the same way once it exists. |

## 2. Bi-encoder vs cross-encoder

The `Embedder` is a **bi-encoder**: it turns the question and every passage into vectors separately,
so the passages are embedded once, when the book is indexed, and a search is a cheap vector
comparison. The price is that the model never sees question and passage together.

A **cross-encoder** reads `[question] [passage]` as one input and outputs one number for how well the
passage answers the question. It sees how the words relate, so it is more accurate, but there is
nothing to precompute: every candidate costs a model run at question time. So it does not search the
book; it reorders the few candidates (`rerank.candidates`, 20 by default) a retriever already found.

```
retriever: top 20 by vector/keyword  --->  cross-encoder: score 20 pairs  --->  best k
```

## 3. How it fits

```
Reranker (port)                      exists since RAG-060
  └─ ScoringReranker                 checks arguments, scores, sorts, keeps k
        │ uses
     RelevanceScorer (port)          score(query, passages[]) -> number[]
        └─ CrossEncoderScorer        batches, loads the model once, on first use
              └─ loadTransformersBackend   the only file that imports transformers.js
```

## 4. Decisions

| #   | Decision                                                                | Why                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | A `RelevanceScorer` port plus a generic `ScoringReranker`               | Adapters may not import from `strategies/`, where the shared argument checks live. The split also means sorting, ties and `k` are tested without a model, and the LLM reranker (061) can reuse `ScoringReranker` with a scorer that asks an LLM, so the two are compared on equal terms. |
| D2  | The model is a constant with a constructor override, not a config key   | The `rerank` config block is strict and the ticket does not ask for a new setting. Adding one later is additive.                                                                                                                                                                         |
| D3  | The model loads on first use, once, and a failed load is not remembered | Building the pipeline (or the composition root with reranking configured) costs nothing, and overlapping calls share one load. After a failed first download (offline), the next call tries again.                                                                                       |
| D4  | transformers.js is imported inside the loader, not at the top           | Importing this module does not load the ONNX runtime. Only a run that reranks pays for it.                                                                                                                                                                                               |
| D5  | A load failure is `PROVIDER_UNAVAILABLE` with the cause attached        | The message says the first use downloads the model and needs the network once. After that it runs offline from the library's cache.                                                                                                                                                      |
| D6  | Scores are the model's raw logits                                       | Higher is more relevant. They are only comparable within one call, as the `RelevanceScorer` rules say. Equal scores keep the retriever's order, so results are the same on every run.                                                                                                    |
| D7  | The scorer sees `chunk.text`, not `embedText`                           | `embedText` is a hint for the embedder (heading path). The reranker should judge the passage the reader and the LLM will see.                                                                                                                                                            |
| D8  | The 8-bit (`q8`) build                                                  | About a quarter of the size of full precision, and fast on CPU. The cost is that scores shift slightly with the batch size (section 5).                                                                                                                                                  |
| D9  | Passages longer than 512 tokens are cut                                 | The model's limit. Chunks are normally far smaller than this.                                                                                                                                                                                                                            |
| D10 | `pnpm-workspace.yaml` allows `onnxruntime-node`'s install script        | pnpm blocks dependency install scripts by default. `onnxruntime-node` needs its script to set up its native binaries. `protobufjs` is explicitly left blocked: its script is not needed.                                                                                                 |

## 5. Measured here

On the development machine (Windows 11, CPU only), model already downloaded, 8-bit build, batch size 8,
one question against passages with the right one in the middle:

| Candidates | First call (loads the model) | Later calls, median | Right passage moved |
| ---------- | ---------------------------- | ------------------- | ------------------- |
| 20         | about 0.9 s                  | about 95 ms         | #11 to #1           |
| 50         | about 1.0 s                  | about 200 ms        | #26 to #1           |

The very first run also downloads the model (about 8 s on this connection). Cost grows with the number
of candidates, about 4 ms per pair, which is why `rerank.candidates` is a setting and not "everything".
These are one machine, one question, one small set; read them as an order of magnitude, not a benchmark.

**Batch size and scores.** Padding a batch to its longest pair shifts the scores of this 8-bit model
a little: about 0.05 logits between batch size 1 and a batch of 4, where relevant and irrelevant passages
are 10 or more apart. The ranking of clearly different passages is the same; two near-equal passages could
swap. The same batch size always gives the same scores, so results are repeatable. The integration test
checks "same ranking, scores within 0.25".

## 6. Testing

- `ScoringReranker`: the shared `describeRerankerContract`; order, `k`, ranks and scores; the retriever name is kept; ties keep the retriever's order; one scorer call with the passage texts in order; no call for no candidates or bad arguments; a scorer that returns the wrong number of scores, NaN or Infinity is `INTERNAL`; the scorer's own errors pass through.
- `CrossEncoderScorer` with a fake model: batches of `batchSize` in order with scores put back together, the default of 8, nothing loaded for no passages or at construction, one load for overlapping calls, a failed load is retried, a wrong-length batch is `INTERNAL`, bad `batchSize`.
- Composition: `cross-encoder` is a known strategy, builds a `ScoringReranker` named `cross-encoder` without loading the model; `llm` is still unknown until RAG-061.
- Against the real model, off by default because of the download: `RAG_TEST_MODELS=1 pnpm test tests/integration/cross-encoder` runs the reranker contract, checks the passage that answers the question comes first, that two runs agree, and the batch-size behaviour above.

## 7. Not in this ticket

The LLM reranker (RAG-061) and the comparison with it; the on/off trace comparison (RAG-063); the
search CLI that calls `buildRerankingRetriever` (RAG-055).
