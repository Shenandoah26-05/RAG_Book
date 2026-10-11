# RAG-033: Vector math by hand

`dot`, `norm`, `normalise`, `cosine` and `euclidean` on `Float32Array`, written out instead of
imported, in `src/strategies/ranking/vector-math.ts`. Pure functions: no I/O, no dependencies
except the error type.

## Why cosine and dot rank the same on normalised vectors

```
cosine(a, b) = dot(a, b) / (|a| * |b|)
```

The Embedder port returns vectors of length 1, so `|a| = |b| = 1` and the division is by 1:

```
cosine(a, b) = dot(a, b)        when |a| = |b| = 1
```

Worked example: `a = (0.6, 0.8)`, `b = (0.8, 0.6)`. Both have length 1.
`dot = 0.6*0.8 + 0.8*0.6 = 0.96`. `cosine = 0.96 / (1 * 1) = 0.96`.

Euclidean distance orders the same way, reversed (closer is more similar), because
`|a - b|^2 = |a|^2 + |b|^2 - 2*dot(a, b) = 2 - 2*cos(a, b)`.

So a store that holds normalised vectors can rank with the dot product alone and skip two square
roots and a division per comparison. `pnpm bench:similarity` measures that and checks that the top
10 are identical.

## Decisions

| #   | Question                  | Chosen                                                                                                |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| D1  | Mutate or allocate?       | Allocate: `normalise` returns a new vector and never changes its input (approved).                    |
| D2  | How is the benchmark run? | A `tsx` script, `pnpm bench:similarity`, like the other scripts. Not part of the test run (approved). |
| D3  | Zero vector               | `normalise` returns a zero copy and `cosine` returns 0, never NaN: a zero vector has no direction.    |
| D4  | Different lengths         | `INVALID_ARGUMENT` from every two-vector function. A silent truncation would hide a model mix-up.     |
| D5  | Precision                 | Sums are kept in a 64-bit `number`; only the stored vectors are 32-bit.                               |

## Not in this ticket

The vector store (RAG-040, RAG-041) and the choice of which function it ranks with.
