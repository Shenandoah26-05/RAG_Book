import { describe, expect, it, vi } from "vitest";
import type { Embedder } from "../../core/index.js";
import type { RagError } from "../../shared/index.js";
import { describeEmbedderContract } from "../../testing/embedder-contract.testing.js";
import { OpenAiEndpoint } from "../openai-compatible/index.js";
import { OpenAiEmbedder } from "./openai-embedder.js";
import type { OpenAiEmbedderOptions } from "./openai-embedder.js";

const KEY = "sk-test-SECRET-1234567890";
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

type Sent = { model: string; input: string[]; encoding_format: string };

/** Stands in for the server: answers /embeddings with one fake vector per input, recording requests. */
function fakeServer(): typeof fetch & { calls: Sent[] } {
  const calls: Sent[] = [];
  const fn = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    const sent = JSON.parse(init?.body as string) as Sent;
    calls.push(sent);
    return Promise.resolve(
      json({
        object: "list",
        data: sent.input.map((text, index) => ({
          object: "embedding",
          index,
          embedding: fakeVector(text),
        })),
      }),
    );
  });
  return Object.assign(fn as unknown as typeof fetch, { calls });
}

const endpoint = new OpenAiEndpoint({ baseUrl: "http://h:1/v1", apiKey: KEY });

const make = (overrides: Partial<OpenAiEmbedderOptions> = {}): Embedder =>
  new OpenAiEmbedder({
    endpoint,
    model: "text-embedding-3-small",
    dimensions: DIMENSIONS,
    fetch: fakeServer(),
    ...overrides,
  });

describeEmbedderContract("OpenAiEmbedder", () => make());

const length = (v: Float32Array): number => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

async function failure(promise: Promise<unknown>): Promise<RagError> {
  try {
    await promise;
  } catch (error) {
    return error as RagError;
  }
  throw new Error("expected a failure");
}

const answering =
  (response: Response | Error): typeof fetch =>
  () =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response);

describe("OpenAiEmbedder", () => {
  it("posts the batch with the model, the key and float encoding", async () => {
    const fetchFn = vi.fn<typeof fetch>(fakeServer());
    await make({ fetch: fetchFn }).embed(["a", "b"], "document");
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("http://h:1/v1/embeddings");
    expect(init?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: `Bearer ${KEY}`,
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      model: "text-embedding-3-small",
      input: ["a", "b"],
      encoding_format: "float",
    });
  });

  it("splits texts into batches and keeps their order", async () => {
    const server = fakeServer();
    const texts = ["one", "two", "three", "four", "five"];
    const vectors = await make({ fetch: server, batchSize: 2 }).embed(texts, "query");
    expect(server.calls.map((c) => c.input)).toEqual([["one", "two"], ["three", "four"], ["five"]]);
    expect(vectors).toHaveLength(5);
  });

  it("returns unit-length vectors", async () => {
    for (const v of await make().embed(["hello"], "query")) {
      expect(length(v)).toBeCloseTo(1, 5);
    }
  });

  it("puts vectors back in the order of the texts when the server shuffles them", async () => {
    const shuffled: typeof fetch = (_url, init) => {
      const sent = JSON.parse(init?.body as string) as Sent;
      const data = sent.input
        .map((text, index) => ({ index, embedding: fakeVector(text) }))
        .reverse();
      return Promise.resolve(json({ data }));
    };
    const [first, second] = await make({ fetch: shuffled }).embed(["x", "yy"], "query");
    const [expectedFirst, expectedSecond] = await make().embed(["x", "yy"], "query");
    expect(first).toEqual(expectedFirst);
    expect(second).toEqual(expectedSecond);
  });

  it("names the model with the provider prefix", () => {
    expect(make().modelId).toBe("openai-compatible:text-embedding-3-small");
  });

  it("refuses bad settings when created", () => {
    expect(() => make({ dimensions: 0 })).toThrow(/dimensions/);
    expect(() => make({ batchSize: 0 })).toThrow(/batchSize/);
    expect(() => make({ timeoutMs: 1.5 })).toThrow(/timeoutMs/);
  });

  it("rejects with PROVIDER_UNAVAILABLE when the server cannot be reached", async () => {
    const error = await failure(
      make({ fetch: answering(new TypeError("fetch failed")) }).embed(["a"], "query"),
    );
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it("explains a refused key and a missing model", async () => {
    const refused = answering(json({ error: { message: "bad key" } }, 401));
    expect((await failure(make({ fetch: refused }).embed(["a"], "query"))).message).toMatch(
      /HTTP 401: bad key.*OPENAI_API_KEY/,
    );
    const missing = answering(json({ error: { message: "no such model" } }, 404));
    expect((await failure(make({ fetch: missing }).embed(["a"], "query"))).message).toMatch(
      /no model "text-embedding-3-small"/,
    );
  });

  it("removes a key the server echoes in an error", async () => {
    const echo = answering(json({ error: { message: `Incorrect key ${KEY}` } }, 401));
    const error = await failure(make({ fetch: echo }).embed(["a"], "query"));
    expect(error.message).not.toContain(KEY);
    expect(error.message).toContain("[redacted]");
  });

  it("rejects a body that is not JSON or not shaped like the API", async () => {
    const notJson = answering(new Response("<html>"));
    expect((await failure(make({ fetch: notJson }).embed(["a"], "query"))).message).toMatch(
      /not JSON/,
    );
    const wrong = answering(json({ vectors: [] }));
    expect((await failure(make({ fetch: wrong }).embed(["a"], "query"))).message).toMatch(
      /unexpected response/,
    );
  });

  it("rejects a wrong number of vectors, repeated indexes, a wrong length and a zero vector", async () => {
    const one = { index: 0, embedding: fakeVector("a") };
    const count = answering(json({ data: [one] }));
    expect((await failure(make({ fetch: count }).embed(["a", "b"], "query"))).message).toMatch(
      /1 vectors for 2 texts/,
    );
    const repeated = answering(json({ data: [one, one] }));
    expect((await failure(make({ fetch: repeated }).embed(["a", "b"], "query"))).message).toMatch(
      /indexes/,
    );
    const short = answering(json({ data: [{ index: 0, embedding: [1, 2] }] }));
    expect((await failure(make({ fetch: short }).embed(["a"], "query"))).code).toBe(
      "CONFIG_INVALID",
    );
    const zero = answering(
      json({ data: [{ index: 0, embedding: new Array<number>(DIMENSIONS).fill(0) }] }),
    );
    expect((await failure(make({ fetch: zero }).embed(["a"], "query"))).code).toBe(
      "PROVIDER_UNAVAILABLE",
    );
  });
});
