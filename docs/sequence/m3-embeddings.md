# M3 Embeddings: function-level sequence diagrams

Back to the [pipeline view](00-pipeline.md). M3 turns text into unit-length vectors behind one
`Embedder` port, caches them, and provides hand-written vector math.

Source map

| Area        | Files                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------- |
| Port        | `core/ports/embedder.ts` (`Embedder`, `EmbedKind`)                                                 |
| Adapters    | `adapters/embedders/ollama-embedder.ts`, `caching-embedder.ts`, `file-embedding-cache.ts`          |
| Math        | `strategies/ranking/vector-math.ts` (`dot`, `norm`, `normalise`, `cosine`, `euclidean`)            |
| Consumer    | `strategies/chunking/semantic-chunker.ts` (see [M2 diagram 14](m2-chunking.md#14-semanticchunker)) |
| Test helper | `testing/embedder-contract.testing.ts`, `scripts/bench-similarity.ts`                              |

> **Status.** There is no command and no `buildEmbedder` in `composition/` yet, so these classes
> are exercised by tests and by the semantic chunker's constructor. The "production" stack shown
> below (`CachingEmbedder` around `OllamaEmbedder`, with `FileEmbeddingCache`) is how they are
> designed to be assembled.

Cases covered: [1 Assembly](#1-assembling-the-embedder-stack) · [2 OllamaEmbedder constructor](#2-ollamaembedder-constructor) ·
[3 OllamaEmbedder.embed](#3-ollamaembedderembed-batches-and-normalising) · [4 HTTP retry logic](#4-ollamaembedder-post-and-tryonce-retry-logic) ·
[5 CachingEmbedder.embed](#5-cachingembedderembed) · [6 Cache failure cases](#6-cachingembedder-cache-failure-cases) ·
[7 Cache key](#7-embeddingcachekey) · [8 FileEmbeddingCache](#8-fileembeddingcache) · [9 Vector math](#9-vector-math) ·
[10 Embedder contract](#10-the-embedder-contract-test) · [11 Similarity benchmark](#11-pnpm-benchsimilarity)

---

## 1. Assembling the embedder stack

The decorator pattern: callers see an ordinary `Embedder`, the wrapped one does not know it is cached.

```mermaid
sequenceDiagram
  autonumber
  participant Comp as composition root (future buildEmbedder)
  participant Cfg as RagConfig.embedding
  participant NH as normalizeOllamaHost
  participant OE as OllamaEmbedder
  participant FC as FileEmbeddingCache
  participant CE as CachingEmbedder
  participant Use as consumer (SemanticChunker, M4 indexer)

  Comp->>Cfg: provider "ollama", model "all-minilm", batchSize 32
  Comp->>NH: normalizeOllamaHost(env.OLLAMA_HOST)
  NH-->>Comp: address
  Comp->>OE: new OllamaEmbedder({ address, model, dimensions: 384, batchSize })
  Comp->>FC: new FileEmbeddingCache("data/cache/embeddings")
  Comp->>CE: new CachingEmbedder(OE, FC, logger)
  Comp-->>Use: Embedder (modelId and dimensions are forwarded from the inner embedder)
  Use->>CE: embed(texts, kind)
```

## 2. `OllamaEmbedder` constructor

```mermaid
sequenceDiagram
  autonumber
  participant Comp as composition root
  participant OE as OllamaEmbedder constructor
  participant PI as positiveInt

  Comp->>OE: new OllamaEmbedder(options)
  OE->>OE: defaults: batchSize 32, timeoutMs 30000, maxRetries 3, retryDelayMs 250
  OE->>PI: dimensions at least 1, batchSize at least 1, timeoutMs at least 1, maxRetries at least 0, retryDelayMs at least 0
  alt any value is not a whole number in range
    PI--xOE: RagError CONFIG_INVALID "OllamaEmbedder: name must be a whole number of N or more"
    OE--xComp: throw
  else
    OE->>OE: modelId = "ollama:" + model, fetch = options.fetch or global fetch, sleep = options.sleep or setTimeout
    OE-->>Comp: OllamaEmbedder
  end
```

## 3. `OllamaEmbedder.embed`: batches and normalising

```mermaid
sequenceDiagram
  autonumber
  participant Use as caller
  participant OE as OllamaEmbedder.embed
  participant EB as #embedBatch
  participant PO as #post
  participant Z as embedResponse (zod)
  participant UV as #toUnitVector

  Use->>OE: embed(texts, kind)
  Note right of OE: kind is ignored, all-minilm treats queries and passages alike
  alt texts is empty
    OE-->>Use: [] (no request is made)
  else
    loop start = 0, batchSize, 2*batchSize ... (one request at a time)
      OE->>EB: #embedBatch(batch)
      EB->>PO: #post(batch)
      PO-->>EB: parsed JSON body (see diagram 4)
      EB->>Z: safeParse(body)
      alt shape is not { embeddings: number[][] }
        Z-->>EB: failure
        EB--xUse: RagError PROVIDER_UNAVAILABLE "did not answer like Ollama's /api/embed"
      else
        Z-->>EB: embeddings
        alt embeddings.length differs from batch.length
          EB--xUse: RagError PROVIDER_UNAVAILABLE "returned N vectors for M texts"
        else
          loop each vector
            EB->>UV: #toUnitVector(values)
            alt length differs from dimensions
              UV--xUse: RagError CONFIG_INVALID "returned vectors of length X, but dimensions is Y"
            else length is 0, NaN or infinite
              UV--xUse: RagError PROVIDER_UNAVAILABLE "cannot be normalised"
            else
              UV->>UV: Float32Array, divide each value by the L2 length
              UV-->>EB: unit vector
            end
          end
        end
      end
      EB-->>OE: vectors for this batch
    end
    OE-->>Use: one Float32Array per text, in input order
  end
```

## 4. `OllamaEmbedder` `#post` and `#tryOnce` (retry logic)

Network errors, 5xx and 429 are retried with a doubling wait. Other errors fail at once.

```mermaid
sequenceDiagram
  autonumber
  participant PO as #post
  participant TO as #tryOnce
  participant F as fetch POST /api/embed
  participant SL as sleep

  loop attempt = 0, 1, 2 ... (up to maxRetries extra tries)
    PO->>TO: #tryOnce(url, batch)
    TO->>F: POST { model, input: batch }, timeout signal
    alt network error or timeout
      F--xTO: throws
      TO-->>PO: { ok: false, retry: true, PROVIDER_UNAVAILABLE "Cannot reach Ollama" }
    else status 404
      F-->>TO: Response
      TO->>TO: errorDetail(response) reads { error } or statusText
      TO-->>PO: { ok: false, retry: false, PROVIDER_UNAVAILABLE 'has no model "X". Run: ollama pull X' }
    else status 5xx or 429
      F-->>TO: Response
      TO-->>PO: { ok: false, retry: true, PROVIDER_UNAVAILABLE "answered with HTTP N" }
    else other non-OK status (400 ...)
      F-->>TO: Response
      TO-->>PO: { ok: false, retry: false, PROVIDER_UNAVAILABLE "answered with HTTP N" }
    else 200 but body is not JSON
      F-->>TO: Response
      TO-->>PO: { ok: false, retry: false, PROVIDER_UNAVAILABLE "(not JSON)" }
    else 200 with JSON
      F-->>TO: Response
      TO-->>PO: { ok: true, body }
    end
    alt ok
      PO-->>PO: return body
    else not retryable, or attempt reached maxRetries
      PO--xPO: throw the RagError
    else retryable
      PO->>SL: sleep(retryDelayMs * 2 ** attempt)  (250, 500, 1000 ms by default)
    end
  end
```

## 5. `CachingEmbedder.embed`

Only texts that were never seen go to the wrapped embedder, in one call. Duplicates are embedded once.

```mermaid
sequenceDiagram
  autonumber
  participant Use as caller
  participant CE as CachingEmbedder.embed
  participant K as embeddingCacheKey
  participant LK as #lookup
  participant C as EmbeddingCache
  participant IN as inner Embedder
  participant ST as #store
  participant Log as Logger

  Use->>CE: embed(texts, kind)
  alt texts is empty
    CE-->>Use: []
  else
    CE->>CE: found = Map of distinct texts (a repeated text is looked up once)
    par for each distinct text
      CE->>K: embeddingCacheKey(modelId, kind, text)
      K-->>CE: SHA-256 hex
      CE->>LK: #lookup(key)
      LK->>C: get(key)
      C-->>LK: vector or undefined
      LK-->>CE: vector if its length equals dimensions, otherwise undefined
    end
    CE->>CE: missing = texts with no cached vector
    opt missing is not empty
      CE->>IN: embed(missing, kind)  (one call for all misses)
      IN-->>CE: vectors
      alt vector count differs from missing count
        CE--xUse: RagError INTERNAL "returned N vectors for M texts"
      else
        par for each missing text
          CE->>ST: #store(key, vector)
          ST->>C: set(key, vector)
        end
      end
    end
    CE->>Log: info("embedding cache", { model, kind, hits, misses })
    CE-->>Use: texts.map(found.get) in the original order, duplicates included
  end
```

## 6. `CachingEmbedder` cache failure cases

The cache is an optimisation, never a source of truth.

```mermaid
sequenceDiagram
  autonumber
  participant CE as CachingEmbedder
  participant C as EmbeddingCache
  participant IN as inner Embedder
  participant Log as Logger

  Note over CE,Log: Case A. Cache read throws (disk error, bad key)
  CE->>C: get(key)
  C--xCE: error
  CE->>Log: warn("embedding cache read failed", { key, error })
  CE->>CE: treat as a miss
  CE->>IN: embed(this text with the other misses)

  Note over CE,Log: Case B. Cached vector has the wrong length (model dimension changed, damaged entry)
  CE->>C: get(key)
  C-->>CE: Float32Array of wrong length
  CE->>CE: treated as missing
  CE->>IN: embed(text)
  IN-->>CE: vector
  CE->>C: set(key, vector) replaces the bad entry

  Note over CE,Log: Case C. Cache write throws
  CE->>C: set(key, vector)
  C--xCE: error
  CE->>Log: warn("embedding cache write failed", { key, error })
  Note right of CE: the vector is still returned to the caller

  Note over CE,Log: Case D. Inner embedder fails
  CE->>IN: embed(missing, kind)
  IN--xCE: RagError (PROVIDER_UNAVAILABLE, CONFIG_INVALID ...)
  Note right of CE: propagates unchanged, nothing is cached for this call
```

## 7. `embeddingCacheKey`

```mermaid
sequenceDiagram
  autonumber
  participant CE as CachingEmbedder
  participant K as embeddingCacheKey
  participant CH as contentHash (core/types/ids.ts)

  CE->>K: embeddingCacheKey("ollama:all-minilm", "document", text)
  K->>CH: contentHash("embedding", modelId, kind, text)
  CH->>CH: for each part: hash.update("<length>:<part>|")
  CH-->>K: SHA-256 hex (64 characters)
  K-->>CE: key
  Note over K: length prefixes keep ("ab","c") and ("a","bc") apart<br/>a different model or kind always gives a different key,<br/>so another model's vector is never returned
```

## 8. `FileEmbeddingCache`

One raw float file per vector at `folder/<first 2 hex>/<key>.bin`.

```mermaid
sequenceDiagram
  autonumber
  participant CE as CachingEmbedder
  participant FC as FileEmbeddingCache
  participant LO as locationOf
  participant FS as node:fs/promises

  Note over CE,FS: get(key)
  CE->>FC: get(key)
  FC->>LO: locationOf(key)
  alt key is not 64 lower-case hex characters
    LO--xFC: RagError INVALID_ARGUMENT "Not an embedding cache key" (blocks "../x")
    FC--xCE: throw (the decorator logs it and treats it as a miss)
  else
    LO-->>FC: folder/ab/abcdef....bin
  end
  FC->>FS: readFile(path)
  alt ENOENT
    FS--xFC: not found
    FC-->>CE: undefined
  else other read error
    FS--xFC: error
    FC--xCE: rethrow
  else bytes empty or not a multiple of 4
    FS-->>FC: Buffer
    FC-->>CE: undefined (damaged, will be replaced)
  else
    FS-->>FC: Buffer
    FC->>FC: copy into a fresh Uint8Array so the Float32Array is aligned
    FC-->>CE: Float32Array
  end

  Note over CE,FS: set(key, vector)
  CE->>FC: set(key, vector)
  FC->>LO: locationOf(key)
  FC->>FS: mkdir(dirname, recursive)
  FC->>FS: writeFile(path.pid.tmp, raw float bytes)
  FC->>FS: rename(tmp, path)
  alt write or rename fails
    FS--xFC: error
    FC->>FS: rm(tmp, force)
    FC--xCE: rethrow (the real entry is never half-written)
  else
    FC-->>CE: done
  end
```

## 9. Vector math

Hand-written on purpose. For unit-length vectors `cosine(a, b)` equals `dot(a, b)`.

```mermaid
sequenceDiagram
  autonumber
  participant Use as semantic breakpoints, M4 search (later), benchmark
  participant CO as cosine
  participant AS as assertSameLength
  participant DT as dot
  participant NR as norm
  participant NM as normalise
  participant EU as euclidean

  Use->>CO: cosine(a, b)
  CO->>AS: assertSameLength("cosine", a, b)
  alt lengths differ
    AS--xCO: RagError INVALID_ARGUMENT
  end
  CO->>NR: norm(a) and norm(b)
  NR->>DT: dot(v, v)
  DT-->>NR: sum of squares (accumulated in a 64-bit number)
  NR-->>CO: sqrt
  alt either length is 0
    CO-->>Use: 0 (no NaN)
  else
    CO->>DT: dot(a, b)
    DT-->>CO: sum of a[i] * b[i]
    CO-->>Use: dot / (norm a * norm b), from -1 to 1
  end

  Use->>NM: normalise(a)
  NM->>NR: norm(a)
  alt length is 0
    NM-->>Use: copy of the zero vector (no division by zero)
  else
    NM-->>Use: new vector a[i] / length (input untouched)
  end

  Use->>EU: euclidean(a, b)
  EU->>AS: assertSameLength
  EU-->>Use: sqrt of the sum of squared differences
```

## 10. The embedder contract test

```mermaid
sequenceDiagram
  autonumber
  participant T as an embedder's test file
  participant D as describeEmbedderContract
  participant CK as checkEmbedder
  participant EM as Embedder under test

  T->>D: describeEmbedderContract(name, () => embedder)
  D->>D: modelId is not empty and dimensions is above 0
  loop kind = "query", then "document"
    D->>CK: checkEmbedder(embedder, kind) with 3 distinct fixture texts
    CK->>EM: embed([], kind)
    EM-->>CK: must be [] (else nonempty-for-empty)
    CK->>EM: embed(texts, kind)
    EM-->>CK: vectors
    CK->>CK: wrong-count stops the checks, then per vector: wrong-dimensions, non-finite, not-normalised (length 1 within 1e-4)
    loop each text
      CK->>EM: embed([text], kind)
      EM-->>CK: must equal the vector from the batch (else not-in-order)
    end
    CK->>EM: embed(texts, kind) again
    EM-->>CK: must be identical (else not-deterministic)
    CK-->>D: violations
    D->>D: expect no violations
  end
  Note over D,EM: Run against OllamaEmbedder (with a fake fetch), CachingEmbedder and any future embedder
```

## 11. `pnpm bench:similarity`

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant B as scripts/bench-similarity.ts
  participant NM as normalise
  participant CO as cosine
  participant DT as dot

  User->>B: pnpm bench:similarity (VECTORS, DIMENSIONS env vars optional)
  B->>B: seeded mulberry32 random numbers
  loop VECTORS random vectors and one query
    B->>NM: normalise(random vector)
  end
  B->>CO: rank corpus by cosine(query, v), take top 10
  B->>DT: rank corpus by dot(query, v), take top 10
  B->>B: sameRanking = both top-10 lists identical
  loop 5 rounds
    B->>CO: time scoring the whole corpus (keep the best)
    B->>DT: time scoring the whole corpus (keep the best)
  end
  B-->>User: best times, speed-up, and whether the top 10 are identical (exit code 1 if not)
```
