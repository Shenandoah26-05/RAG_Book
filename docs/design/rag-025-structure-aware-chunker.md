# RAG-025: Structure-aware chunker

One chunk per section, split further only when a section is too long.

## How it works

1. **Cut at section edges.** `sectionSegments` cuts the document wherever a section starts or ends,
   so each piece lies inside exactly one section's own text (its heading and the body before the
   first subsection, or the body after the last one). Pieces cover every non-whitespace character
   once.
2. **Join tiny pieces.** A piece below `minTokens` (default a quarter of `maxTokens`) is joined with
   the next while the result still fits `maxTokens`, so a heading with two lines is not a chunk of
   its own. `minTokens: 0` gives exactly one chunk per section.
3. **Split long pieces.** A piece above `maxTokens` goes to the injected `inner` chunker (normally
   the recursive chunker, RAG-024) as a small document of its own (`documentView`: offsets rebased
   to 0, real page numbers, no sections). The chunks that come back are shifted back onto the real
   document and rebuilt with `createChunk`, so page range, section path and ids are computed once,
   in the same place as for every other strategy.

## Decisions

- **Composition, not copy-paste.** The chunker knows only the section tree. How a long section is
  split is the inner chunker's job, so a better inner chunker improves this one for free. Any
  `Chunker` works, which is also how it is tested here (fixed-size) before RAG-024 is merged.
- **`text` stays raw, `embedText` carries the heading path.** `Chunk.embedText` is optional: absent
  means "embed `text`". When the chunk has a section path it is
  `Chapter 3 > 3.2 Embeddings\n\n<text>`. Citations and the LLM prompt use `text`; only the embedder
  sees the path. The chunk contract is unchanged: it checks `text` and the span, not `embedText`.
- **Tokens come from the `Tokenizer` port**, like fixed-size, so sizes mean the same everywhere.
- **Content before the first heading** (and gaps between sections) becomes its own piece with an
  empty section path and no `embedText`.
- **A document with no sections** is a single piece, so the chunker falls back to the inner chunker.

## Not in this ticket

- Registering the strategy in the `ChunkerRegistry` and reading its options from `rag.config.json`.
  That needs RAG-024 merged, because the config will name the inner chunker.
- Embedding `embedText` instead of `text` (RAG-031 and the indexing pipeline).
