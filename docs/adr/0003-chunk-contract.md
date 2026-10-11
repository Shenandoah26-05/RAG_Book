# ADR-0003: The chunk contract

- **Status**: Accepted
- **Date**: 2026-10-07

## Context

Milestone 2 adds several chunking strategies (fixed-size, sentence, recursive, structure-aware,
parent-child) and M3 adds a semantic one. They are compared against each other on the same questions,
their chunks are cited in answers, and the evaluation (M8) scores them against labelled passages.
That only works if every strategy produces chunks of the same shape, with the same guarantees.

Before any strategy exists we have to decide what a chunk is, what a chunker is allowed to do to the
text, who fills in the metadata, and how we know a chunker is correct. These choices are expensive to
reverse: every chunker, the index and the evaluation will build on them.

## Options

### How does a chunk's `text` relate to the document?

- **Exact slice.** `text` is always `doc.text[charStart, charEnd)`. Simple and verifiable, but a
  chunker cannot trim or tidy a chunk.
- **Whitespace-only changes.** `text` may differ from its passage only in whitespace (trimmed, or
  runs of whitespace collapsed). A chunker has some freedom, and a test can still verify that nothing
  else changed.
- **Any rewriting.** Maximum freedom, but nothing can verify that a chunker preserved the content.

### Who works out page range, section path and id?

- **One shared helper** (`createChunk`) that every chunker calls.
- **Each chunker** does it for itself.

### How strict is coverage?

- **Strict.** Every character that is not whitespace must be inside some chunk.
- **Lenient.** A chunker may drop text it judges useless (boilerplate, tiny tails).

### What shape is the registry?

- **A class** whose factories can build other chunkers, needed by chunkers made of chunkers.
- **A plain map** from name to factory, like the cleaners and loaders.

## Decision

1. **`text` may differ from its source passage only in whitespace.** The span `[charStart, charEnd)`
   is the authority on where a chunk came from. Anything that must find a chunk in the document, such
   as highlighting a citation or scoring overlap, uses the span and never searches for the text.
2. **A shared `createChunk` helper builds every chunk.** A chunker chooses spans and text; the helper
   computes the page range, the section path and the id, and rejects a text that changes more than
   whitespace. The contract test re-checks all of it independently.
3. **Coverage is strict.** Text dropped by a chunker can never be retrieved, so the contract treats
   it as an error. Chunks may overlap but may not leave a gap.
4. **The registry is a class** (`ChunkerRegistry`) whose factories receive a context that can create
   other chunkers by name, with loop detection. It is an instance, never a global.
5. **The contract is a test every chunker runs.** The checks return their violations as data, and
   are themselves tested against deliberately broken chunkers, so the contract is known to catch what
   it claims to catch. A chunker's test file calls `describeChunkerContract`.
6. **`chunk()` returns `Promise<readonly Chunk[]>`.** Async because some strategies call a model.
7. **Deferred: the text that gets embedded.** The board's RAG-025 wants a second text per chunk (the
   section path in front of the passage) for the embedder. We are focusing on chunking first, so the
   `Chunk` type is not changed here. The question returns when embedding becomes the focus; adding an
   optional field then is a small, additive change.

Strategy-specific configuration (child and parent sizes, the semantic threshold) is added when its
ticket needs it, not designed now.

## Consequences

- **Easier**: adding a strategy is one class that calls `createChunk`, one registry line, and one
  `describeChunkerContract` call in its test. Metadata can no longer be subtly wrong in one chunker
  only. Strategies are comparable and the evaluation can rely on spans.
- **Harder**: a chunker cannot rewrite content, only whitespace. Cleaning stays the job of the
  cleaners (RAG-013). Every strategy must cover the whole document, even parts it would rather skip.
- **Obligations**: the UI and the evaluation must work from spans. Sizes are in tokens while spans
  are in characters, so the contract cannot check `maxTokens` until the tokenizer exists (RAG-021);
  RAG-022 must add that check.
- **Known risk, not solved here**: spans point into the cleaned text, and a document's id comes from
  the file hash alone. If the cleaners or the heading detector change, the id stays the same while
  every span moves, so stored chunks and hand-labelled evaluation spans could silently go stale. Decide
  how to handle this before the evaluation dataset (RAG-080).
- **Reversing**: possible but expensive. Relaxing the whitespace rule or the coverage rule means
  changing the contract and re-checking every chunker; it would need a new ADR that supersedes this
  one.

See [docs/design/rag-020-chunker-port.md](../design/rag-020-chunker-port.md) for the full design and
diagrams.
