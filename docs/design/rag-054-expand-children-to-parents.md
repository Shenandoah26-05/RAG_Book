# RAG-054 design: Expand children to parents

**Ticket:** M5, feature, 2 points. Depends on RAG-027 (parent-child chunker) and RAG-050 (Retriever port).
**Status:** **built** (2026-10-19).

## 1. What this ticket delivers

The retrieval half of small-to-big. RAG-027 cuts small **children** (searched) out of larger
**parents** (shown to the reader and sent to the LLM). A search over small chunks is precise; the
bigger parent gives the answer enough context. `ParentExpandingRetriever` wraps any `Retriever` and
swaps each child it finds for its parent.

| Piece                      | Where                                                         |
| -------------------------- | ------------------------------------------------------------- |
| `ParentExpandingRetriever` | `src/strategies/retrieval/parent-expanding-retriever.ts`      |
| Its tests and contract run | `src/strategies/retrieval/parent-expanding-retriever.test.ts` |

| Acceptance criterion                                                   | Met by                                                               |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Results are replaced by their parents when the index uses parent-child | Each result with a `parentId` becomes the chunk that id names        |
| Duplicate parents merged, keeping the best score                       | The first child seen for a parent wins; inner results are best first |

**Not in this ticket:** building it from `rag.config.json` (there is no `buildRetriever` yet; it comes
with the search command, RAG-055).

## 2. How it works

```
question
   │  inner.retrieve(query, { k, filter })        children, best first (dense, BM25, hybrid...)
   ▼
[child, child, child, plain, ...]
   │  ChunkStore.get(unique parentIds)            one batched lookup
   ▼
   swap child -> parent, skip a parent already used, rank 1..n
   ▼
[parent (score of its best child), plain, ...]    retriever: "dense+parents"
```

## 3. Decisions

| #   | Decision                                            | Why                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | A decorator over any `Retriever`                    | It works with dense, BM25 and hybrid alike, and the pipeline cannot tell it from them. The port's own documentation planned it this way.                                                                                                                                                                                                                                                                       |
| D2  | Named `<inner>+parents`                             | The Retriever contract says every result names the retriever that returned it. `dense+parents` also shows in reports which setup produced a run.                                                                                                                                                                                                                                                               |
| D3  | A chunk without `parentId` passes through unchanged | A plain chunker's index, or a mix, keeps working. Wrapping a retriever over an index with no parents changes nothing, so it can stay switched on.                                                                                                                                                                                                                                                              |
| D4  | The filter decides which **children** are found     | The retrieval contract says every result satisfies the filter, but a parent is bigger than its child: a child on page 12 can have a parent on pages 10 to 14, and `pageRange 12` would reject it. Dropping such parents would lose exactly the passages asked for. The parent is returned as the context of a child that matched. This is the one deliberate exception to the contract rule, and it is tested. |
| D5  | A missing parent is `INTERNAL`, naming the id       | Same as RAG-050's missing chunk: the indexing pipeline writes children and parents together, so a gap means a damaged index. Falling back to the child would hide it and change what the LLM sees.                                                                                                                                                                                                             |
| D6  | Scores are the best child's, unchanged              | They stay comparable with the inner retriever's. A parent has no vector of its own to score.                                                                                                                                                                                                                                                                                                                   |
| D7  | Fewer than `k` results is allowed, no over-fetching | Children of one parent merge, so `k` children can make fewer parents. The contract says "at most k". Over-fetching would add a tuning knob this ticket does not ask for; it can be added later without changing the interface.                                                                                                                                                                                 |
| D8  | One `ChunkStore.get` for all parents                | A single batched lookup, with each parent id once, however many children point at it.                                                                                                                                                                                                                                                                                                                          |

## 4. Testing

- Children replaced by their parents in best-child order; children of one parent merged with the best score.
- Plain chunks pass through, mixed in by score; an index with no parents is unchanged.
- The name, in the retriever and in every result; fewer than `k`; a single batched lookup.
- The question, `k` and filter reach the inner retriever unchanged.
- A parent reaching outside a page filter is returned for a matching child (D4).
- A missing parent is `INTERNAL`; the inner retriever's `INVALID_ARGUMENT` passes through.
- The shared `describeRetrieverContract`, over a real `DenseRetriever` and the in-memory stores.
