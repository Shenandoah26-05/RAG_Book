import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config/index.js";
import type { RagConfig } from "../config/index.js";
import type { Embedder } from "../core/index.js";
import { RagError, createJsonLogger } from "../shared/index.js";
import { RetryingEmbedder, RetryingProvider } from "../strategies/index.js";
import { FakeClock, settle } from "../testing/fake-clock.testing.js";
import {
  end,
  read,
  scriptedEmbedder,
  scriptedProvider,
  settled,
  text,
  transient,
} from "../strategies/resilience/resilience.testing.js";
import { Resilience } from "./build-resilience.js";

const OFF = {
  retries: 0,
  backoffMs: 0,
  maxBackoffMs: 0,
  timeoutMs: 0,
  requestsPerMinute: 0,
  maxConcurrent: 0,
};
const config = (
  generation: Partial<typeof OFF> = {},
  embedding: Partial<typeof OFF> = {},
): RagConfig["resilience"] => ({
  generation: { ...OFF, ...generation },
  embedding: { ...OFF, ...embedding },
});
const messages = [{ role: "user", content: "hi" }] as const;

describe("Resilience", () => {
  it("adds no wrapper when everything is off", () => {
    const resilience = new Resilience(config());
    const llm = scriptedProvider([{ events: [end] }]);
    const embedder = scriptedEmbedder(["ok"]);
    expect(resilience.llm(llm)).toBe(llm);
    expect(resilience.embedder(embedder)).toBe(embedder);
  });

  it("adds only the layers that are on", () => {
    const resilience = new Resilience(config({ retries: 2 }, { timeoutMs: 100 }));
    expect(resilience.llm(scriptedProvider([]))).toBeInstanceOf(RetryingProvider);
    // an embedder with only a timeout is not retrying
    expect(resilience.embedder(scriptedEmbedder([]))).not.toBeInstanceOf(RetryingEmbedder);
  });

  it("keeps the model id and the vector length of what it wraps", () => {
    const resilience = new Resilience(
      config(
        { retries: 1, backoffMs: 1, maxBackoffMs: 1 },
        { retries: 1, backoffMs: 1, maxBackoffMs: 1 },
      ),
    );
    expect(resilience.llm(scriptedProvider([])).modelId).toBe("fake:model");
    const embedder = resilience.embedder(scriptedEmbedder(["ok"]));
    expect([embedder.modelId, embedder.dimensions]).toEqual(["fake:embed", 2]);
  });

  describe("composed", () => {
    it("retries a failure that may pass, and logs it with the model", async () => {
      const clock = new FakeClock();
      const lines: string[] = [];
      const logger = createJsonLogger({ write: (l) => lines.push(l), level: "warn" });
      const resilience = new Resilience(
        config({ retries: 2, backoffMs: 100, maxBackoffMs: 1000 }),
        { clock, logger, random: () => 1 },
      );
      const inner = scriptedProvider([{ fail: transient("down") }, { events: [text("ok"), end] }]);
      const outcome = await settled(read(resilience.llm(inner).chat(messages)), () =>
        clock.advance(5000),
      );
      expect(outcome.value).toEqual(["ok"]);
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({ target: "fake:model", waitMs: 100 });
    });

    it("counts every attempt, a retry included, against the rate limit", async () => {
      const clock = new FakeClock();
      const resilience = new Resilience(
        config({ retries: 1, backoffMs: 10, maxBackoffMs: 10, requestsPerMinute: 1 }),
        { clock, random: () => 0 },
      );
      const inner = scriptedProvider([{ fail: transient() }, { events: [text("ok"), end] }]);
      const outcome = settled(read(resilience.llm(inner).chat(messages)), async () => {
        await clock.advance(100);
        // the first attempt took the only turn this minute, so the retry has to wait for the next one
        expect(inner.calls).toHaveLength(1);
        await clock.advance(60_000);
      });
      expect((await outcome).value).toEqual(["ok"]);
      expect(inner.calls).toHaveLength(2);
    });

    it("does not count time spent waiting for a turn against the timeout", async () => {
      const clock = new FakeClock();
      const resilience = new Resilience(config({ timeoutMs: 1000, requestsPerMinute: 1 }), {
        clock,
      });
      const llm = resilience.llm(scriptedProvider([{ events: [text("ok"), end] }]));
      await read(llm.chat(messages));
      // the second call waits a minute for its turn, sixty times the timeout, and still works
      const outcome = await settled(read(llm.chat(messages)), () => clock.advance(60_000));
      expect(outcome.value).toEqual(["ok"]);
    });

    it("applies the timeout to each attempt on its own", async () => {
      const clock = new FakeClock();
      const resilience = new Resilience(
        config({ retries: 1, backoffMs: 10, maxBackoffMs: 10, timeoutMs: 1000 }),
        { clock, random: () => 0 },
      );
      const inner = scriptedProvider([{ hang: true }, { events: [text("second try"), end] }]);
      const outcome = await settled(read(resilience.llm(inner).chat(messages)), async () => {
        await clock.advance(1000); // the first attempt times out
        await clock.advance(10); // the wait before the retry
        await settle();
      });
      expect(outcome.value).toEqual(["second try"]);
      expect(inner.calls).toHaveLength(2);
    });

    it("shares one limit between every model it wraps, and keeps embedders apart", async () => {
      const clock = new FakeClock();
      const resilience = new Resilience(config({ maxConcurrent: 1 }, { maxConcurrent: 1 }), {
        clock,
      });
      const a = resilience.llm(scriptedProvider([{ events: [text("a"), text("b"), end] }]));
      const b = resilience.llm(scriptedProvider([{ events: [text("c"), end] }]));
      const holding = a.chat(messages)[Symbol.asyncIterator]();
      await holding.next();

      let bDone = false;
      const waiting = read(b.chat(messages)).then(() => {
        bDone = true;
      });
      await settle();
      expect(bDone).toBe(false); // the same service: one turn for both

      // an embedder is another service with its own turn
      expect(
        await resilience.embedder(scriptedEmbedder(["ok"])).embed(["x"], "query"),
      ).toHaveLength(1);

      await holding.return?.();
      await waiting;
      expect(bDone).toBe(true);
    });

    it("surfaces a permanent failure at once", async () => {
      const resilience = new Resilience(config({ retries: 3, backoffMs: 1, maxBackoffMs: 1 }));
      const error = new RagError("PROVIDER_UNAVAILABLE", "no such model", { retryable: false });
      const inner = scriptedProvider([{ fail: error }]);
      await expect(read(resilience.llm(inner).chat(messages))).rejects.toBe(error);
      expect(inner.calls).toHaveLength(1);
    });
  });

  it("works with the defaults of the project", () => {
    const resilience = new Resilience(DEFAULT_CONFIG.resilience);
    expect(resilience.llm(scriptedProvider([]))).toBeInstanceOf(RetryingProvider);
    const embedder: Embedder = resilience.embedder(scriptedEmbedder(["ok"]));
    expect(embedder).toBeInstanceOf(RetryingEmbedder);
  });
});
