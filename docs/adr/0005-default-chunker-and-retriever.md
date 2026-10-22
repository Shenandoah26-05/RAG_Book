# ADR-0005: Default chunker and retriever

- **Status**: Proposed. The rule below is fixed; the evidence is not in yet (see "Evidence").
- **Date**: 2026-10-22

## Context

The system ships with `chunking.strategy: "recursive"` and `retrieval.strategy: "hybrid"` (dense and
BM25 fused with RRF), no reranking. Those were chosen when the strategies were written, before any
could be measured. RAG-083 can now run every combination over the evaluation dataset, and RAG-084
turns the result into a report. This ADR is where the defaults are chosen **from that evidence**,
or confirmed.

A choice made after looking at the numbers can be bent to fit them: with 40-odd questions, one of
several variants will always come out on top by luck. So the rule for choosing is written here,
**before** the experiments are run, and the report states its verdicts from a bootstrap interval
rather than from which mean is larger.

## The rule

The comparison is made on dataset version `v1`, with `evals/experiments/retrievers.json` (retrieval
strategy, with and without reranking) and `evals/experiments/chunkers.json` (chunking strategy and
size). Every variant is compared with **the current default** (`recursive` + `hybrid`, no reranking)
as the baseline, question by question, by nDCG at `k = 5`.

A variant replaces the default only if **all** of these hold:

1. **It is clearly better.** The report's verdict for nDCG is "better": the 95% interval of the mean
   difference excludes 0.
2. **It does not find less.** Recall is not "worse" (interval entirely below 0).
3. **It is not much slower.** Its retrieval latency p95 is at most twice the default's.
4. **It does not guess more.** It refuses at least as many unanswerable questions.

If no variant meets all four, **the default stays**. "No clear difference" is a result, not a gap to
fill: when two options cannot be told apart on this evidence, the one already in place wins, because
changing it has a cost and the evidence does not pay for it.

Reranking and generation are decided separately. Reranking adds a model call per candidate, so it
is judged on cost as well as quality (RAG-063 compared it on its own). Answer quality (faithfulness,
relevance, correctness) is reported by `evals/experiments/answers.json` and informs the prompt and
`k`, not the chunker or retriever.

## Options

### Option A: keep `recursive` + `hybrid`

- Pros: already built, tested and documented; hybrid covers both exact words and meaning, so it has
  the fewest ways to miss; no change for anyone.
- Cons: hybrid is the most work per question (two searches and a fusion), and nothing yet shows it
  earns that.

### Option B: a different chunker (`fixed-size`, `structure-aware`, other sizes)

- Pros: structure-aware chunks follow the book's headings, which may keep answers whole; fixed-size is
  the simplest and fastest to build.
- Cons: each changes the index, so it is the costliest option to switch to; sizes interact with `k`
  and the context budget.

### Option C: a single retriever (`dense` or `bm25`)

- Pros: simpler and faster; `bm25` needs no embedding model at query time.
- Cons: each misses what the other finds (a paraphrase for BM25, a rare exact term for dense).

## Decision

**Provisionally: keep `recursive` + `hybrid` (option A).** This is the outcome of the rule when no
variant has been shown to beat it, which is the state today. The ADR becomes Accepted when the
evidence below is filled in, either confirming A or naming the variant that met all four conditions,
in which case this section is rewritten and `rag.config.json` and `src/config/defaults.ts` change in
the same pull request.

## Evidence

**Not yet measured.** The experiments need Ollama (for embeddings, and for the judge if answers are
generated) and the ingested book. To fill this section in:

```
pnpm ingest data/raw/book.pdf
pnpm eval:validate data/raw/book.pdf
pnpm experiment evals/experiments/retrievers.json
pnpm experiment evals/experiments/chunkers.json
pnpm report retrievers --out docs/reports/retrievers-v1.md
pnpm report chunkers   --out docs/reports/chunkers-v1.md
```

Then commit the two reports under `docs/reports/` (the run folders in `evals/results/` are not
committed), and replace this section with, for each: the report path, the config hashes of the
baseline and of the winner, and the verdict on each of the four conditions.

| Condition                   | Retrievers report | Chunkers report |
| --------------------------- | ----------------- | --------------- |
| 1. nDCG clearly better      | _pending_         | _pending_       |
| 2. recall not worse         | _pending_         | _pending_       |
| 3. p95 latency at most 2x   | _pending_         | _pending_       |
| 4. refuses at least as many | _pending_         | _pending_       |

## Consequences

- **Easier:** the choice is auditable. A reader can follow it from the default to this ADR, to a
  report, to the config of each variant, and re-run it.
- **Harder:** a change of dataset, book, embedding model or chunk size can change the answer, so the
  decision is tied to dataset `v1` and the models named in the report. A different book needs its own
  dataset and a new ADR that supersedes this one.
- **Limits:** about 40 answerable questions can show a large gap but not a small one. Expect "no clear
  difference" between close variants, and treat it as the answer. More questions are cheaper than
  more argument.
- **Reversing:** change the defaults in `rag.config.json` and `src/config/defaults.ts`. Indexes are
  kept per chunking setting, so nothing needs to be rebuilt to go back.
