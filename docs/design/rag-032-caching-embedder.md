# RAG-032: Caching embedder (decorator)

Never embed the same text with the same model twice.

## How it works

```
CachingEmbedder (is an Embedder)
  embed(texts, kind)
    1. key = sha256(model, kind, text) for each distinct text
    2. look the keys up in the EmbeddingCache
    3. send only the misses to the wrapped Embedder, in one call
    4. store the new vectors; return everything in the original order
    5. log { model, kind, hits, misses } once per call
        │
        ▼
EmbeddingCache (get / set)
  ├─ FileEmbeddingCache   <folder>/<2 hex>/<key>.bin   raw float32
  └─ a Map in tests
```

The wrapped embedder does not know it is cached, and callers see an ordinary `Embedder`
(`modelId` and `dimensions` pass through). The decorator runs the shared embedder contract.

## Decisions

| #   | Question                         | Chosen                                                                                                                                                                                      |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Where do vectors live on disk?   | One raw `.bin` file per key, in a sub-folder named after the key's first two characters (approved). No parsing, no shared file to rewrite, atomic write by temp file and rename.            |
| D2  | Where does the folder come from? | A constructor argument only (approved). The composition root will pass `data/cache/embeddings`; no config key yet.                                                                          |
| D3  | Cache key                        | `contentHash("embedding", modelId, kind, text)`: SHA-256 with length-prefixed parts, so ("ab", "c") and ("a", "bc") differ. The model and the kind (query or document) are part of the key. |
| D4  | Storage vs decorator             | The decorator depends on a two-method `EmbeddingCache` interface, so it is tested without a disk and storage can change.                                                                    |
| D5  | Repeated texts in one call       | Embedded once and returned in every position.                                                                                                                                               |
| D6  | A broken cache                   | The cache is an optimisation: a read or write error is logged as a warning and skipped. A cached vector of the wrong length is replaced.                                                    |
| D7  | What counts as a hit             | `hits = texts − misses`, `misses = distinct texts sent to the model`.                                                                                                                       |

## Notes

- The file cache only accepts 64-character hex keys, so a key can never become a path outside its folder.
- A damaged file (not a whole number of floats) reads as missing and is overwritten.
- `data/` is already git-ignored.
- Nothing evicts old entries. Changing the model changes the keys, so old entries are simply never read again; delete the folder to reclaim space.

## Not in this ticket

Wiring it into the composition root and the indexing pipeline (RAG-034), and any config for the cache folder.
