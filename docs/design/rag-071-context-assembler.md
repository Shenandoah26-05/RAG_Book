# RAG-071 design: context assembler (the augmentation step)

**Ticket:** M7, feature, 3 points. Depends on RAG-050 (`RetrievedChunk`) and RAG-021 (`Tokenizer`).
**Status:** **built** (2026-10-19).

## 1. What this ticket delivers

The "A" in RAG. Retrieval hands over ranked chunks; the assembler turns them into the prompt the
model reads: numbered sources with page citations, fitted to a token budget, in a chosen order.

| Piece                                               | Where                                                    |
| --------------------------------------------------- | -------------------------------------------------------- |
| `ContextAssembler` port                             | `src/core/ports/context-assembler.ts`                    |
| `PromptTemplate`, `AssembledPrompt`, `DroppedChunk` | `src/core/types/prompt.ts`                               |
| `TemplateContextAssembler`                          | `src/strategies/prompting/template-context-assembler.ts` |
| Ordering: `relevance`, `sandwich`                   | `src/strategies/prompting/ordering.ts`                   |
| Near-duplicate removal                              | `src/strategies/prompting/near-duplicates.ts`            |
| Source and citation formatting                      | `src/strategies/prompting/format-source.ts`              |
| Template parsing (name → id and version)            | `src/strategies/prompting/prompt-template.ts`            |
| The versioned system prompt                         | `prompts/rag-system.v1.txt`                              |

| Acceptance criterion                                    | Met by                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| Numbered sources with page citations                    | `formatSource` (`[2] Chapter 3 > 3.2 (pp. 41-42)`) and `citations[]` |
| Token budget enforced with the Tokenizer                | greedy fit, then a check on the finished block (section 3, D3)       |
| Ordering: relevance-first and sandwich                  | `orderForPrompt`, chosen by `generation.ordering`                    |
| Near-duplicate chunks removed                           | `removeNearDuplicates`, 3-word shingles, Jaccard ≥ 0.8               |
| Template is a versioned file; snapshot tests of prompts | `prompts/rag-system.v1.txt`; `__snapshots__/` for both orderings     |

**Not in this ticket:** reading the prompt file and building the assembler from `rag.config.json`
(the composition root, RAG-072), and sending the prompt to a model (RAG-070 / 072).

## 2. How assembly works

```
RetrievedChunk[] (ranked)      question
   │ sort by rank
   ▼
1. remove near-duplicates      the better-ranked copy stays          → dropped "duplicate"
2. fit the token budget        best first, skip what does not fit    → dropped "over-budget"
3. order for the prompt        relevance: 1 2 3 4 5   sandwich: 1 3 5 4 2
4. number, cite, render        [1]..[n] into {{sources}} of the template
   ▼
AssembledPrompt { system, user, promptVersion, included, citations, dropped, sourceTokens, budget }
```

## 3. Decisions

| #   | Decision                                                         | Why                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `ContextAssembler` is a port; the class is in `strategies/`      | The pipeline (072) knows only ports. The algorithm is pure (no I/O), so it belongs with the other strategies.                                                                                                                |
| D2  | The template is passed in as a value, the file is read outside   | `strategies/` may not touch the file system. `parsePromptTemplate(fileName, text)` takes the id and version from the name (`rag-system.v1.txt`), so they cannot disagree with the file. The composition root reads the file. |
| D3  | Fit first, order second, then verify                             | The budget decides which chunks are in; ordering only decides where. Sandwich renumbers chunks (`[9]` can become `[10]`), so the real cost is checked on the finished block and the weakest chunk is dropped until it fits.  |
| D4  | A chunk that does not fit is skipped, not cut                    | A half passage under a page citation claims more than the book says. A smaller, lower-ranked chunk after it may still fit. If nothing fits, the prompt says no sources were found and the model is told to admit it.         |
| D5  | Near-duplicates by word-triple overlap, threshold 0.8            | Sliding-window overlap is expected and fine: two chunks sharing a few sentences score low. Only mostly-shared text is a copy. No embeddings needed, so it works for any retriever. The threshold is an option.               |
| D6  | `dropped` records every omitted chunk with a reason              | Eval and the trace (072) need to see why a retrieved chunk never reached the model. Every input chunk is in exactly one of `included` or `dropped`.                                                                          |
| D7  | `citations[i].index === i + 1`                                   | The model writes `[3]`; the UI looks up `citations[2]`. Numbers are assigned after ordering, so they always match what the model saw.                                                                                        |
| D8  | `promptVersion` is `"<id>@<version>"` on every result            | Eval results can name the prompt they ran with. Changing the wording means a new `v2` file, never an edit of `v1`.                                                                                                           |
| D9  | Replacement uses a function, not a string                        | `String.replace` treats `$&` and `$1` in a replacement string as patterns. A book passage can contain `$`, so the sources are inserted literally.                                                                            |
| D10 | The prompt tells the model that sources are material, not orders | Book text is untrusted input. One line in the template reduces, but does not remove, prompt injection from a hostile PDF.                                                                                                    |

## 4. Testing

- `orderForPrompt`: relevance, sandwich for odd and even counts, 0 to 2 items, input unchanged.
- `removeNearDuplicates`: identical, disjoint, edge-overlap and short texts; the first copy stays.
- `parsePromptTemplate`: bad names, placeholder missing or repeated, the shipped file parses.
- `TemplateContextAssembler`: numbering and citations in prompt order; the budget never exceeded
  (both orderings, five budgets); a too-big chunk skipped and a smaller one used; no sources; `$`
  patterns kept literal; every chunk accounted for; deterministic; bad budget, threshold, question.
- **Snapshots** of the assembled system prompt (relevance, sandwich, no sources). A diff in review
  means the wording or layout changed, which should come with a new prompt version.
