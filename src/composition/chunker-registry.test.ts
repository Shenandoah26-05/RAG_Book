import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../config/index.js";
import type { Chunker } from "../core/index.js";
import { RagError } from "../shared/index.js";
import { buildChunker, ChunkerRegistry } from "./chunker-registry.js";
import type { ChunkerFactory, ChunkerSettings } from "./chunker-registry.js";

const SETTINGS: ChunkerSettings = { maxTokens: 400, overlapTokens: 60 };

/** A chunker that does nothing, with the given name. */
const fake = (name: string): Chunker => ({ name, chunk: () => Promise.resolve([]) });
const factoryFor =
  (name: string): ChunkerFactory =>
  () =>
    fake(name);

/** Runs `fn`, expecting a RagError, and returns it. */
function errorOf(fn: () => unknown): RagError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RagError);
    return error as RagError;
  }
  throw new Error("expected a RagError, but nothing was thrown");
}

describe("ChunkerRegistry", () => {
  it("builds the chunker registered under a name", () => {
    const registry = new ChunkerRegistry().register("fixed-size", factoryFor("fixed-size"));
    expect(registry.create("fixed-size", SETTINGS).name).toBe("fixed-size");
  });

  it("lists the names in the order they were registered", () => {
    const registry = new ChunkerRegistry()
      .register("recursive", factoryFor("recursive"))
      .register("fixed-size", factoryFor("fixed-size"));
    expect(registry.names()).toEqual(["recursive", "fixed-size"]);
  });

  it("starts empty", () => {
    expect(new ChunkerRegistry().names()).toEqual([]);
  });

  it("gives the factory the settings", () => {
    const factory = vi.fn<ChunkerFactory>(() => fake("fixed-size"));
    new ChunkerRegistry().register("fixed-size", factory).create("fixed-size", SETTINGS);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0]?.[0].settings).toEqual({ maxTokens: 400, overlapTokens: 60 });
  });

  it("builds a new chunker every time", () => {
    const registry = new ChunkerRegistry().register("fixed-size", factoryFor("fixed-size"));
    expect(registry.create("fixed-size", SETTINGS)).not.toBe(
      registry.create("fixed-size", SETTINGS),
    );
  });

  it("keeps registrations apart between registries (it is not a global)", () => {
    const one = new ChunkerRegistry().register("fixed-size", factoryFor("fixed-size"));
    expect(new ChunkerRegistry().names()).toEqual([]);
    expect(one.names()).toEqual(["fixed-size"]);
  });
});

describe("ChunkerRegistry: unknown and invalid names", () => {
  it("rejects an unknown strategy with CONFIG_INVALID, and lists the ones that exist", () => {
    const registry = new ChunkerRegistry()
      .register("fixed-size", factoryFor("fixed-size"))
      .register("recursive", factoryFor("recursive"));
    const error = errorOf(() => registry.create("magic", SETTINGS));

    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain('"magic"');
    expect(error.message).toContain("fixed-size, recursive");
  });

  it("says when no strategy is registered at all", () => {
    const error = errorOf(() => new ChunkerRegistry().create("recursive", SETTINGS));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("No strategies are registered");
  });

  it("rejects registering the same name twice", () => {
    const registry = new ChunkerRegistry().register("fixed-size", factoryFor("fixed-size"));
    const error = errorOf(() => registry.register("fixed-size", factoryFor("fixed-size")));
    expect(error.code).toBe("INTERNAL");
    expect(error.message).toContain("already registered");
  });

  it.each(["", "Fixed-Size", "fixed_size", "fixed size", "-fixed", "fixed-", "1fixed"])(
    "rejects the name %j, which is not kebab-case",
    (name) => {
      expect(errorOf(() => new ChunkerRegistry().register(name, factoryFor(name))).code).toBe(
        "INTERNAL",
      );
    },
  );

  it("rejects a factory that builds a chunker with another name", () => {
    const registry = new ChunkerRegistry().register("fixed-size", factoryFor("something-else"));
    const error = errorOf(() => registry.create("fixed-size", SETTINGS));
    expect(error.code).toBe("INTERNAL");
    expect(error.message).toContain('"fixed-size"');
    expect(error.message).toContain('"something-else"');
  });
});

describe("ChunkerRegistry: chunkers made of chunkers", () => {
  it("lets a factory build another chunker, with the same settings", () => {
    const innerFactory = vi.fn<ChunkerFactory>(() => fake("recursive"));
    const registry = new ChunkerRegistry()
      .register("recursive", innerFactory)
      .register("structure-aware", (context) => {
        const inner = context.create("recursive");
        return { name: "structure-aware", chunk: (doc) => inner.chunk(doc) };
      });

    expect(registry.create("structure-aware", SETTINGS).name).toBe("structure-aware");
    expect(innerFactory).toHaveBeenCalledOnce();
    expect(innerFactory.mock.calls[0]?.[0].settings).toEqual(SETTINGS);
  });

  it("works several levels deep", () => {
    const registry = new ChunkerRegistry()
      .register("base", factoryFor("base"))
      .register("middle", (context) => {
        context.create("base");
        return fake("middle");
      })
      .register("top", (context) => {
        context.create("middle");
        return fake("top");
      });
    expect(registry.create("top", SETTINGS).name).toBe("top");
  });

  it("tells a missing inner strategy apart from the outer one", () => {
    const registry = new ChunkerRegistry().register("structure-aware", (context) => {
      context.create("recursive");
      return fake("structure-aware");
    });
    const error = errorOf(() => registry.create("structure-aware", SETTINGS));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain('"recursive"');
  });

  it("stops a strategy that needs itself, and shows the loop", () => {
    const registry = new ChunkerRegistry().register("loop", (context) => {
      context.create("loop");
      return fake("loop");
    });
    const error = errorOf(() => registry.create("loop", SETTINGS));
    expect(error.code).toBe("INTERNAL");
    expect(error.message).toContain("loop -> loop");
  });

  it("stops strategies that need each other, and shows the loop", () => {
    const registry = new ChunkerRegistry()
      .register("a", (context) => {
        context.create("b");
        return fake("a");
      })
      .register("b", (context) => {
        context.create("a");
        return fake("b");
      });
    expect(errorOf(() => registry.create("a", SETTINGS)).message).toContain("a -> b -> a");
  });

  it("allows the same inner strategy to be used twice, which is not a loop", () => {
    const registry = new ChunkerRegistry()
      .register("base", factoryFor("base"))
      .register("pair", (context) => {
        context.create("base");
        context.create("base");
        return fake("pair");
      });
    expect(registry.create("pair", SETTINGS).name).toBe("pair");
  });
});

describe("buildChunker", () => {
  it("builds the strategy that config.chunking names, with its sizes", () => {
    const factory = vi.fn<ChunkerFactory>(() => fake("recursive"));
    const registry = new ChunkerRegistry().register("recursive", factory);

    const chunker = buildChunker(DEFAULT_CONFIG.chunking, registry);

    expect(chunker.name).toBe("recursive");
    expect(factory.mock.calls[0]?.[0].settings).toEqual({ maxTokens: 400, overlapTokens: 60 });
  });

  it("follows a different strategy and sizes", () => {
    const factory = vi.fn<ChunkerFactory>(() => fake("fixed-size"));
    const registry = new ChunkerRegistry().register("fixed-size", factory);

    buildChunker({ strategy: "fixed-size", maxTokens: 200, overlapTokens: 20 }, registry);

    expect(factory.mock.calls[0]?.[0].settings).toEqual({ maxTokens: 200, overlapTokens: 20 });
  });

  it("fails with CONFIG_INVALID when config names a strategy that is not registered", () => {
    const registry = new ChunkerRegistry().register("fixed-size", factoryFor("fixed-size"));
    const error = errorOf(() => buildChunker(DEFAULT_CONFIG.chunking, registry)); // "recursive"
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain('"recursive"');
    expect(error.message).toContain("fixed-size");
  });
});
