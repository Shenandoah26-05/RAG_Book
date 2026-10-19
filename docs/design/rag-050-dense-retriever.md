# RAG-050 design: Retriever port and dense retriever

**Ticket:** M5, feature, 2 points. Depends on RAG-034 (indexing pipeline) and RAG-041 (flat store, ChunkStore).

## 1. What this ticket delivers

The first piece of the question side of the system. Indexing (034) prepares the book; a `Retriever`
takes a question and returns the passages most likely to answer it.

| Piece                                                                    | Where                                         |
| ------------------------------------------------------------------------ | --------------------------------------------- |
| `Retriever` port, `RetrieveOptions`                                      | `src/core/ports/retriever.ts`                 |
| `RetrievedChunk`                                                         | `src/core/types/retrieval.ts`                 |
| `DenseRetriever`                                                         | `src/strategies/retrieval/dense-retriever.ts` |
| Shared **contract test** (`checkRetrieved`, `describeRetrieverContract`) | `src/testing/retriever-contract.testing.ts`   |

| Acceptance criterion                                                          | Met by                                             |
| ----------------------------------------------------------------------------- | -------------------------------------------------- |
| Retriever interface in core/ports                                             | `Retriever`                                        |
| DenseRetriever: embed query (kind "query") → store.search → ChunkStore lookup | `DenseRetriever.retrieve`                          |
| Results carry rank, score and retriever name                                  | `RetrievedChunk { chunk, score, rank, retriever }` |

**Not in this ticket:** loading a saved index into stores, building a retriever from config, and a
search command (see section 4). BM25 (051), hybrid (052), MMR (053) and the parent expansion (054).

## 2. How a search works

```
question text
   │  Embedder.embed([text], "query")
   ▼
query vector
   │  VectorStore.search(vector, k, filter)         ids + cosine scores, best first
   ▼
[{ id, score }, ...]
   │  ChunkStore.get(ids)                           the id → chunk step
   ▼
[{ chunk, score, rank: 1.., retriever: "dense" }, ...]
```

The filter goes into the vector store's search, so it is applied before ranking (RAG-043): asking for
`k` chunks of one chapter returns `k` chunks of that chapter, not what is left of the global top `k`.

## 3. Decisions

| #   | Decision                                                     | Why                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | A new `RetrievedChunk`, not the existing `ScoredChunk`       | The ticket needs `rank` and `retriever` on every result. Hybrid retrieval (052) needs to know which retriever produced a rank, and reports need the name. `ScoredChunk` stays for code that has just a chunk and a score.                             |
| D2  | `retrieve(query, { k, filter? })`                            | `k` is required: a retriever has no sensible default. `filter` is the `MetadataFilter` from RAG-043, so a search command can pass its parsed flags straight through.                                                                                  |
| D3  | A vector without a chunk is an `INTERNAL` error              | RAG-041 left this to the retriever. The two stores are written together by the indexing pipeline, so a mismatch means a damaged index. Skipping it would quietly give fewer or worse results. The message names the id and says `pnpm index --force`. |
| D4  | Dimensions are checked in the constructor                    | A wrong embedder is caught when the retriever is built, not on the first question, with both lengths and the model id in the message.                                                                                                                 |
| D5  | The model itself cannot be checked here                      | Two models can both make 384 numbers and still live in different spaces. The retriever sees only the stores, not the manifest that names the index's model. Whoever loads the index (see 4) must build the retriever with that model.                 |
| D6  | A blank question or a bad `k` is `INVALID_ARGUMENT`          | A caller's mistake, as with a bad page range in RAG-040. It is rejected before the embedder is called, so a wrong `k` costs no model call.                                                                                                            |
| D7  | The class is in `strategies/retrieval`                       | It is a pure algorithm over ports, which is what `strategies/` is for. BM25 and hybrid will sit beside it. The layer rules let only `composition/` import it.                                                                                         |
| D8  | The contract is shared, like the chunker and store contracts | BM25 (051) and hybrid (052) must pass the same checks: at most `k`, ranked from 1 with no gaps, scores never rising, the right name, the filter respected, deterministic, bad arguments rejected. `checkRetrieved` is tested with broken results.     |

## 4. A gap this ticket does not close

Nothing yet turns a saved index back into a `VectorStore` and a `ChunkStore`. `pnpm index` (034)
writes `chunks.jsonl`, `vectors.bin` and `manifest.json`; RAG-042's `IndexFile` reads and writes a
different pair of files (`index.json`, `vectors.f32`). A loader for the 034 folder, and a
`buildRetriever` in the composition root that uses it and the manifest's embedder, belong with the
search command (RAG-055). Until then `DenseRetriever` is exercised with the in-memory stores.

## 5. Testing

- `DenseRetriever`: nearest first with rank, score and name; a second question finds another chunk;
  the question is embedded once, as `"query"`; fewer than `k`; a parent stored without a vector is
  never returned; a filter applied before ranking; an empty index; a missing chunk, a wrong
  dimension, a wrong number of vectors, an embedder that fails; no model call for bad arguments.
- The shared contract on `DenseRetriever`.
- `checkRetrieved` against deliberately broken results, one violation each.
