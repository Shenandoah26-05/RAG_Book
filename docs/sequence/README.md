# Sequence diagrams

Two kinds of diagram, written in Mermaid (GitHub and the VS Code Markdown preview draw them).

| Kind                            | File                                   | Answers                                                         |
| ------------------------------- | -------------------------------------- | --------------------------------------------------------------- |
| 1. Pipeline (modules connected) | [00-pipeline.md](00-pipeline.md)       | How M0, M1, M2 and M3 hand data to each other, and what is next |
| 2. Module detail (per function) | [m0-foundations.md](m0-foundations.md) | Config, logger, trace, errors, ids, doctor                      |
|                                 | [m1-ingestion.md](m1-ingestion.md)     | CLI → loaders → cleaners → section detection → store            |
|                                 | [m2-chunking.md](m2-chunking.md)       | Inspector, registry, `createChunk`, every chunking strategy     |
|                                 | [m3-embeddings.md](m3-embeddings.md)   | Ollama embedder, caching decorator, file cache, vector math     |

Every module file starts with a source map and a list of the cases it covers. Each case is its own
diagram, so a failure path (bad input, missing file, server down) is not hidden inside a happy path.

## How to read them

- Participants are named after the real function or class, so you can search the code for them.
- `->>` is a call, `-->>` a return, and `--x` a thrown error (`RagError` code in the message).
- `alt / else` shows the cases of one decision, `loop` a repeat, `par` work that runs concurrently,
  `opt` a step that happens only sometimes.
- "(M2 diagram 14)" style links jump between files.

## Facts worth knowing before you read

- **Built and wired**: `doctor`, `ingest`, `chunks` commands, and the strategies `fixed-size`,
  `recursive` and `structure-aware`.
- **Built, tested, not wired**: `semantic` and `parent-child` chunkers (no line in
  `composition/build-chunkers.ts`), and the whole of M3 (no `buildEmbedder`, no command).
  `pnpm chunks <doc> --strategy semantic` fails with CONFIG_INVALID today.
- **Planned**: M4 (vector store) to M10 are on the Build Board only, so the last diagram of
  [00-pipeline.md](00-pipeline.md) is marked as planned.

## Keeping them true

These were written from the code at commit `c95fca2`. When you change a function that appears in a
diagram, change the diagram in the same PR. Preview with the VS Code Markdown preview, or paste a
block into <https://mermaid.live>.
