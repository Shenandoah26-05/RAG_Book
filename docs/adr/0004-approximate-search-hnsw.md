# ADR-0004: Approximate search with HNSW: measured, not adopted

- **Status**: Accepted
- **Date**: 2026-10-19

## Context

RAG-044 is a spike: find out what approximate nearest-neighbour search costs and saves on this
book. The reference store (`FlatVectorStore`, RAG-041) is exact: it compares the query with every
vector. That is O(n) per query, so the usual advice is to switch to an approximate index (HNSW) once
n grows. We wanted to know where "once n grows" actually is for a book, and what the switch costs.

A book is small. At the chunk sizes in `rag.config.json` (400 tokens) one book is roughly 1,000 to
5,000 chunks, with 384-dimensional vectors (`all-minilm`).

## Options

### Option A: Stay on the flat store

- Pros: exact, no tuning, no build step, nothing to explain.
- Cons: query cost grows linearly with the number of chunks.

### Option B: Wrap `hnswlib-node` behind `VectorStore`

- Pros: fast native code, mature.
- Cons: a native addon that must compile on every machine (painful on Windows), a dependency for a
  gain we had not yet shown, and it hides how the algorithm works, which is half the point of the
  spike.

### Option C: Write a simplified HNSW by hand

- Pros: no dependency, pure TypeScript, fits the layer rules (`strategies/`), checked against the
  flat store through the shared contract. We learn the algorithm.
- Cons: slower than native code; we own the bugs.

## Decision

We built option C (`HnswVectorStore`, `src/strategies/in-memory-index/`) to take the
measurements, and **keep the flat store as the default** (`vectorStore.type: "in-memory"` stays
flat). HNSW stays available as a tested alternative, but nothing selects it yet.

## Findings

`pnpm bench:hnsw`: 384 dimensions, 200 queries, k = 10, `m = 16`, `efConstruction = 200`, clustered
synthetic vectors (cluster centre plus noise). Pure TypeScript on one core; times are medians per
query and will differ on another machine, the shape will not.

| chunks | build (HNSW) | flat ms/query | HNSW ms/query (`efSearch`) | speed-up | recall@10 | vectors compared |
| -----: | -----------: | ------------: | -------------------------: | -------: | --------: | ---------------: |
|  2,000 |        5.7 s |          1.63 |                  0.52 (16) |     3.1x |     0.997 |              280 |
|  2,000 |              |               |                  0.72 (32) |     2.3x |     1.000 |              422 |
|  2,000 |              |               |                  1.51 (64) |     1.1x |     1.000 |              760 |
| 10,000 |         45 s |          8.34 |                  0.45 (16) |    18.4x |     0.984 |              339 |
| 10,000 |              |               |                  0.49 (32) |    16.9x |     1.000 |              500 |
| 10,000 |              |               |                  0.85 (64) |     9.9x |     1.000 |              774 |
| 50,000 |        439 s |         30.51 |                  1.78 (16) |    17.1x |     0.952 |              386 |
| 50,000 |              |               |                  2.53 (32) |    12.1x |     0.991 |              512 |
| 50,000 |              |               |                  3.52 (64) |     8.7x |     1.000 |              709 |

(`efSearch` 128 and 256 are in the script's output; they only cost more for no recall gain here.)

What the numbers say:

1. **HNSW does what it promises.** It compares the query with a few hundred vectors whatever n is
   (280 to 770 here), so a query costs almost the same at 10,000 and 50,000 chunks. The flat store
   grows linearly: 1.6 ms, 8.3 ms, 30.5 ms.
2. **Recall is a dial, and it is high.** `efSearch` 32 gives recall@10 of 0.99 to 1.00 at every size.
   `efSearch` 16 is where misses start (0.95 at 50,000).
3. **For one book the saving is under a millisecond.** At 2,000 chunks flat takes 1.6 ms and the best
   HNSW setting 0.5 to 0.7 ms. Embedding the question with Ollama takes tens of milliseconds and the
   answer from the LLM takes seconds, so the retrieval step is not where the time goes at this size.
4. **The price is paid up front and in exactness.** Building the graph took 5.7 s for 2,000 chunks
   (the flat store: effectively nothing), grows faster than linearly, and is 7 minutes for 50,000
   in this implementation. Results are approximate, so the answer to a question can differ between
   stores in a way that is hard to debug.
5. **Random vectors are the worst case.** In the unit tests, uniform random 24-dimensional vectors
   (no clusters) needed 824 comparisons out of 1,500 at the default `efSearch`. Graph search works
   because real embeddings are clustered. The synthetic data here is clustered but real embeddings
   of the book were not available (the repository holds only a 2 KB sample PDF and Ollama was not
   running), so **the absolute numbers should be re-run on the real index** once there is one.

The crossover is around 10,000 chunks: where flat search passes ~8 ms and HNSW is 10x or more faster.
A single book does not get there; a library of dozens of books would.

## Consequences

- **Easier**: the question "do we need an approximate index?" has an answer with numbers, and
  `pnpm bench:hnsw` repeats it. If a library of many books is ever indexed, the HNSW store is ready
  and already passes the `VectorStore` contract; only the composition root needs to select it.
- **Harder**: nothing in the default path changes. We now carry about 300 lines of graph code that no
  default configuration uses; it has its own tests (recall against the flat store, filters, deletes).
- **Behaviour to know about**:
  - Deleting or replacing a record leaves a dead node in the graph (removing it would break paths);
    the graph is rebuilt when more than half the nodes are dead.
  - A filter is applied while walking the graph. A filter that very few chunks satisfy makes the
    walk long, up to a full scan, so a very selective chunk filter (RAG-043) is no faster than flat.
  - Inserts are not parallel and build time is the weak point of this implementation.
- **Follow-ups, not done**: persisting the graph (RAG-042 saves vectors only, and rebuilding is slow,
  so a persistent HNSW would need to save the links too); a config entry to select the store;
  re-running the benchmark on real embeddings.
- **Reversing**: free. Nothing depends on the HNSW store; deleting its files and this ADR's
  follow-ups changes nothing else.

See [docs/design/rag-044-hnsw.md](../design/rag-044-hnsw.md) for how the store works.
