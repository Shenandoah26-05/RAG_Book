import { describe, expect, it } from "vitest";
import type { PriceTable, UsageEntry } from "../shared/index.js";
import { describeUsage, formatMoney, hasPrices } from "./usage-format.js";

const call = (overrides: Partial<UsageEntry> = {}): UsageEntry => ({
  kind: "model",
  modelId: "openai-compatible:cheap",
  promptTokens: 1000,
  outputTokens: 500,
  estimated: false,
  latencyMs: 1500,
  firstTokenMs: 200,
  ok: true,
  ...overrides,
});
const NO_PRICES: PriceTable = { currency: "USD", models: {} };
const PRICES: PriceTable = {
  currency: "USD",
  models: { "openai-compatible:cheap": { inputPerMillion: 0.15, outputPerMillion: 0.6 } },
};

describe("formatMoney", () => {
  it.each([
    [0, "0"],
    [1.239, "1.24"],
    [0.01, "0.01"],
    [0.00045, "0.00045"],
    [0.0000004, "0"],
    [0.1, "0.10"],
    [12, "12.00"],
  ])("writes %s as %s", (amount, text) => {
    expect(formatMoney(amount)).toBe(text);
  });

  it("shows a fraction of a cent, which is what one answer costs", () => {
    expect(formatMoney(0.000123)).toBe("0.000123");
  });
});

describe("hasPrices", () => {
  it("is true only when the table lists a model", () => {
    expect(hasPrices(NO_PRICES)).toBe(false);
    expect(hasPrices(PRICES)).toBe(true);
  });
});

describe("describeUsage", () => {
  it("says nothing when nothing was metered", () => {
    expect(describeUsage([], PRICES)).toBeUndefined();
  });

  it("gives calls, tokens and time, and no money when there are no prices", () => {
    expect(
      describeUsage(
        [call(), call({ promptTokens: 234, outputTokens: 12, latencyMs: 900 })],
        NO_PRICES,
      ),
    ).toBe("Usage: 2 model calls: 1,234 tokens in, 512 out; 2.4 s with the models");
  });

  it("adds the cost when there are prices: hand-computed", () => {
    // 1,000 in at 0.15 per million and 500 out at 0.60 per million: 0.00015 + 0.0003
    expect(describeUsage([call()], PRICES)).toBe(
      "Usage: 1 model call: 1,000 tokens in, 500 out; 1.5 s with the models; cost 0.00045 USD",
    );
  });

  it("says how many tokens have no price when some model is missing from the table", () => {
    const text = describeUsage(
      [call(), call({ modelId: "ollama:local", promptTokens: 300, outputTokens: 20 })],
      PRICES,
    );
    expect(text).toContain("cost 0.00045 USD (320 tokens have no price)");
  });

  it("counts embeddings apart from model calls, as an estimate", () => {
    const text = describeUsage(
      [call(), call({ kind: "embed", promptTokens: 25, outputTokens: undefined, latencyMs: 100 })],
      NO_PRICES,
    );
    expect(text).toContain("1 model call: 1,000 tokens in, 500 out");
    expect(text).toContain("1 embedding call: about 25 tokens");
  });

  it("owns up to calls that reported no tokens and calls that did not finish", () => {
    const text = describeUsage(
      [call({ promptTokens: undefined, outputTokens: undefined }), call({ ok: false })],
      NO_PRICES,
    );
    expect(text).toContain("1 call reported no tokens");
    expect(text).toContain("1 did not finish");
  });
});
