# Evaluation dataset v1

The questions every variant of the system is judged on (RAG-080). Retrieval metrics (RAG-081) and
the answer judge (RAG-082) both read this file.

|           |                                                                              |
| --------- | ---------------------------------------------------------------------------- |
| Questions | `v1.jsonl`, one JSON object per line                                         |
| Source    | `Lecture_3_RAG.pdf` (25 pages), described in `v1.meta.json` with its SHA-256 |
| Size      | 61 questions: 40 factual, 15 multi-part, 6 unanswerable; 73 gold passages    |
| Check it  | `pnpm ingest <the pdf>` then `pnpm eval:validate <the pdf>`                  |

The PDF is not stored in the repository (`data/` is ignored). `v1.meta.json` records its hash, so
`pnpm eval:validate` refuses to run against a different file.

## A question

```json
{
  "id": "q026",
  "question": "By how much did Contextual Retrieval cut top-20 retrieval failures on its own, and combined with reranking?",
  "kind": "factual",
  "answer": "By 49% on its own and by 67% when combined with reranking.",
  "gold": [
    {
      "page": 15,
      "quote": "this cut top-20 retrieval failures by 49%, and by 67% when combined with reranking"
    }
  ]
}
```

| Field      | Meaning                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `id`       | `q001`, `q002`, ... Never reused, never renumbered: results refer to it.                                                         |
| `question` | Written the way a reader would ask it.                                                                                           |
| `kind`     | `factual`: one fact in one place. `multi-part`: several facts, or facts on several pages. `unanswerable`: the book does not say. |
| `answer`   | The reference answer. For an unanswerable question, what a good system should say instead.                                       |
| `gold`     | Where the answer is: a `page` and a `quote` copied from it. Empty for unanswerable questions.                                    |

## Why labels are a page and a quote, not a chunk id

Chunk ids change every time the chunker, its size or its overlap changes, so labels made from them
would be thrown away after each experiment. A page and the words on it do not change.

`resolveGold` (`src/eval/dataset`) finds the quote on its page and returns the character range in
the processed document, `[start, end)`. Retrieval metrics then call a chunk **relevant when its
span overlaps a gold range**, whatever strategy produced the chunk.

## How the questions were written

1. The whole lecture was read once, page by page, as extracted by the project's own pipeline
   (`pnpm ingest`), so the labels refer to the text the system actually sees.
2. **Factual**: one question for a fact worth asking about (a number, a name, a definition, a rule),
   spread over the whole document rather than clustered in the first chapters.
3. **Multi-part**: questions that need two or three facts ("what are the three reasons ...", "how did X
   compare with Y"), including some whose facts sit on different pages. These are the ones that
   punish a small `k` or a chunker that cuts a list in half.
4. **Unanswerable**: questions that sound as if the lecture should answer them (it names LlamaIndex,
   MTEB, cross-encoders, Mata v. Avianca) but that it does not. They test whether a system says "not
   found" instead of inventing something. Each one was checked against the full text.
5. Each answer is a short statement, written from the passage and not from general knowledge.
6. Gold quotes are short, copied exactly, and chosen so that each appears **once** on its page.

## Labelling rules

- A quote is the smallest piece of text that holds the answer, usually a clause or a sentence. A
  list of three items has three quotes, one per item.
- Whitespace in a quote may differ from the PDF (a line break is a space); everything else must be
  identical.
- Tables are quoted from their cells as extracted, which can run rows together. Prose is preferred
  whenever the same fact is also stated in a sentence.
- A quote on a page that also holds a near-identical sentence needs more words, until it is unique.
  `pnpm eval:validate` rejects an ambiguous quote.

## Checks

`pnpm eval:validate <pdf or docId>` verifies, against the ingested book:

- at least 40 questions, all three kinds present, at least 5 unanswerable;
- no repeated id or question;
- the book is the one in `v1.meta.json` (same SHA-256);
- every gold page exists and every quote is found on its page, exactly once.

The unit tests run the shape checks on the committed file without needing the PDF.

## Changing it

Do not edit `v1.jsonl` after results have been recorded against it: scores must stay comparable.
Fix a mistake by adding a note here; add or reword questions by creating `v2.jsonl` and
`v2.meta.json`.

## Growing it from readers' ratings (RAG-106)

The web app lets a reader rate an answer with a thumb and an optional note. The API adds each rating,
with the question, the answer, its sources and its trace, to `evals/candidates.jsonl` (not committed:
it holds real questions). `pnpm eval:promote <pdf or docId>` turns them into the **next version** of
this dataset, `v2.jsonl` beside `v1.jsonl`, and never touches `v1`.

| The reader said              | What happens                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| 👍 on an answer              | A question: the answer is the reference, each cited passage is a gold quote, found once on its page |
| 👍 on "the book has nothing" | An `unanswerable` question                                                                          |
| 👎 on anything               | Not labelled: written to `v2.review.jsonl` with the note, for a person to answer and give gold for  |
| a question already here      | Skipped, with the reason printed; so is a question asked of another book                            |

A promoted question is labelled **by the system's own citations**, so its gold is only as good as the
reader's thumb: read `v2.jsonl` before trusting its scores, and fix what is wrong in `v2` (not `v1`).
A passage that spans two pages, or whose quote is not found exactly once on its page, cannot be a gold
quote; that answer goes to the review file instead. Nothing is written unless the whole new dataset
passes the checks of `pnpm eval:validate`, and an existing version is never overwritten.
