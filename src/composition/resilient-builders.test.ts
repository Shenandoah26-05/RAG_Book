import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config/index.js";
import type { RagConfig } from "../config/index.js";
import { FakeClock } from "../testing/fake-clock.testing.js";
import { read, settled } from "../strategies/resilience/resilience.testing.js";
import { buildEmbedder } from "./build-embedder.js";
import { buildLlmProvider } from "./build-llm-provider.js";
import { Resilience } from "./build-resilience.js";

// The real builders, the real adapters and a fake server: a failure is retried, the cache sits
// outside the protection, and an adapter does not retry on its own once the decorator is there.

const OFF = {
  retries: 0,
  backoffMs: 0,
  maxBackoffMs: 0,
  timeoutMs: 0,
  requestsPerMinute: 0,
  maxConcurrent: 0,
};
const settings = (
  generation: Partial<typeof OFF> = {},
  embedding: Partial<typeof OFF> = {},
): RagConfig["resilience"] => ({
  generation: { ...OFF, ...generation },
  embedding: { ...OFF, ...embedding },
});

/** An Ollama that answers each request with the next status, then with a good reply. */
function server(statuses: readonly (number | { status: number; retryAfter: string })[]) {
  const requests: string[] = [];
  const fetchFn = ((url: string | URL | Request) => {
    const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    requests.push(target);
    const step = statuses[requests.length - 1];
    if (step !== undefined) {
      const { status, retryAfter } =
        typeof step === "number" ? { status: step, retryAfter: undefined } : step;
      return Promise.resolve(
        new Response(JSON.stringify({ error: "try later" }), {
          status,
          ...(retryAfter === undefined ? {} : { headers: { "retry-after": retryAfter } }),
        }),
      );
    }
    if (target.endsWith("/api/embed")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            embeddings: [Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0))],
          }),
        ),
      );
    }
    const lines =
      `${JSON.stringify({ message: { role: "assistant", content: "hello" }, done: false })}\n` +
      `${JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop" })}\n`;
    return Promise.resolve(new Response(lines));
  }) as typeof fetch;
  return { fetchFn, requests };
}

/**
 * Moves the fake clock on until `promise` settles. A call that goes through the cache does real file
 * I/O before it waits, so its sleep is not registered yet when a single advance would run.
 */
async function drive<T>(promise: Promise<T>, clock: FakeClock): Promise<T> {
  const state = { done: false };
  const finish = (): void => {
    state.done = true;
  };
  promise.then(finish, finish);
  for (let i = 0; i < 200 && !state.done; i++) {
    await clock.advance(1000);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return promise;
}

let cacheDir: string;
beforeAll(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), "rag-resilient-"));
});
afterAll(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

const generation = DEFAULT_CONFIG.generation;
const ask = [{ role: "user", content: "hi" }] as const;

describe("buildLlmProvider with resilience", () => {
  it("retries a busy server and returns the reply", async () => {
    const clock = new FakeClock();
    const { fetchFn, requests } = server([503]);
    const resilience = new Resilience(
      settings({ retries: 2, backoffMs: 100, maxBackoffMs: 1000 }),
      {
        clock,
        random: () => 1,
      },
    );
    const llm = buildLlmProvider(generation, { env: {}, fetch: fetchFn, resilience });
    const outcome = await settled(read(llm.chat(ask)), () => clock.advance(5000));
    expect(outcome.value).toEqual(["hello"]);
    expect(requests).toHaveLength(2);
  });

  it("waits as long as the server asked", async () => {
    const clock = new FakeClock();
    const { fetchFn } = server([{ status: 429, retryAfter: "2" }]);
    const resilience = new Resilience(settings({ retries: 1, backoffMs: 10, maxBackoffMs: 5000 }), {
      clock,
      random: () => 0,
    });
    const llm = buildLlmProvider(generation, { env: {}, fetch: fetchFn, resilience });
    await settled(read(llm.chat(ask)), () => clock.advance(10_000));
    expect(clock.sleeps).toEqual([2000]);
  });

  it("does not retry a missing model", async () => {
    const clock = new FakeClock();
    const { fetchFn, requests } = server([404]);
    const resilience = new Resilience(settings({ retries: 3, backoffMs: 10, maxBackoffMs: 100 }), {
      clock,
    });
    const llm = buildLlmProvider(generation, { env: {}, fetch: fetchFn, resilience });
    await expect(read(llm.chat(ask))).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(requests).toHaveLength(1);
  });

  it("gives up when the server asks for longer than it will wait", async () => {
    const clock = new FakeClock();
    const { fetchFn, requests } = server([{ status: 429, retryAfter: "600" }]);
    const resilience = new Resilience(settings({ retries: 3, backoffMs: 10, maxBackoffMs: 5000 }), {
      clock,
    });
    const llm = buildLlmProvider(generation, { env: {}, fetch: fetchFn, resilience });
    await expect(read(llm.chat(ask))).rejects.toThrow(/HTTP 429/);
    expect(requests).toHaveLength(1);
  });

  it("is the plain provider when no resilience is given", async () => {
    const { fetchFn, requests } = server([503]);
    const llm = buildLlmProvider(generation, { env: {}, fetch: fetchFn });
    await expect(read(llm.chat(ask))).rejects.toThrow(/HTTP 503/);
    expect(requests).toHaveLength(1);
  });
});

describe("buildEmbedder with resilience", () => {
  const options = (extra: object) => ({ batchSize: 32, env: {}, cacheDir, ...extra });

  it("lets the decorator retry, and the adapter not retry as well", async () => {
    const clock = new FakeClock();
    const { fetchFn, requests } = server([503]);
    const resilience = new Resilience(
      settings({}, { retries: 2, backoffMs: 100, maxBackoffMs: 1000 }),
      {
        clock,
        random: () => 1,
      },
    );
    const embedder = buildEmbedder(
      "ollama:all-minilm",
      options({ fetch: fetchFn, resilience, cacheDir: path.join(cacheDir, "a") }),
    );
    expect(await drive(embedder.embed(["one"], "document"), clock)).toHaveLength(1);
    // one failure and one success: not the adapter's own retries on top of the decorator's
    expect(requests).toHaveLength(2);
  });

  it("does not retry at all when retries is 0, though the adapter would on its own", async () => {
    const { fetchFn, requests } = server([503, 503, 503, 503]);
    const resilience = new Resilience(settings({}, { retries: 0 }), {});
    const embedder = buildEmbedder(
      "ollama:all-minilm",
      options({ fetch: fetchFn, resilience, cacheDir: path.join(cacheDir, "b") }),
    );
    await expect(embedder.embed(["one"], "document")).rejects.toThrow(/HTTP 503/);
    expect(requests).toHaveLength(1);
  });

  it("keeps the cache outside: a cached text costs no call, no retry and no turn", async () => {
    const clock = new FakeClock();
    const { fetchFn, requests } = server([]);
    const resilience = new Resilience(settings({}, { requestsPerMinute: 1 }), { clock });
    const embedder = buildEmbedder(
      "ollama:all-minilm",
      options({ fetch: fetchFn, resilience, cacheDir: path.join(cacheDir, "c") }),
    );
    await embedder.embed(["same"], "document");
    // the only turn this minute is spent; a cached text must not wait for the next one
    await embedder.embed(["same"], "document");
    expect(requests).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("still caches under the model id of what it wraps", () => {
    const resilience = new Resilience(settings({}, { retries: 1, backoffMs: 1, maxBackoffMs: 1 }));
    const embedder = buildEmbedder(
      "ollama:all-minilm",
      options({ resilience, cacheDir: path.join(cacheDir, "d") }),
    );
    expect([embedder.modelId, embedder.dimensions]).toEqual(["ollama:all-minilm", 384]);
  });
});
