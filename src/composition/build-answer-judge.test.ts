import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../config/index.js";
import type { LlmProvider } from "../core/index.js";
import { buildAnswerJudge } from "./build-answer-judge.js";

const config = {
  generation: DEFAULT_CONFIG.generation,
  judge: { provider: "ollama", model: "judge-model", maxOutputTokens: 300 },
};

describe("buildAnswerJudge", () => {
  it("builds the judge from judge.*, not from generation.*", () => {
    const judge = buildAnswerJudge(config);
    expect(judge.modelId).toBe("ollama:judge-model");
    expect(judge.modelId).not.toContain(DEFAULT_CONFIG.generation.model);
  });

  it("uses a model it is given", () => {
    const llm: LlmProvider = { modelId: "fake:x", chat: () => (async function* () {})() };
    expect(buildAnswerJudge(config, { llm }).modelId).toBe("fake:x");
  });

  it("warns when the judge is the generator's model", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
    buildAnswerJudge(
      { ...config, judge: { ...config.judge, model: DEFAULT_CONFIG.generation.model } },
      { logger },
    );
    expect(logger.warn).toHaveBeenCalledOnce();
    buildAnswerJudge(config, { logger });
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("names an unknown provider", () => {
    expect(() =>
      buildAnswerJudge({ ...config, judge: { ...config.judge, provider: "nope" } }),
    ).toThrow(/Unknown provider "nope"/);
  });

  it("names a missing prompt file", () => {
    expect(() => buildAnswerJudge(config, { promptsDir: "does-not-exist" })).toThrow(
      /Cannot read the faithfulness judge prompt/,
    );
  });
});
