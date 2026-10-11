# RAG-028: Chunk inspector

See what a chunking strategy actually produced before trusting it.

```sh
pnpm chunks data/raw/book.pdf --strategy recursive      # or a document id instead of the PDF
pnpm chunks <docId> --strategy fixed-size --samples 5 --seed 42
pnpm chunks <docId> --chunking.max-tokens 200 --chunking.overlap-tokens 20
```

It prints the chunk count, a token-size histogram and 3 sample chunks, and writes every chunk to
`data/processed/<docId>.<strategy>.chunks.md`. It never ingests: the document must already be in
`data/processed` (the message says `pnpm ingest` if it is not).

## Where the code lives

| Layer       | File                                  | Job                                                                |
| ----------- | ------------------------------------- | ------------------------------------------------------------------ |
| strategies  | `strategies/chunking/chunk-stats.ts`  | `summarizeChunks`: count, min/mean/median/max, histogram. Pure.    |
| strategies  | `strategies/chunking/chunk-report.ts` | `sampleChunks` (seeded), text histogram, the markdown report. Pure |
| composition | `composition/build-chunkers.ts`       | The registry with every strategy (the first place one is built)    |
| composition | `composition/build-inspect.ts`        | Config, tokenizer, store; resolve target, chunk, report, write     |
| composition | `composition/inspect-summary.ts`      | The text `pnpm chunks` prints                                      |
| cli         | `cli/chunks-args.ts`, `cli/chunks.ts` | Parse the command line, print, set the exit code                   |

The pure code is in `strategies/` because the layer rules (`deps:check`) let only `composition/`
touch it, and the I/O (reading the store, writing the file) is in `composition/` for the same
reason. Nothing here needs a new port.

## Decisions

- **Registering the strategies.** Nothing built a `ChunkerRegistry` yet, so `--strategy` had nothing
  to look names up in. `buildChunkerRegistry(tokenizer)` registers `fixed-size`, `recursive` and
  `structure-aware`, all measuring with the tokenizer from `chunking.tokenizer`. A new strategy is one
  class and one `register` call there.
- **`--strategy` or the config.** Without `--strategy` the config's `chunking.strategy` is used.
  Sizes and the tokenizer always come from the config, so `--chunking.max-tokens 200` works as in
  `pnpm ingest`.
- **Target is an id or a PDF.** An id is used as it is. Anything else must be an existing file, and
  its id is worked out from its hash, as in ingest. Anything else is an `INVALID_ARGUMENT` error.
- **Samples repeat.** "Random" is a seeded pick (default seed: hash of `docId|strategy`), so two
  runs print the same chunks and a report can be compared with an earlier one. `--seed` shows others.
- **Sizes are of `chunk.text`**, counted with the config tokenizer, not `embedText`.
- **Histogram.** Equal-width buckets from the smallest to the biggest chunk, at most 8, never
  narrower than one token, drawn with `█` bars.
- **The file lists every chunk,** in order, with its size, pages, section path, character span, id
  and `embedText` when the strategy sets one. The text is in a code fence long enough to survive
  backticks in the chunk.

## Fixed in passing: the tokenizer port

`main` did not type-check: the `Tokenizer` port had `tokenSpans` (needed by `fixed-size`, RAG-022)
but not `name`, and the two real tokenizers (RAG-021) had `name` but not `tokenSpans`. The port now
has both, `ApproxTokenizer` returns its 4-character windows and `TiktokenTokenizer` decodes token by
token (a character split across several tokens belongs to the first; the rest get an empty span
after it), and the shared tokenizer contract test checks the spans. This was needed because
`fixed-size` could not run on a real tokenizer without it.

## Not in this ticket

- Chunker settings beyond `maxTokens` and `overlapTokens` (structure-aware `minTokens`, recursive
  separators), and the sentence, paragraph, semantic and parent-child chunkers, which register
  themselves in `build-chunkers.ts` when they are merged.
- Comparing two strategies side by side (that is the A/B work in M4 and later).
