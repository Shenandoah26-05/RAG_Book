import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandVariants } from "../eval/index.js";
import {
  buildEmbedder,
  embedderNames,
  loadEmbeddingProfiles,
  parseEmbedderSpec,
} from "./build-embedder.js";

describe("parseEmbedderSpec", () => {
  it("splits provider and model at the first colon", () => {
    expect(parseEmbedderSpec("ollama:all-minilm")).toEqual({
      provider: "ollama",
      model: "all-minilm",
    });
    expect(parseEmbedderSpec("ollama:all-minilm:latest")).toEqual({
      provider: "ollama",
      model: "all-minilm:latest",
    });
  });

  it.each(["", "ollama", "ollama:", ":model"])("rejects %j", (spec) => {
    expect(() => parseEmbedderSpec(spec)).toThrow(/provider:model/);
  });
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "rag-buildembedder-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A fake Ollama that records every text it is asked to embed and answers with unit vectors. */
function fakeOllama(dimensions: number): { fetch: typeof fetch; seen: string[] } {
  const seen: string[] = [];
  const fakeFetch = (_url: unknown, init?: RequestInit): Promise<Response> => {
    const { input } = JSON.parse(init?.body as string) as { input: string[] };
    seen.push(...input);
    const vector = Array.from({ length: dimensions }, (_, i) => (i === 0 ? 1 : 0));
    return Promise.resolve(Response.json({ embeddings: input.map(() => vector) }));
  };
  return { fetch: fakeFetch, seen };
}

describe("buildEmbedder", () => {
  const base = () => ({ batchSize: 8, env: {}, cacheDir: path.join(dir, "cache") });

  it("builds the embedder for a known model, with its model id and vector length", async () => {
    const embedder = await buildEmbedder("ollama:all-minilm", base());
    expect(embedder.modelId).toBe("ollama:all-minilm");
    expect(embedder.dimensions).toBe(384);
  });

  it("takes each model's vector length from the profile file", async () => {
    const lengths = await Promise.all(
      ["all-minilm", "nomic-embed-text", "mxbai-embed-large"].map(
        async (model) => (await buildEmbedder(`ollama:${model}`, base())).dimensions,
      ),
    );
    expect(lengths).toEqual([384, 768, 1024]);
  });

  it("names the embedders that exist for an unknown provider or model", async () => {
    const names = embedderNames(await loadEmbeddingProfiles());
    expect(names).toEqual(
      expect.arrayContaining([
        "ollama:all-minilm",
        "ollama:nomic-embed-text",
        "ollama:mxbai-embed-large",
      ]),
    );
    await expect(buildEmbedder("openai:x", base())).rejects.toThrow(
      /Unknown embedding provider "openai".*ollama:all-minilm/,
    );
    await expect(buildEmbedder("ollama:mystery", base())).rejects.toThrow(
      /Unknown embedding model "mystery".*ollama:all-minilm/,
    );
  });

  it("sends the model's prefix with a question and with a passage, and none for all-minilm", async () => {
    const nomic = fakeOllama(768);
    const embedder = await buildEmbedder("ollama:nomic-embed-text", {
      ...base(),
      fetch: nomic.fetch,
    });
    await embedder.embed(["what is a vector?"], "query");
    await embedder.embed(["A vector is a list of numbers."], "document");
    expect(nomic.seen).toEqual([
      "search_query: what is a vector?",
      "search_document: A vector is a list of numbers.",
    ]);

    const minilm = fakeOllama(384);
    const plain = await buildEmbedder("ollama:all-minilm", { ...base(), fetch: minilm.fetch });
    await plain.embed(["what is a vector?"], "query");
    expect(minilm.seen).toEqual(["what is a vector?"]);
  });

  it("gives mxbai a prefix on the question only", async () => {
    const mxbai = fakeOllama(1024);
    const embedder = await buildEmbedder("ollama:mxbai-embed-large", {
      ...base(),
      fetch: mxbai.fetch,
    });
    await embedder.embed(["q"], "query");
    await embedder.embed(["p"], "document");
    expect(mxbai.seen).toEqual(["Represent this sentence for searching relevant passages: q", "p"]);
  });

  it("does not reuse a cached vector after a prefix is changed", async () => {
    const file = path.join(dir, "models.json");
    const write = (queryPrefix: string): Promise<void> =>
      writeFile(file, JSON.stringify({ m: { dimensions: 2, queryPrefix } }));
    const ollama = fakeOllama(2);

    await write("a: ");
    await (
      await buildEmbedder("ollama:m", { ...base(), profilesFile: file, fetch: ollama.fetch })
    ).embed(["same question"], "query");
    await write("b: ");
    await (
      await buildEmbedder("ollama:m", { ...base(), profilesFile: file, fetch: ollama.fetch })
    ).embed(["same question"], "query");

    expect(ollama.seen).toEqual(["a: same question", "b: same question"]);
  });

  it("reports a missing or malformed profile file as CONFIG_INVALID", async () => {
    const bad = path.join(dir, "bad.json");
    await writeFile(bad, JSON.stringify({ m: { dimensions: 0 } }));
    await expect(buildEmbedder("ollama:m", { ...base(), profilesFile: bad })).rejects.toThrow(
      /Invalid embedding model profiles in .*bad\.json at m\.dimensions/,
    );
    await expect(
      buildEmbedder("ollama:m", { ...base(), profilesFile: path.join(dir, "nope.json") }),
    ).rejects.toThrow(/Cannot read embedding model profiles/);
  });
});

describe("the shipped embedders experiment", () => {
  it("names only models that have a profile", async () => {
    const profiles = await loadEmbeddingProfiles();
    const { variants } = expandVariants(
      JSON.parse(await readFile("evals/experiments/embedders.json", "utf8")) as unknown,
    );
    expect(variants).toHaveLength(3);
    for (const variant of variants) {
      const embedding = variant.config["embedding"] as { model: string };
      expect(profiles.has(embedding.model)).toBe(true);
    }
  });
});
