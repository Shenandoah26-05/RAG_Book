import { describe, expect, it } from "vitest";
import { DEFAULT_OPENAI_BASE_URL, OpenAiEndpoint } from "./openai-endpoint.js";

const KEY = "sk-test-SECRET-1234567890";

describe("OpenAiEndpoint", () => {
  it("defaults to OpenAI and has no key when the environment is empty", () => {
    const endpoint = OpenAiEndpoint.fromEnv({});
    expect(endpoint.baseUrl).toBe(DEFAULT_OPENAI_BASE_URL);
    expect(endpoint.hasKey).toBe(false);
    expect(endpoint.headers()).toEqual({ "Content-Type": "application/json" });
  });

  it("reads the base URL and the key from the environment", () => {
    const endpoint = OpenAiEndpoint.fromEnv({
      OPENAI_BASE_URL: "http://localhost:1234/v1/",
      OPENAI_API_KEY: KEY,
    });
    expect(endpoint.url("/embeddings")).toBe("http://localhost:1234/v1/embeddings");
    expect(endpoint.headers().Authorization).toBe(`Bearer ${KEY}`);
  });

  it("treats an empty or blank key and URL as not set", () => {
    const endpoint = OpenAiEndpoint.fromEnv({ OPENAI_BASE_URL: " ", OPENAI_API_KEY: "  " });
    expect(endpoint.baseUrl).toBe(DEFAULT_OPENAI_BASE_URL);
    expect(endpoint.hasKey).toBe(false);
  });

  it.each([
    ["not a url", /cannot be parsed/],
    ["ftp://host/v1", /must be http or https/],
    ["https://user:pw@host/v1", /not in the URL/],
  ])("rejects the base URL %j", (baseUrl, message) => {
    expect(() => new OpenAiEndpoint({ baseUrl })).toThrow(message);
  });

  it("does not repeat a rejected URL in the error (it may hold a password)", () => {
    let message = "";
    try {
      new OpenAiEndpoint({ baseUrl: "https://user:hunter2@host/v1" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("hunter2");
  });

  it("replaces the key wherever it appears in a text", () => {
    const endpoint = new OpenAiEndpoint({ baseUrl: "http://h/v1", apiKey: KEY });
    expect(endpoint.redact(`bad ${KEY} and ${KEY}`)).toBe("bad [redacted] and [redacted]");
    expect(new OpenAiEndpoint({ baseUrl: "http://h/v1" }).redact("same")).toBe("same");
  });

  it("keeps the key out of serialisation and inspection", () => {
    const endpoint = new OpenAiEndpoint({ baseUrl: "http://h/v1", apiKey: KEY });
    expect(JSON.stringify(endpoint)).not.toContain(KEY);
    expect(Object.values(endpoint)).not.toContain(KEY);
  });
});
