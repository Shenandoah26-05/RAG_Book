import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, resolveConfig } from "./index.js";

describe("the resilience section", () => {
  it("retries what may pass and gives up on silence by default, with no rate limit", () => {
    const { generation, embedding } = DEFAULT_CONFIG.resilience;
    expect(generation).toMatchObject({ retries: 2, requestsPerMinute: 0, maxConcurrent: 0 });
    expect(embedding).toMatchObject({ retries: 2, requestsPerMinute: 0, maxConcurrent: 0 });
    // a model that is still loading says nothing for a while, so the default is patient
    expect(generation.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  it("is set per kind, from a file, the environment and the command line", () => {
    const config = resolveConfig({
      file: { resilience: { generation: { retries: 0, requestsPerMinute: 60 } } },
      env: { RAG_RESILIENCE__EMBEDDING__MAX_CONCURRENT: "2" },
      argv: ["--resilience.generation.timeout-ms", "5000"],
    });
    expect(config.resilience.generation).toMatchObject({
      retries: 0,
      requestsPerMinute: 60,
      timeoutMs: 5000,
    });
    expect(config.resilience.embedding.maxConcurrent).toBe(2);
    // the rest keeps its default
    expect(config.resilience.embedding.retries).toBe(2);
  });

  it("takes 0 to mean off", () => {
    const config = resolveConfig({
      file: {
        resilience: {
          generation: { retries: 0, timeoutMs: 0, requestsPerMinute: 0, maxConcurrent: 0 },
        },
      },
    });
    expect(config.resilience.generation.timeoutMs).toBe(0);
  });

  it.each([
    [{ resilience: { generation: { retries: -1 } } }, /resilience\.generation\.retries/],
    [{ resilience: { generation: { retries: 1.5 } } }, /whole number/],
    [{ resilience: { embedding: { timeoutMs: "slow" } } }, /resilience\.embedding\.timeoutMs/],
    [{ resilience: { generation: { backoffMs: 9000, maxBackoffMs: 100 } } }, /at least backoffMs/],
    [{ resilience: { generation: { retrys: 3 } } }, /retrys/],
    [{ resilience: { network: {} } }, /network/],
  ])("rejects %j", (file, message) => {
    expect(() => resolveConfig({ file })).toThrow(message);
  });
});
