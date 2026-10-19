# RAG-075 design: Grounding guardrails

**Ticket:** M7, feature, 2 points. Depends on RAG-072 (pipeline orchestrator).
**Status:** **built** (2026-10-19).

## 1. What this ticket delivers

Three rules that keep an answer tied to the book. In 2022 an airline's chatbot told a customer
something its own policy page contradicted, and a tribunal held the airline to what the bot said:
the model sounded sure, nothing checked it against a source. These rules are the checks.

| Rule                                                     | Where                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1. Say "not found" when the best source scores too low   | `GroundedPipeline` (`src/pipeline/grounded-pipeline.ts`), `grounding.minScore` |
| 2. Every cited `[n]` must exist in the assembled context | `GroundedPipeline`, reported in `answer.grounding` and the trace               |
| 3. Retrieved text is fenced off from the instructions    | `prompts/rag-system.v2.txt`, `neutralizeFence` in `format-source.ts`           |

| Acceptance criterion                                             | Met by                                                                     |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| "Not found" when the best retrieval score is below a threshold   | rule 1; also whenever no source reached the prompt                         |
| Check that every cited `[n]` exists in the assembled context     | rule 2                                                                     |
| Retrieved text clearly separated from instructions in the prompt | rule 3                                                                     |
| Tests for each rule                                              | `grounded-pipeline.test.ts`, `prompt-v2.test.ts`, `build-pipeline.test.ts` |

## 2. Where the guardrails sit

```
RagPipeline.ask()            retrieve -> rerank -> assemble     (model NOT called yet)
        │
GroundedPipeline.ask()       looks at the finished answer object
        │  rule 1: no sources / best score < minScore ──► swap the stream for a fixed "not found"
        │                                                   reply; the model is never called
        │  rule 2: wrap the stream; at its end, check every [n]  ──► answer.grounding + trace
        ▼
caller (CLI, web app)
```

`RagPipeline` is not changed. `GroundedPipeline` wraps any `AnswerPipeline` (the small interface
`RagPipeline` already fits) and is one itself, so callers cannot tell, and a guardrail is dropped by not
wrapping. This works because `ask()` returns once the sources are known but reads the model's stream
lazily: there is a moment after the prompt exists and before any token is generated.

## 3. Decisions

| #   | Decision                                                                    | Why                                                                                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | A decorator around the pipeline, not a hook inside it                       | The ticket says guardrails sit around generation. The pipeline stays a plain sequence of stages with no `if` for an optional feature, and it is only ever constructed with the guardrails by `composition/build-pipeline.ts`.                                                                                                           |
| D2  | Refusal is a fixed reply, and the model is not called                       | A model asked to answer from nothing may produce something that sounds right. A fixed reply cannot. It also costs no tokens. The refusal reads like any reply (`text`, then one `end`), and its `citations` are empty.                                                                                                                  |
| D3  | No sources always refuses; the score rule is separate                       | "Nothing reached the prompt" needs no threshold. The score rule only applies when `grounding.minScore` is above 0.                                                                                                                                                                                                                      |
| D4  | The score checked is the best of the sources **in the prompt**              | A source dropped for budget is not in the prompt, so the answer cannot be grounded in it. The best is taken wherever it sits, because the sandwich ordering does not put it first. A score equal to `minScore` passes.                                                                                                                  |
| D5  | `grounding.minScore` defaults to **0**, which never refuses on score        | Scores have no common scale: cosine for dense retrieval, about 0.03 for fused RRF (the default `hybrid`), a logit for the cross-encoder, 0 to 10 for the LLM reranker. A number that is right for one is wrong for the others, and a guessed default would silently refuse everything under hybrid. Pick a value per setup (section 5). |
| D6  | Citation problems are **reported**, not repaired                            | The words have been streamed to the reader when the check can run. Buffering the whole reply to check it first would end token-by-token streaming; regenerating would double the cost in the failure case. `answer.grounding` and a trace stage let a UI show a warning.                                                                |
| D7  | The citation check reads the whole text, not each piece                     | A mark can be split across pieces of the stream (`"["`, `"7"`, `"]"`). `[1]`, `[2][3]` and `[1, 4]` are read; a year in brackets in a quotation would be flagged too, which is the price of not parsing language.                                                                                                                       |
| D8  | `grounding` always settles, and never rejects                               | It resolves when the stream ends, is abandoned (`break`) or fails, with `complete: false` for the last two. Only a stream that is never read leaves it pending.                                                                                                                                                                         |
| D9  | The fence is `<sources>…</sources>`, with rules before and a reminder after | Instructions at both ends of the prompt are harder to push out of the model's attention than instructions followed by pages of quoted text. The rules say plainly that nothing inside the tags is an instruction.                                                                                                                       |
| D10 | A passage's own `<sources>` / `</sources>` is written as `&lt;sources>`     | Otherwise a page containing `</sources>` ends the fence early and the text after it reads as instructions. Only these two tags are touched, in any case, so the text stays readable. The stored chunk and the citation's `quote` are unchanged.                                                                                         |
| D11 | The prompt is a new version, `rag-system.v2.txt`; v1 stays                  | A prompt is data named by its version (RAG-071) so eval results can say which wording they ran with. `PROMPT_FILE` now points at v2; old runs still name v1.                                                                                                                                                                            |
| D12 | `buildPipeline` returns a `GroundedPipeline`                                | It has the same `ask` and `describe` as `RagPipeline`, plus `answer.grounding`. Code that only calls those two methods needs no change; code that names the type `RagPipeline` should use `AnswerPipeline`.                                                                                                                             |

## 4. What the reader gets

`GroundedAnswer` is a `RagAnswer` plus `grounding`:

```ts
{ answered: boolean; refusal?: "no-sources" | "low-score";
  cited: number[]; unknownCitations: number[]; complete: boolean }
```

The trace gains `ground` (after `assemble`; says whether it answered, the best score and the threshold)
and, when the reply has been read, `check-citations` (how many marks, how many unknown).

## 5. Choosing `grounding.minScore`

Run a few questions the book answers and a few it does not, with your retriever and reranker settings,
and look at the best score in the trace (`ground.bestScore`). Put the threshold between the two groups.
Change the retriever or turn reranking on and the scale changes, so check again. Set it for one run with
`--grounding.min-score 0.3` or in `rag.config.json`.

## 6. Testing

- Citations: reported, passed through unchanged, zero and too-high numbers, groups, a mark split across
  pieces, no citations, early stop, a failing model, the trace stage.
- Not found: no sources, below / at / above the threshold, the best source wherever it sits, `minScore` 0,
  the model's stream never started on refusal, refusal shape and trace.
- As a pipeline: options passed to the wrapped pipeline, `describe`, a bad `minScore`.
- Prompt: v2 fences the sources, rules before and a reminder after, a passage with `</sources>` and
  injected instructions cannot close the fence, the stored chunk and citation are unchanged.
- Composition: the default configuration reports citations; `--grounding.min-score` refuses; the trace
  order; `GroundedPipeline` is constructed only in `composition/build-pipeline.ts`.

## 7. Not in this ticket

Rewriting or regenerating a reply with a bad citation; checking that a claim is actually supported by the
source it cites (that needs a model or an entailment check); filtering the model's reply for other
content; showing the warning in the CLI (RAG-073 can read `answer.grounding`).
