import { describe, expect, it, vi } from "vitest";
import { OllamaProvider } from "../adapters/index.js";
import { DEFAULT_CONFIG } from "../config/index.js";
import { RagError } from "../shared/index.js";
import { buildLlmProvider, llmProviderNames } from "./build-llm-provider.js";

const doneLine = `${JSON.stringify({ done: true, done_reason: "stop" })}\n`;

describe("buildLlmProvider", () => {
  it("knows the providers by their config names", () => {
    expect(llmProviderNames()).toEqual(["ollama"]);
  });

  it("builds the Ollama provider for the default configuration", () => {
    const provider = buildLlmProvider(DEFAULT_CONFIG.generation);
    expect(provider).toBeInstanceOf(OllamaProvider);
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
    const settings = { ...DEFAULT_CONFIG.generation, provider: "openai-compatible" };
    expect(() => buildLlmProvider(settings)).toThrow(RagError);
    expect(() => buildLlmProvider(settings)).toThrow(/Known providers: ollama/);
  });
});
