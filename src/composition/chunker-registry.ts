import type { Chunker } from "../core/index.js";
import { RagError } from "../shared/index.js";

// Maps the strategy name in config (`chunking.strategy`) to a new chunker. Adding a strategy is one
// new class and one `register` call in the composition root, as with the cleaners and loaders.
//
// This is a class, not a plain map, for one reason: some chunkers are built FROM other chunkers
// (the structure-aware chunker wraps the recursive one), so a factory is given a context that can
// create other chunkers by name. See docs/design/rag-020-chunker-port.md.

/** The settings from `config.chunking` that every strategy may use. */
export interface ChunkerSettings {
  readonly maxTokens: number;
  readonly overlapTokens: number;
}

/** What a factory is given when it is asked to build a chunker. */
export interface ChunkerBuildContext {
  readonly settings: ChunkerSettings;
  /** Builds another registered chunker with the same settings, for chunkers made of chunkers. */
  create(name: string): Chunker;
}

export type ChunkerFactory = (context: ChunkerBuildContext) => Chunker;

/** Strategy names are kebab-case, like the rest of the names in config. */
const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export class ChunkerRegistry {
  readonly #factories = new Map<string, ChunkerFactory>();

  /** Adds a strategy. Returns the registry so calls can be chained. */
  register(name: string, factory: ChunkerFactory): this {
    if (!NAME.test(name)) {
      throw new RagError(
        "INTERNAL",
        `Chunker name "${name}" must be kebab-case, like "fixed-size"`,
      );
    }
    if (this.#factories.has(name)) {
      throw new RagError("INTERNAL", `A chunker named "${name}" is already registered`);
    }
    this.#factories.set(name, factory);
    return this;
  }

  /** The registered names, in the order they were added. */
  names(): readonly string[] {
    return [...this.#factories.keys()];
  }

  /**
   * Builds the chunker registered under `name`. Throws CONFIG_INVALID, listing the names that exist,
   * if there is none.
   */
  create(name: string, settings: ChunkerSettings): Chunker {
    return this.#build(name, settings, []);
  }

  /** `path` is the chain of strategies being built, to catch strategies that need themselves. */
  #build(name: string, settings: ChunkerSettings, path: readonly string[]): Chunker {
    const factory = this.#factories.get(name);
    if (factory === undefined) {
      const known = this.names();
      throw new RagError(
        "CONFIG_INVALID",
        `Unknown chunking strategy "${name}". ` +
          (known.length === 0
            ? "No strategies are registered."
            : `Known strategies: ${known.join(", ")}`),
      );
    }
    if (path.includes(name)) {
      throw new RagError(
        "INTERNAL",
        `Chunking strategies depend on each other in a loop: ${[...path, name].join(" -> ")}`,
      );
    }

    const chunker = factory({
      settings,
      create: (inner) => this.#build(inner, settings, [...path, name]),
    });
    // The name is written to every chunk and is how results are told apart, so it must be the one
    // the strategy was registered under.
    if (chunker.name !== name) {
      throw new RagError(
        "INTERNAL",
        `The factory registered as "${name}" built a chunker named "${chunker.name}"`,
      );
    }
    return chunker;
  }
}

/**
 * Builds the chunker that `config.chunking` asks for. Throws CONFIG_INVALID if the strategy is not
 * registered.
 */
export function buildChunker(
  chunking: ChunkerSettings & { readonly strategy: string },
  registry: ChunkerRegistry,
): Chunker {
  return registry.create(chunking.strategy, {
    maxTokens: chunking.maxTokens,
    overlapTokens: chunking.overlapTokens,
  });
}
