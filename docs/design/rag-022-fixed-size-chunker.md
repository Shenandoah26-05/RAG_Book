# RAG-022 design: Fixed-size chunker with overlap

**Ticket:** M2, feature, 2 points. Depends on RAG-020 (chunker port, contract) and RAG-021 (tokenizer).
**Role:** the control group in every A/B test, so it is deliberately simple.

## Algorithm

A window of `size` tokens slides over `doc.text`, moving `size - overlap` tokens at a time. Each
window becomes a character span, and `createChunk` (RAG-020) fills in pages, section path and id.

- The constructor rejects a size that is not a whole number of 1 or more, an overlap that is
  negative or not whole, and `overlap >= size` (all `CONFIG_INVALID`).
- The step is always 1 or more, so the loop ends. It also stops at the first window that reaches the
  end, so no final window sits entirely inside the previous one.
- A window of only whitespace is skipped. That drops no text, and `createChunk` rejects such spans.
- `text` is the exact passage. Edges may cut a word, because the baseline has no sentence logic.

```mermaid
flowchart LR
  T["Tokenizer.tokenSpans(doc.text)"] --> W["windows of size, step size - overlap"]
  W --> S["char span per window"]
  S --> C["createChunk()"]
  C --> K["Chunk list"]
```

## Open point: tokens versus characters

Windows are in tokens; chunk spans are in characters. The chunker therefore needs each token's
character range. The commits here use a `tokenSpans(text)` method on `Tokenizer` as a stand-in.

**RAG-021 (`feat/tokenizer`) shipped without it**: its port has `name`, `count` and `encode` only.
Before this merges, one of these must happen:

1. Add `tokenSpans` to the 021 port and both implementations (recommended; the approx one is trivial).
2. Derive spans inside the chunker from `encode` and a decode step (slow, fiddly with multi-byte text).
3. Window in characters and use `count` only to size the window (not faithful to "size in tokens").

The first commit on this branch (the Tokenizer stub and test tokenizers) is replaced when this is
settled.

## Tests

Constructor rules; empty, whitespace-only, shorter-than-one-window and exact-multiple documents;
sliding arithmetic; the largest overlap; windows in tokens, not characters; whitespace windows;
determinism; and the shared chunker contract on four configurations.

## Not in this ticket

Registering `fixed-size` in the chunker registry (waits for the tokenizer in the composition root),
and the chunk inspector (RAG-028).
