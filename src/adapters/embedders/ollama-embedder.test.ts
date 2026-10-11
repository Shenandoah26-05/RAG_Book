import { describe, expect, it, vi } from "vitest";
import type { Embedder } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { describeEmbedderContract } from "../../testing/embedder-contract.testing.js";
import { OllamaEmbedder } from "./ollama-embedder.js";
import type { OllamaEmbedderOptions } from "./ollama-embedder.js";

const DIMENSIONS = 8;

/** A made-up but repeatable, non-unit vector for a text, so the embedder has to normalise. */
function fakeVector(text: string): number[] {
  return Array.from(
    { length: DIMENSIONS },
    (_, i) => 3 * ((text.charCodeAt(i % text.length) + i * 7) % 11) + 1,
  );
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

type Sent = { model: string; input: string[] };

/** Stands in for Ollama: answers /api/embed with one fake vector per input, and records requests. */
function fakeOllama(): typeof fetch & { calls: Sent[] } {
  const calls: Sent[] = [];
  const fn = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    const sent = JSON.parse(init?.body as string) as Sent;
    calls.push(sent);
    return Promise.resolve(json({ model: sent.model, embeddings: sent.input.map(fakeVector) }));
  });
  return Object.assign(fn as unknown as typeof fetch, { calls });
}

const make = (overrides: Partial<OllamaEmbedderOptions> = {}): Embedder =>
  new OllamaEmbedder({
    address: "http://ollama.test:11434",
    model: "all-minilm",
    dimensions: DIMENSIONS,
    fetch: fakeOllama(),
    sleep: () => Promise.resolve(),
    ...overrides,
  });

const length = (v: Float32Array): number => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

/** A fetch that gives the listed answers one after another (an Error means a network failure). */
function answers(...steps: (Response | Error)[]): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(() => {
    const step = steps.shift();
    if (step === undefined) throw new Error("more requests than expected");
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
  });
}

/** The code and message of the RagError that a promise rejects with. */
async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RagError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected the promise to reject");
}

describeEmbedderContract("OllamaEmbedder (stubbed server)", () => make());

describe("OllamaEmbedder: requests", () => {
  it("has the model id ollama:<model>", () => {
    expect(make().modelId).toBe("ollama:all-minilm");
  });

  it("posts the model and the texts to /api/embed", async () => {
    const fetchFn = answers(json({ embeddings: [fakeVector("a")] }));
    await make({ fetch: fetchFn }).embed(["a"], "document");

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("http://ollama.test:11434/api/embed");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ model: "all-minilm", input: ["a"] });
  });

  it("splits the texts into batches and keeps their order", async () => {
    const fetchFn = fakeOllama();
    const texts = ["one", "two", "three", "four", "five"];
    const vectors = await make({ fetch: fetchFn, batchSize: 2 }).embed(texts, "document");

    expect(fetchFn.calls.map((c) => c.input)).toEqual([
      ["one", "two"],
      ["three", "four"],
      ["five"],
    ]);
    const alone = await make().embed(["four"], "document");
    expect(vectors[3]).toEqual(alone[0]);
  });

  it("makes no request for no texts", async () => {
    const fetchFn = fakeOllama();
    expect(await make({ fetch: fetchFn }).embed([], "query")).toEqual([]);
    expect(fetchFn.calls).toEqual([]);
  });

  it("returns Float32Array vectors of length 1", async () => {
    const [vector] = await make().embed(["hello"], "query");
    expect(vector).toBeInstanceOf(Float32Array);
    expect(length(vector as Float32Array)).toBeCloseTo(1, 5);
  });
});

describe("OllamaEmbedder: retries", () => {
  const ok = (): Response => json({ embeddings: [fakeVector("a")] });

  it("retries a network error, waiting longer each time", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
    const fetchFn = answers(new TypeError("fetch failed"), new TypeError("fetch failed"), ok());

    const vectors = await make({ fetch: fetchFn, sleep, retryDelayMs: 100 }).embed(["a"], "query");

    expect(vectors).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[100], [200]]);
  });

  it("retries a 503 and a 429", async () => {
    const fetchFn = answers(json({ error: "busy" }, 503), json({ error: "slow down" }, 429), ok());
    await make({ fetch: fetchFn }).embed(["a"], "query");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("gives up after maxRetries and says Ollama cannot be reached", async () => {
    const fetchFn = answers(...Array.from({ length: 3 }, () => new TypeError("fetch failed")));
    const error = await failure(make({ fetch: fetchFn, maxRetries: 2 }).embed(["a"], "query"));
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error.message).toContain("Cannot reach Ollama");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a missing model, and tells the user how to install it", async () => {
    const fetchFn = answers(json({ error: "model 'all-minilm' not found" }, 404));
    const error = await failure(make({ fetch: fetchFn }).embed(["a"], "query"));
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error.message).toContain("ollama pull all-minilm");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 400", async () => {
    const fetchFn = answers(json({ error: "bad input" }, 400));
    const error = await failure(make({ fetch: fetchFn }).embed(["a"], "query"));
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("OllamaEmbedder: checking the answer", () => {
  const embedWith = (body: unknown, texts = ["a"]): Promise<readonly Float32Array[]> =>
    make({ fetch: answers(json(body)) }).embed(texts, "document");

  it("rejects an answer that is not shaped like /api/embed", async () => {
    expect((await failure(embedWith({ vectors: [] }))).code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("rejects a different number of vectors than texts", async () => {
    const error = await failure(embedWith({ embeddings: [fakeVector("a")] }, ["a", "b"]));
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error.message).toContain("1 vectors for 2 texts");
  });

  it("rejects vectors of the wrong length", async () => {
    const error = await failure(embedWith({ embeddings: [[1, 2, 3]] }));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("length 3");
  });

  it("rejects a vector of zeros, which cannot be normalised", async () => {
    const zeros = new Array<number>(DIMENSIONS).fill(0);
    expect((await failure(embedWith({ embeddings: [zeros] }))).code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("rejects an answer that is not JSON", async () => {
    const fetchFn = answers(new Response("<html>"));
    const error = await failure(make({ fetch: fetchFn }).embed(["a"], "query"));
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error.message).toContain("not JSON");
  });
});

describe("OllamaEmbedder: constructor", () => {
  it.each([
    { dimensions: 0 },
    { batchSize: 0 },
    { batchSize: 1.5 },
    { timeoutMs: 0 },
    { maxRetries: -1 },
    { retryDelayMs: -1 },
  ])("rejects %o", (bad) => {
    try {
      make(bad);
      expect.unreachable("the constructor should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RagError);
      expect((error as RagError).code).toBe("CONFIG_INVALID");
    }
  });
});
