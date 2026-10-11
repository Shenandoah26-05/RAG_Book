# RAG-027: Parent–child (small-to-big) chunker

Search with small chunks, answer with their larger parents.

## How it works

1. **Cut parents.** The injected `parentSplitter` (normally the recursive chunker at `parentTokens`)
   cuts the document into the large chunks the answer is built from. They must not overlap.
2. **Cut children inside each parent.** The `childSplitter` (the recursive chunker at `childTokens`)
   gets one parent as a small document of its own (`documentView`). The chunks that come back are
   shifted onto the real document and rebuilt with `createChunk`, then given `parentId`. A child
   never crosses a parent edge, so it has exactly one parent.
3. **Two outputs.** `chunk()` returns the children, which are embedded and searched. `parents()`
   returns the parents, which are stored but not indexed.

```
document ──parentSplitter──► parents (stored, not indexed)
                                 │ childSplitter, per parent
                                 ▼
                             children (indexed), each with parentId
```

## Decisions

| #   | Question                                  | Options                                                                                                                       | Chosen                                                                                                                                                                              |
| --- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | How are parents exposed next to children? | (a) optional `parents()` on the `Chunker` port; (b) a separate method on this class only; (c) one flat array with a role flag | **(a)**, approved. Callers that only know `Chunker` can ask for parents. (c) would break the order and coverage rules.                                                              |
| D2  | Where do the sizes come from?             | (a) constructor options only; (b) a `chunking.parentChild` config block                                                       | **(a)**, approved. Config shape waits until the indexer needs it (as D9 in RAG-020).                                                                                                |
| D3  | How is a child tied to its parent?        | optional `parentId` on `Chunk`                                                                                                | Additive, like `embedText`. Absent on every other strategy.                                                                                                                         |
| D4  | Parent id vs child id                     | same strategy name; or a name of its own                                                                                      | Parents use strategy `parent-child-parent`. A parent no bigger than a child has the same span and text, so the ids would be equal and the child's `parentId` would point at itself. |
| D5  | Composition                               | copy the recursive logic; or inject two chunkers                                                                              | Inject two. `recursiveParentChild({...})` builds the usual setup.                                                                                                                   |
| D6  | Overlapping parents                       | clip them; or reject                                                                                                          | Reject (`INTERNAL`). Children of overlapping parents would repeat text and go back in document order.                                                                               |

## Rules it keeps

- `chunk()` passes the shared chunker contract. `parents()` passes the same checks under the name
  `parent-child-parent`. Both are tested.
- Every `parentId` names a parent from `parents()`, and the child's span lies inside that parent's.
- Children overlap each other only inside one parent (`childOverlapTokens`). Parents never overlap.

## Needed by later tickets

- **`ChunkStore` (RAG-041)** must store parents that are not themselves in the vector index, and
  look them up by id. The indexer (RAG-034) calls `chunker.parents?.(doc)` and writes them there.
- **RAG-054** replaces each retrieved child with its parent and merges duplicates, keeping the best score.

## Not in this ticket

- Registering `parent-child` in the `ChunkerRegistry` and reading sizes from `rag.config.json`.
  Nothing on `main` builds the registry yet, and the config shape is D2.
- The `ChunkStore` port and the expansion step (RAG-041, RAG-054).
