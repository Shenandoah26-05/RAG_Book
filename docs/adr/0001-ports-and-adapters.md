# ADR-0001: Ports and adapters

- **Status**: Accepted
- **Date**: 2026-10-03

## Context

RAG Book is a RAG pipeline over a book PDF, and its purpose is to compare approaches: several
chunking strategies, embedding models, retrievers, rerankers and LLM providers, scored against the
same evaluation set.

Almost every important piece has more than one plausible implementation, and the outside world it
touches (Ollama, PDF libraries, vector stores) changes faster than the logic that uses it. If the
pipeline calls those directly, then:

- trying a different chunker, embedder or store means editing pipeline code, which makes fair A/B
  comparison hard and risky;
- unit tests need a running Ollama or real files;
- a library upgrade or replacement spreads through the codebase.

We need a structure where implementations are swappable by configuration and the core logic can be
tested without any external service.

## Options

### Option A: Direct calls (no abstraction)

The pipeline imports and calls Ollama, the PDF library and the vector store directly.

- Pros: least code up front; nothing to design.
- Cons: every experiment edits shared code; tests depend on external services; replacing a
  dependency touches many files.

### Option B: Layered architecture without owned interfaces

Folders for ingestion, chunking, retrieval and so on, each importing the concrete modules it needs.

- Pros: familiar; some separation of concerns.
- Cons: layers still depend on concrete implementations, so swapping one is still an edit in the
  caller. Nothing stops dependencies from tangling over time.

### Option C: Ports and adapters (hexagonal)

`core/` defines domain types and port interfaces (`Embedder`, `Chunker`, `VectorStore`, ...).
Implementations live in `strategies/` (pure algorithms) and `adapters/` (the outside world), and
depend only on `core`. Orchestration (`pipeline/`, `eval/`) talks to ports only. A single
composition root builds concrete objects from validated config.

- Pros: swap or add an implementation with one class and one registry line; the pipeline is
  testable with fakes; dependency direction can be checked automatically.
- Cons: more files and indirection; ports must be designed before implementations; discipline is
  needed so interfaces do not leak implementation details.

## Decision

We use **ports and adapters** (Option C).

- `core/` holds domain types and port interfaces and imports nothing else from the project, nor
  any third-party package.
- `strategies/` and `adapters/` implement ports, import only `core` (and `shared`), and never import
  each other.
- `pipeline/` and `eval/` depend on ports, never on concrete classes.
- Only `composition/` knows concrete classes. Entry points (`cli/`, later `web/`) call it and
  contain no logic.
- Dependencies point downwards only.

The reason is that the project's value is comparing interchangeable implementations. The
architecture should make that cheap and safe.

The rules are enforced by `pnpm deps:check` (dependency-cruiser,
[config](../../.dependency-cruiser.mjs)), and the layer diagram is in
[architecture.md](../architecture.md).

## Consequences

- **Easier**: adding a strategy or adapter touches one new file plus one registry line in
  `composition/`. Experiments become config changes. Unit tests use in-memory fakes. Replacing
  Ollama, the PDF library or the vector store affects one adapter.
- **Harder**: more up-front design. Each port must be reviewed before an implementation is written,
  and there is more indirection when reading the code.
- **Obligations**: the dependency check must keep passing. If code needs something from a layer
  above, we add a port in `core/` instead of importing upwards.
- **Reversing**: possible but expensive, because ports are used everywhere. Changing this decision
  requires a new ADR that supersedes this one.
