# Pipeline sequence diagrams: M0 → M1 → M2 → M3

How the four finished milestones connect. Each diagram shows **who hands what to whom**. The
function-level detail of every box lives in the per-module files:
[M0](m0-foundations.md) · [M1](m1-ingestion.md) · [M2](m2-chunking.md) · [M3](m3-embeddings.md).

| Milestone | Name        | What it hands to the next one                                    |
| --------- | ----------- | ---------------------------------------------------------------- |
| M0        | Foundations | `RagConfig`, `Logger`, `Trace`, `RagError`, ids, ports and types |
| M1        | Ingestion   | `ParsedDocument` (clean text, pages, sections) stored as JSON    |
| M2        | Chunking    | `Chunk[]` (text, page range, section path, char span, id)        |
| M3        | Embeddings  | `Float32Array[]` (unit-length vectors) and vector math           |

## 1. The whole pipeline, as it runs today

Three commands exist today (`doctor`, `ingest`, `chunks`). M3 has no command yet: it is a library
that the semantic chunker (an M2 strategy) already calls, and that M4 will call to index chunks.

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant M0 as M0 Foundations<br/>config, logger, trace, errors, ids
  participant M1 as M1 Ingestion<br/>pipeline/ingest.ts
  participant Disk as data/processed/<br/>docId.json
  participant M2 as M2 Chunking<br/>composition/build-inspect.ts
  participant M3 as M3 Embeddings<br/>Embedder port
  participant Ollama as Ollama server

  rect rgb(235, 245, 255)
    Note over User,Ollama: Step 0. Check the environment (pnpm run doctor)
    User->>M0: doctor
    M0->>Ollama: GET /api/tags
    Ollama-->>M0: installed models
    M0-->>User: report, all-minilm and llama3.2 present or a fix hint
  end

  rect rgb(240, 255, 240)
    Note over User,Disk: Step 1. Ingest the book (pnpm ingest book.pdf)
    User->>M1: ingest(file)
    M1->>M0: loadConfig, makeDocId(sha256), Trace, Logger
    M0-->>M1: RagConfig, docId
    M1->>M1: load, clean, detect sections
    M1->>Disk: save ParsedDocument
    M1-->>User: ingested or skipped, pages, sections
  end

  rect rgb(255, 250, 235)
    Note over User,Disk: Step 2. Chunk it (pnpm chunks book.pdf)
    User->>M2: chunks(target)
    M2->>M0: loadConfig, makeDocId, isDocId
    M2->>Disk: load ParsedDocument
    Disk-->>M2: ParsedDocument
    M2->>M2: Chunker.chunk(doc) gives Chunk[]
    M2->>Disk: write docId.strategy.chunks.md
    M2-->>User: stats, histogram, samples
  end

  rect rgb(255, 240, 245)
    Note over M2,Ollama: Step 3. Embeddings (library today, used by the semantic chunker)
    M2->>M3: embed(sentences or chunks, kind)
    M3->>Ollama: POST /api/embed
    Ollama-->>M3: vectors
    M3-->>M2: unit-length Float32Array[]
  end
```

## 2. Start-up wiring: how M0 feeds every other module

Nothing in `pipeline/` or `strategies/` reads files or environment variables. Each command goes
through one **composition root**, which turns M0's config into concrete objects (ADR-0001).

```mermaid
sequenceDiagram
  autonumber
  participant CLI as cli/*.ts
  participant Comp as composition/build-*.ts
  participant Cfg as M0 config/load-config.ts
  participant Reg as composition/registries.ts<br/>and build-chunkers.ts
  participant Adp as adapters and strategies<br/>(M1, M2, M3 classes)
  participant Pipe as pipeline/ or Inspector

  CLI->>Comp: buildDoctor, buildIngest or buildInspect (argv, env)
  Comp->>Cfg: loadConfig(argv, env)
  Cfg-->>Comp: frozen RagConfig (defaults + file + env + flags, zod-checked)
  Comp->>Reg: buildLoader, buildCleaner, buildTokenizer, buildChunkerRegistry
  Reg->>Adp: new PdfJsLoader, CleaningChain, ApproxTokenizer, RecursiveChunker ...
  Adp-->>Reg: ready objects behind ports
  Reg-->>Comp: ports, never concrete types
  Comp->>Adp: new FileDocumentStore, FontHeadingDetector, OllamaHost
  Comp-->>CLI: Ingester, Inspector or Doctor (run function)
  CLI->>Pipe: run(...)
  Note over Comp,Pipe: Unknown names fail here with CONFIG_INVALID,<br/>before any file is read or any model is called
```

## 3. Data hand-off between milestones

The same flow seen from the data's side: what exists after each stage and who owns it.

```mermaid
sequenceDiagram
  autonumber
  participant PDF as book.pdf
  participant M1 as M1 Ingestion
  participant Store as FileDocumentStore
  participant M2 as M2 Chunking
  participant M3 as M3 Embeddings

  PDF->>M1: bytes, SHA-256
  Note right of M1: docId = UUIDv5(sha256)<br/>same file gives same id
  M1->>M1: RAW ParsedDocument (pages, text items, no sections)
  M1->>M1: CLEAN ParsedDocument (same shape, edited text and spans)
  M1->>M1: STRUCTURED ParsedDocument (sections tree filled in)
  M1->>Store: save as version 2 JSON
  Store-->>M2: load(docId) returns ParsedDocument
  Note right of M2: Chunk = text + embedText? + parentId?<br/>+ metadata (pages, sectionPath, charStart/End, strategy)
  M2->>M2: Chunk[] in document order, spans cover all text
  M2->>M3: texts to embed (chunk.embedText ?? chunk.text, or sentences)
  M3->>M3: cache lookup by SHA-256(model, kind, text)
  M3->>M3: embed misses in batches, normalise to length 1
  M3-->>M2: Float32Array[384] per text, same order
  Note over M3: Vector math (dot, cosine, norm) lives in strategies/ranking<br/>and is what M2 semantic breakpoints and M4 search will use
```

## 4. The one place M2 and M3 touch: semantic chunking

`SemanticChunker` is an M2 strategy that needs an M3 `Embedder`. It receives the port through its
constructor, so `strategies/chunking` never imports `adapters/embedders` (rule 2 in
[architecture.md](../architecture.md)).

```mermaid
sequenceDiagram
  autonumber
  participant Caller
  participant SC as SemanticChunker (M2)
  participant Emb as Embedder port (M3)
  participant Cache as CachingEmbedder (M3)
  participant Ollama as OllamaEmbedder (M3)
  participant VM as vector-math.cosine (M3)
  participant CB as createChunk (M2)

  Caller->>SC: chunk(doc)
  SC->>SC: splitSentences(doc.text) gives spans
  SC->>Emb: embed(sentenceTexts, "document")
  Note over Emb,Cache: In production Emb is a CachingEmbedder wrapping an OllamaEmbedder
  Emb->>Cache: embed(...)
  Cache->>Ollama: embed(missing texts only)
  Ollama-->>Cache: unit vectors
  Cache-->>SC: vectors in input order
  SC->>VM: neighbourSimilarities(vectors) via cosine
  VM-->>SC: n-1 similarities
  SC->>SC: findBreakpoints(similarities, breakRule)
  loop each sentence
    SC->>SC: close chunk at topic shift or when maxTokens would be exceeded
    SC->>CB: createChunk(doc, "semantic", span)
  end
  SC-->>Caller: Chunk[]
```

> **Not wired yet.** `build-chunkers.ts` registers only `fixed-size`, `recursive` and
> `structure-aware`. `semantic` and `parent-child` exist as classes with tests but have no
> registry line, and no `buildEmbedder` exists yet. So `chunking.strategy = "semantic"` is
> rejected with CONFIG_INVALID today.

## 5. Where the pipeline goes next (planned, not built)

M4 onward is on the Build Board only. This shows where it plugs into what exists.

```mermaid
sequenceDiagram
  autonumber
  participant M2 as M2 Chunks
  participant M3 as M3 Embedder
  participant M4 as M4 Vector store
  participant M5 as M5 Retrieval
  participant M6 as M6 Rerank
  participant M7 as M7 Generation

  Note over M2,M4: Indexing (offline)
  M2->>M3: chunks (embedText or text)
  M3-->>M4: vectors + chunk ids
  M4->>M4: persist index under index namespace
  Note over M4,M7: Query (online)
  M5->>M3: embed(question, "query")
  M3-->>M5: query vector
  M5->>M4: search(vector, k, filter)
  M4-->>M5: nearest chunks
  M5->>M6: candidates (optional, feature flag)
  M6->>M7: ordered context within token budget
  M7-->>M7: answer with page citations from chunk metadata
```
