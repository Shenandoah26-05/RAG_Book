# ADR-0005: Which embedding model is the default

- **Status**: Proposed (the comparison is built but has not been run yet)
- **Date**: 2026-10-22

## Context

The pipeline has used `all-minilm` (Sentence-BERT, 384 dimensions, 45 MB) since RAG-031 because it is
small and fast. RAG-090 asks whether a larger model retrieves enough better on this book to justify
its cost. Two candidates are available through Ollama:

- `nomic-embed-text`: 768 dimensions, asymmetric (`search_query: ` / `search_document: ` prefixes).
- `mxbai-embed-large`: 1024 dimensions, asymmetric (a long prefix on the question only), about
  512 tokens of context.

Larger vectors cost more disk, memory and time per comparison, and a larger model is slower to embed
the book and every question.

## Options

### Option A: Keep `all-minilm`

- Pros: smallest, fastest, nothing to change.
- Cons: may retrieve worse.

### Option B: `nomic-embed-text`

- Pros: twice the dimensions, long context, tuned for retrieval.
- Cons: needs its prefixes, or it quietly under-performs.

### Option C: `mxbai-embed-large`

- Pros: largest of the three.
- Cons: 1024 dimensions, short context (chunks must stay small), needs its query prefix.

## Method

`pnpm experiment evals/experiments/embedders.json`: same chunks (recursive, 300 tokens), dense
retrieval only, k = 5, dataset v1, retrieval metrics only. One variable changes: `embedding.model`.
Prefixes come from `configs/embedding-models.json` ([design](../design/rag-090-embedding-model-ab.md)).

## Results

_To fill in after the run: recall@5, MRR and nDCG per model, embedding time for the book, vector
size on disk. Report per-question wins and losses too, not only the averages (RAG-084)._

| Model               | recall@5 | MRR | nDCG@5 | Index time | Index size |
| ------------------- | -------- | --- | ------ | ---------- | ---------- |
| `all-minilm`        |          |     |        |            |            |
| `nomic-embed-text`  |          |     |        |            |            |
| `mxbai-embed-large` |          |     |        |            |            |

## Decision

_Pending the results. If the larger models do not clearly win, the default stays `all-minilm`;
that is a valid outcome._

## Consequences

Whichever model wins, the profile file makes switching later a one-line config change
(`embedding.model`) plus `pnpm index`. Indexes are separate per model, so nothing is overwritten.
