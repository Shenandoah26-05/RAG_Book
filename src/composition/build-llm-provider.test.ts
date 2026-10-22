import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../config/index.js";
import { RagError } from "../shared/index.js";
import { MeteredProvider } from "../strategies/index.js";
import { buildLlmProvider, llmProviderNames } from "./build-llm-provider.js";

const doneLine = `${JSON.stringify({ done: true, done_reason: "stop" })}\n`;

describe("buildLlmProvider", () => {
  it("knows the providers by their config names", () => {
    expect(llmProviderNames()).toEqual(["ollama", "openai-compatible"]);
  });

  it("builds the Ollama provider for the default configuration", () => {
    const provider = buildLlmProvider(DEFAULT_CONFIG.generation);
    // the provider is metered (RAG-093); what it sends is checked in the tests below
    expect(provider).toBeInstanceOf(MeteredProvider);
    expect(provider.modelId).toBe("ollama:llama3.2");
  });

  it("sends the model, host and options from the configuration", async () => {
    const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(new Response(doneLine)));
    const provider = buildLlmProvider(
      { ...DEFAULT_CONFIG.generation, model: "qwen2.5", temperature: 0.7, maxOutputTokens: 50 },
      { env: { OLLAMA_HOST: "gpu-box:9000" }, fetch: fetchFn },
    );
    const events = [];
    for await (const delta of provider.chat([{ role: "user", content: "hi" }])) events.push(delta);
    expect(events).toEqual([{ kind: "end", reason: "stop" }]);

    expect(fetchFn.mock.calls[0]?.[0]).toBe("http://gpu-box:9000/api/chat");
    const body = JSON.parse(fetchFn.mock.calls[0]?.[1]?.body as string) as {
      model: string;
      options: unknown;
    };
    expect(body.model).toBe("qwen2.5");
    expect(body.options).toEqual({ temperature: 0.7, num_predict: 50 });
  });

  it("throws CONFIG_INVALID naming the providers that exist for an unknown one", () => {
    const settings = { ...DEFAULT_CONFIG.generation, provider: "mystery" };
    expect(() => buildLlmProvider(settings)).toThrow(RagError);
    expect(() => buildLlmProvider(settings)).toThrow(/Known providers: ollama, openai-compatible/);
  });
});

describe("buildLlmProvider: openai-compatible", () => {
  const settings = { ...DEFAULT_CONFIG.generation, provider: "openai-compatible", model: "gpt-x" };
  const sse = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

  it("sends the model, options, base URL and key from the configuration and environment", async () => {
    const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(new Response(sse)));
    const provider = buildLlmProvider(
      { ...settings, temperature: 0.7, maxOutputTokens: 50 },
      { env: { OPENAI_BASE_URL: "http://gpu-box:8000/v1", OPENAI_API_KEY: "k-1" }, fetch: fetchFn },
    );
    expect(provider).toBeInstanceOf(MeteredProvider);
    expect(provider.modelId).toBe("openai-compatible:gpt-x");
    const events = [];
    for await (const delta of provider.chat([{ role: "user", content: "hi" }])) events.push(delta);
    expect(events).toEqual([{ kind: "end", reason: "stop" }]);

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("http://gpu-box:8000/v1/chat/completions");
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer k-1");
    expect(JSON.parse(init?.body as string)).toMatchObject({
      model: "gpt-x",
      temperature: 0.7,
      max_tokens: 50,
    });
  });

  it("points at OpenAI when no base URL is set", async () => {
    const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(new Response(sse)));
    const provider = buildLlmProvider(settings, { env: {}, fetch: fetchFn });
    const events = [];
    for await (const delta of provider.chat([{ role: "user", content: "hi" }])) events.push(delta);
    expect(events).toHaveLength(1);
    expect(fetchFn.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("rejects a bad OPENAI_BASE_URL as CONFIG_INVALID", () => {
    expect(() => buildLlmProvider(settings, { env: { OPENAI_BASE_URL: "nope" } })).toThrow(
      /OPENAI_BASE_URL/,
    );
  });
});
