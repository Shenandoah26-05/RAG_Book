# RAG-074 design: query rewriting and conversation memory

**Ticket:** M7, feature, 3 points. Depends on RAG-073 (the chatbot that holds the conversation).
**Status:** **built** (2026-10-22).

## 1. What this ticket delivers

Follow-up questions that work. "What about chapter 4?" means nothing to a retriever: it embeds
those words and finds passages about chapters in general. With the last few turns in hand, a model
can restate it as "What does chapter 4 say about chunking sizes?", which retrieves the right thing.

| Piece                                      | Where                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `QueryTransformer` port (now with options) | `src/core/ports/query-transformer.ts`                                  |
| `Query.history`, `Query.variants`          | `src/core/types/chat.ts`                                               |
| `FollowUpRewriter`                         | `src/strategies/query-transform/follow-up-rewriter.ts`                 |
| `HydeTransformer`                          | `.../hyde-transformer.ts`                                              |
| `MultiQueryTransformer`                    | `.../multi-query-transformer.ts`                                       |
| `QueryTransformChain`                      | `.../query-transform-chain.ts`                                         |
| `ConversationHistory`                      | `.../conversation-history.ts`                                          |
| `MultiQueryRetriever`                      | `src/strategies/retrieval/multi-query-retriever.ts`                    |
| Building from config                       | `src/composition/build-query-transformer.ts`                           |
| Prompts                                    | `prompts/rewrite-question.v1.txt`, `hyde.v1.txt`, `multi-query.v1.txt` |
| Flags                                      | `queryTransform.*` in `rag.config.json`                                |

| Acceptance criterion                        | Met by                                             |
| ------------------------------------------- | -------------------------------------------------- |
| QueryTransformer port                       | existing port from RAG-072, extended (D1)          |
| Follow-ups rewritten using the last N turns | `FollowUpRewriter`, `queryTransform.historyTurns`  |
| HyDE and multi-query optional, behind flags | `queryTransform.hyde`, `queryTransform.multiQuery` |
| Transformers chain like cleaners            | `QueryTransformChain`, built like `CleaningChain`  |

## 2. How a follow-up flows

```
ChatSession ── ConversationHistory.turns() ──┐
                                             ▼
ask("What about chapter 4?", { history })
   │  transform   Query { text, history }
   │      FollowUpRewriter → text = "What does chapter 4 say about chunking?"
   │      MultiQueryTransformer → variants = [..]        (flag)
   │      HydeTransformer       → variants += passage    (flag)
   ▼
   retrieve   MultiQueryRetriever searches text + each variant, fuses with RRF
   rerank → assemble (user message = the standalone question) → generate
   ▼
ChatSession records { question, answer } only if the answer ended normally
```

## 3. Decisions

| #   | Decision                                                          | Why                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | History travels on `Query`, the port stays one function           | A new optional field keeps `transform(query)` and lets transformers chain: each gets what the one before returned. The port also gains `options.signal` so Ctrl+C can stop a rewrite in progress.                        |
| D2  | `text` is always the question put to the answering model          | HyDE would otherwise send an invented passage to the model as if it were the question. Extra searches go in `variants`; `text` is only ever replaced by the rewriter, with a real question.                              |
| D3  | First question: no history, no model call                         | A rewrite of a standalone question is wasted latency. `transform` returns the same object.                                                                                                                               |
| D4  | An unusable rewrite falls back to the original question           | Empty, over 500 characters, or a label like "Standalone question:" is cleaned or ignored. A weak model makes retrieval no better, never worse. A model that is down still fails the question, as it would anyway.        |
| D5  | HyDE and multi-query add `variants`; `MultiQueryRetriever` merges | Transformers return one `Query`, retrieval happens once. A decorator retriever searches every text and fuses with RRF, which needs no common score scale. It is only wrapped when one of the flags is on.                |
| D6  | HyDE keeps the question as its own search                         | The original paper searches the passage alone. Fusing the question's ranking with the passage's keeps the user's own words, which matter for BM25 and hybrid.                                                            |
| D7  | Memory lives in `ChatSession`, not in the pipeline                | The pipeline stays stateless and testable; the session is the thing that has a conversation. `/clear` resets it. It holds `historyTurns` turns, the same number the rewriter reads.                                      |
| D8  | Only an answer that ended is remembered                           | A stopped or failed answer would put half a reply into the memory. Citation marks are stripped from remembered answers when shown to the rewriter, since `[2]` pointed into a prompt that is gone; long answers are cut. |
| D9  | Prompts are versioned files, like the answer and rerank prompts   | Wording is data. `parseQueryPrompt` checks the file name and placeholders; filling is one pass, so a value containing `{{question}}` is not substituted again.                                                           |
| D10 | Rewrite is on by default; HyDE and multi-query are off            | Rewriting costs nothing on a first question and is what makes chat usable. The other two cost a model call per question and are experiments to compare in eval.                                                          |
| D11 | The answering model does the rewriting                            | One model to install and configure, as with the `llm` reranker. A smaller model could be configured later.                                                                                                               |

## 4. Known limits

- The answering model does not see the history, only the rewritten question. Pronouns it resolves are
  already resolved in the rewrite, but it cannot refer back to its own earlier wording.
- The rewriter is as good as the model. A reply that changes the meaning cannot be detected here.
- Multi-query and HyDE multiply the retrieval work by `1 + variants`.

## 5. Testing

- `FollowUpRewriter`: rewrite with history, no call without it, only the last N turns, citation marks
  removed, reply cleaning, fallback on unusable replies, failure and abort, input unchanged.
- `HydeTransformer`, `MultiQueryTransformer`: variants added not text changed, cleaning and de-duplication.
- `QueryTransformChain`: order, nesting, options, abort. `ConversationHistory`: bound, clear, copy.
- `MultiQueryRetriever`: one search without variants, fusion of several, depth and filter, errors.
- `RagPipeline`: history and signal reach the transformer; the rewrite is what is retrieved.
- `ChatSession`: history sent oldest first, bounded, failed turns not remembered, `/clear`.
- `buildQueryTransformer`: identity, single, chain order, prompt files read only when needed.
