import { describe, expect, it } from "vitest";
import type { Embedder } from "../core/index.js";
import { RagError } from "../shared/index.js";
import { OllamaEmbedder } from "./embedders/ollama-embedder.js";
import { OpenAiEmbedder } from "./embedders/openai-embedder.js";
import { OllamaProvider } from "./llm/ollama-provider.js";
import { OpenAiChatProvider } from "./llm/openai-chat-provider.js";
import { OpenAiEndpoint } from "./openai-compatible/openai-endpoint.js";

// Every adapter says, on the errors it raises, whether trying again could help. It is the only code
// that knows (a 404 is a missing model, a 429 is a busy server), and the retrying decorator of
// RAG-092 reads it. These tests pin what each adapter says for each kind of failure.

const refuses =
  (status: number, headers: Record<string, string> = {}): typeof fetch =>
  () =>
    Promise.resolve(new Response(JSON.stringify({ error: "nope" }), { status, headers }));
const unreachable: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));

async function failure(attempt: () => Promise<unknown>): Promise<RagError> {
  const error = await attempt().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RagError);
  return error as RagError;
}

const chat = [{ role: "user", content: "hi" }] as const;
const drain = async (stream: AsyncIterable<unknown>): Promise<void> => {
  const seen: unknown[] = [];
  for await (const event of stream) seen.push(event);
};

/** Calls an embedder the way the pipeline does, through the port. */
const embedWith = (embedder: Embedder): Promise<unknown> => embedder.embed(["a"], "document");

const endpoint = new OpenAiEndpoint({ baseUrl: "http://h:1/v1", apiKey: "sk-test" });

/** An adapter set up to meet `fetchFn`, as a function that makes it fail. */
type Attempt = (fetchFn: typeof fetch) => () => Promise<unknown>;

const targets: Record<string, Attempt> = {
  "Ollama model": (fetchFn: typeof fetch) => () =>
    drain(new OllamaProvider({ address: "http://h:1", model: "m", fetch: fetchFn }).chat(chat)),
  "OpenAI-compatible model": (fetchFn: typeof fetch) => () =>
    drain(new OpenAiChatProvider({ endpoint, model: "m", fetch: fetchFn }).chat(chat)),
  "Ollama embedder": (fetchFn: typeof fetch) => () =>
    embedWith(
      new OllamaEmbedder({
        address: "http://h:1",
        model: "all-minilm",
        dimensions: 384,
        maxRetries: 0,
        fetch: fetchFn,
      }),
    ),
  "OpenAI-compatible embedder": (fetchFn: typeof fetch) => () =>
    embedWith(new OpenAiEmbedder({ endpoint, model: "m", dimensions: 384, fetch: fetchFn })),
};

describe.each(Object.keys(targets))("%s", (name) => {
  const attempt = targets[name] as Attempt;
  it("says a server that cannot be reached may come back", async () => {
    const error = await failure(attempt(unreachable));
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error.retryable).toBe(true);
  });

  it.each([429, 500, 502, 503, 504])("says HTTP %i may pass", async (status) => {
    expect((await failure(attempt(refuses(status)))).retryable).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])("says HTTP %i will be refused again", async (status) => {
    expect((await failure(attempt(refuses(status)))).retryable).toBe(false);
  });

  it("passes on how long a busy server asked to wait", async () => {
    const error = await failure(attempt(refuses(429, { "retry-after": "3" })));
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(3000);
  });

  it("does not invent a wait when the server gave none", async () => {
    expect((await failure(attempt(refuses(503)))).retryAfterMs).toBeUndefined();
  });
});

describe("a reply that is not what the adapter expects", () => {
  it("is not marked retryable: asking again gets the same wrong shape", async () => {
    const notJson: typeof fetch = () => Promise.resolve(new Response("<html>", { status: 200 }));
    const error = await failure((targets["OpenAI-compatible embedder"] as Attempt)(notJson));
    expect(error.retryable).toBeUndefined();
  });
});
