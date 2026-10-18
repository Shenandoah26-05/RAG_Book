# RAG-034: Indexing pipeline and index namespaces

One command builds a searchable index for a given chunker and embedder.

```sh
pnpm index                                              # every processed document, config defaults
pnpm index --chunker recursive --embedder ollama:all-minilm
pnpm index <docId | file.pdf> --chunker fixed-size --force
pnpm index --chunking.max-tokens 200 --index-dir data/experiments
```

The index goes to `data/index/<chunker>__<embedder>/` (`recursive__ollama-all-minilm`: the `:` is
replaced by `-` because Windows file names cannot hold it). Several variants sit side by side.

## How it works

```
DocumentStore.load(id)            data/processed/<docId>.json   (from pnpm ingest)
  │
  ▼  Chunker.chunk (+ parents)    the strategy chosen by --chunker
  │
  ▼  Embedder.embed(…, "document") CachingEmbedder(OllamaEmbedder), in batches of embedding.batchSize
  │
  ▼  VectorStore.upsert + ChunkStore.put      fresh in-memory stores: validate and count
  │
  ▼  IndexWriter.write            data/index/<namespace>/
        manifest.json   what built it
        chunks.jsonl    {"indexed": bool, "chunk": {...}} per line
        vectors.bin     raw float32, one row per indexed line
```

| Layer       | File                                                                             | Job                                                                                  |
| ----------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| core        | `types/index-manifest.ts`, `ports/index-writer.ts`                               | The manifest shape and the `IndexWriter` port                                        |
| pipeline    | `build-index.ts`, `index-namespace.ts`                                           | The orchestration, ports only; the namespace name                                    |
| adapters    | `index-writers/file-index-writer.ts`                                             | The folder format, written atomically                                                |
| adapters    | `document-stores/file-document-store.ts`                                         | New `list()`: ids of every processed document                                        |
| composition | `build-indexer.ts`, `build-embedder.ts`, `resolve-doc-id.ts`, `index-summary.ts` | Config, chunker, embedder + cache, stores, git commit; the only wiring               |
| cli         | `index-args.ts`, `index-docs.ts`                                                 | `pnpm index` (`cli/index.ts` is the barrel, so the entry point is named differently) |

## Decisions

| #   | Question                          | Chosen                                                                                                                                                                                                                                                                  |
| --- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Format, while RAG-042 is not done | A minimal folder written by a `FileIndexWriter` adapter: `vectors.bin` (raw float32), `chunks.jsonl`, `manifest.json`. No ids are stored with the vectors: row _n_ belongs to the _n_-th line with `indexed: true`. RAG-042 adds loading and validation on this format. |
| D2  | Idempotence                       | The manifest holds a **fingerprint**: SHA-256 of the chunker (name, tokenizer, sizes), the embedder (id, dimensions) and the sorted document ids. Same fingerprint, no work. `--force` rebuilds. The folder is always replaced whole, never patched.                    |
| D3  | What is indexed                   | Documents named on the command line (ids or PDFs), else every document in `data/processed`. Parents of a small-to-big chunker are stored in `chunks.jsonl` (`indexed: false`) and in the ChunkStore, never given a vector.                                              |
| D4  | All or nothing                    | The folder is built as `<namespace>.<pid>.tmp`, manifest last, then renamed into place. A crash leaves the old index or the new one. A manifest's presence means a complete index.                                                                                      |
| D5  | Provenance                        | The manifest records `configHash` (`hashConfig` of the config **as actually used**, including `--chunker` and `--embedder`), the git commit (`null` outside a repository), counts, per-step timings and the time.                                                       |
| D6  | Embedders                         | `provider:model` names. Only `ollama:all-minilm` is known (its vector length is needed up front); another model is one line in `build-embedder.ts`. Every embedder is wrapped in the `CachingEmbedder` over `data/cache/embeddings`.                                    |
| D7  | Embedded text                     | `chunk.embedText ?? chunk.text`, kind `"document"`.                                                                                                                                                                                                                     |

## Notes

- A re-run with a different chunker or embedder is a different namespace, so it never touches an
  existing index.
- The fingerprint does not cover code. After changing a chunker or cleaner, run `--force` (and
  `pnpm ingest --force` for cleaners). A forced rebuild is cheap: the embedding cache answers every
  text it has seen, so Ollama is not called again.
- `timingsMs` in the manifest covers `chunk`, `embed`, `store` and `total` of those; the time spent
  writing happens after the manifest is built and is only logged.
- `FlatVectorStore` and `InMemoryChunkStore` are used as validators here (dimension, NaN and
  duplicate-id checks, counts that must match). The writer receives the records themselves, because
  the `VectorStore` port deliberately has no way to list its contents.
- `resolveDocId` moved out of `build-inspect.ts` so `pnpm chunks` and `pnpm index` share it.
- `DocumentStore` gained `list()`.

## Not in this ticket

Loading an index back, with checks for corrupt files and mismatched dimensions (RAG-042), searching
it (RAG-050), more embedder models, and the sentence, paragraph, semantic and parent-child chunkers,
which appear in `--chunker` when their PRs register them in `build-chunkers.ts`.
