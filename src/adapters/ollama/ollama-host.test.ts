import { describe, expect, it, vi } from "vitest";
import { RagError } from "../../shared/index.js";
import { DEFAULT_OLLAMA_HOST, normalizeOllamaHost, OllamaHost } from "./ollama-host.js";

describe("normalizeOllamaHost", () => {
  it.each([
    [undefined, "http://127.0.0.1:11434"],
    ["", "http://127.0.0.1:11434"],
    ["   ", "http://127.0.0.1:11434"],
    ["127.0.0.1", "http://127.0.0.1:11434"],
    ["localhost", "http://localhost:11434"],
    ["localhost:8080", "http://localhost:8080"],
    [":9000", "http://127.0.0.1:9000"],
    ["0.0.0.0", "http://127.0.0.1:11434"],
    ["0.0.0.0:11500", "http://127.0.0.1:11500"],
    ["http://gpu-box:11434", "http://gpu-box:11434"],
    ["http://gpu-box", "http://gpu-box:11434"],
    ["http://gpu-box:80", "http://gpu-box"],
    ["https://ollama.example.com", "https://ollama.example.com"],
    ["http://127.0.0.1:11434/", "http://127.0.0.1:11434"],
    ["http://[::1]:11434", "http://[::1]:11434"],
  ])("%j -> %s", (input, expected) => {
    expect(normalizeOllamaHost(input)).toBe(expected);
  });

  it("the default constant is what an unset value gives", () => {
    expect(normalizeOllamaHost(undefined)).toBe(DEFAULT_OLLAMA_HOST);
  });

  it.each(["ftp://host", "http://", "http://bad host"])(
    "rejects %j with a helpful message",
    (input) => {
      let error: unknown;
      try {
        normalizeOllamaHost(input);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(RagError);
      expect((error as RagError).code).toBe("INVALID_ARGUMENT");
      expect((error as RagError).message).toContain("OLLAMA_HOST");
      expect((error as RagError).message).toContain(DEFAULT_OLLAMA_HOST);
    },
  );
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), init);
}

describe("OllamaHost.listModels", () => {
  it("returns the installed model names", async () => {
    const fetchFn = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        jsonResponse({
          models: [
            { name: "all-minilm:latest", size: 45000000 },
            { name: "llama3.2:latest", size: 2000000000 },
          ],
        }),
      ),
    );
    const host = new OllamaHost("http://127.0.0.1:11434", fetchFn);

    await expect(host.listModels()).resolves.toEqual(["all-minilm:latest", "llama3.2:latest"]);
    expect(fetchFn.mock.calls[0]?.[0]).toBe("http://127.0.0.1:11434/api/tags");
  });

  it("returns an empty list when nothing is installed", async () => {
    const host = new OllamaHost("http://h:1", () => Promise.resolve(jsonResponse({ models: [] })));
    await expect(host.listModels()).resolves.toEqual([]);
  });

  it("wraps a connection failure in PROVIDER_UNAVAILABLE and keeps the cause", async () => {
    const cause = new TypeError("fetch failed");
    const host = new OllamaHost("http://h:1", () => Promise.reject(cause));

    const error = await host.listModels().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RagError);
    expect((error as RagError).code).toBe("PROVIDER_UNAVAILABLE");
    expect((error as RagError).message).toBe("Cannot reach Ollama at http://h:1");
    expect((error as RagError).cause).toBe(cause);
  });

  it("reports an HTTP error status", async () => {
    const host = new OllamaHost("http://h:1", () =>
      Promise.resolve(new Response("nope", { status: 500 })),
    );
    await expect(host.listModels()).rejects.toThrow("answered with HTTP 500");
  });

  it("reports a reply that is not JSON, or not shaped like Ollama's", async () => {
    const notJson = new OllamaHost("http://h:1", () =>
      Promise.resolve(new Response("<html>hi</html>")),
    );
    await expect(notJson.listModels()).rejects.toThrow("not JSON");

    const wrongShape = new OllamaHost("http://h:1", () =>
      Promise.resolve(jsonResponse({ hello: "world" })),
    );
    await expect(wrongShape.listModels()).rejects.toThrow("unexpected response");
  });

  it("always passes an abort signal, so a hung server cannot block forever", async () => {
    const fetchFn = vi.fn<typeof fetch>((_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(jsonResponse({ models: [] }));
    });
    const host = new OllamaHost("http://h:1", fetchFn);
    await host.listModels(new AbortController().signal);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("describes itself for messages", () => {
    const host = new OllamaHost("http://h:1");
    expect(host.name).toBe("Ollama");
    expect(host.hints.pull("all-minilm")).toBe("ollama pull all-minilm");
    expect(host.hints.start).toContain("ollama serve");
  });
});
