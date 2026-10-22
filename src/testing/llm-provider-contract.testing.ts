// The contract every LlmProvider must meet (see core/ports/llm-provider.ts). Used by each provider's
// own test through `describeLlmProviderContract`. Not part of the build.
//
// Providers speak different wire formats (JSON lines, server-sent events), so the contract does not
// send bytes itself. It describes a reply as a `Script` and asks the provider's test to `encode` it
// in that provider's format; the contract then serves those pieces through a fake `fetch`, which
// also lets it see whether the connection was closed.
import { describe, expect, it } from "vitest";
import type { ChatDelta, ChatMessage, LlmProvider } from "../core/index.js";
import { RagError } from "../shared/index.js";

/** A reply, independent of the wire format. */
export interface Script {
  /** The pieces of text, in order. */
  readonly texts: readonly string[];
  /** How the reply ends: normally, with an error line, or not at all (the stream just closes). */
  readonly ending:
    | { readonly kind: "end"; readonly reason: "stop" | "length"; readonly outputTokens?: number }
    | { readonly kind: "error"; readonly message: string }
    | { readonly kind: "closed" };
}

export interface LlmProviderHarness {
  /** The provider under test, talking through `fetchFn`. */
  readonly make: (fetchFn: typeof fetch) => LlmProvider;
  /** The pieces of the response body that carry `script`, in this provider's wire format. */
  readonly encode: (script: Script) => readonly string[];
}

const ask: readonly ChatMessage[] = [{ role: "user", content: "Hi" }];

/** A fake server: records requests and whether the body was closed, optionally never finishing. */
function server(harness: LlmProviderHarness, script: Script, options: { hang?: boolean } = {}) {
  const seen = { requests: 0, cancelled: false };
  const encoder = new TextEncoder();
  const fetchFn: typeof fetch = (_url, init) => {
    seen.requests += 1;
    const pieces = harness.encode(script);
    let next = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const piece = pieces[next];
        next += 1;
        if (piece !== undefined) {
          controller.enqueue(encoder.encode(piece));
          return undefined;
        }
        if (options.hang !== true) {
          controller.close();
          return undefined;
        }
        // stay open until the request is cancelled, like a model that is still writing
        return new Promise<void>((resolve) => {
          init?.signal?.addEventListener("abort", () => {
            resolve();
          });
        });
      },
      cancel() {
        seen.cancelled = true;
      },
    });
    return Promise.resolve(new Response(body));
  };
  return { fetchFn, seen };
}

async function collect(stream: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const out: ChatDelta[] = [];
  for await (const delta of stream) out.push(delta);
  return out;
}

async function failureOf(stream: AsyncIterable<ChatDelta>): Promise<unknown> {
  try {
    await collect(stream);
  } catch (error) {
    return error;
  }
  return undefined;
}

const normal: Script = {
  texts: ["Hel", "lo"],
  ending: { kind: "end", reason: "stop", outputTokens: 2 },
};

/** Registers the contract tests for an LLM provider. Call it from the provider's own test file. */
export function describeLlmProviderContract(name: string, harness: LlmProviderHarness): void {
  describe(`${name} meets the LlmProvider contract`, () => {
    it("has a model id", () => {
      expect(harness.make(server(harness, normal).fetchFn).modelId).not.toBe("");
    });

    it("streams text events (never empty) followed by exactly one end event", async () => {
      const { fetchFn } = server(harness, { texts: ["", "Hel", "lo"], ending: normal.ending });
      const events = await collect(harness.make(fetchFn).chat(ask));
      expect(events.map((e) => e.kind)).toEqual(["text", "text", "end"]);
      const joined = events.map((e) => (e.kind === "text" ? e.text : "")).join("");
      expect(joined).toBe("Hello");
      for (const e of events) if (e.kind === "text") expect(e.text).not.toBe("");
    });

    it("reports that the output limit was reached", async () => {
      const { fetchFn } = server(harness, {
        texts: ["a"],
        ending: { kind: "end", reason: "length" },
      });
      const events = await collect(harness.make(fetchFn).chat(ask));
      expect(events.at(-1)).toMatchObject({ kind: "end", reason: "length" });
    });

    it("rejects an empty conversation with INVALID_ARGUMENT, without a request", async () => {
      const { fetchFn, seen } = server(harness, normal);
      const error = await failureOf(harness.make(fetchFn).chat([]));
      expect(error).toBeInstanceOf(RagError);
      expect((error as RagError).code).toBe("INVALID_ARGUMENT");
      expect(seen.requests).toBe(0);
    });

    it("rejects with PROVIDER_UNAVAILABLE when the server cannot be reached", async () => {
      const down: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));
      const error = await failureOf(harness.make(down).chat(ask));
      expect(error).toBeInstanceOf(RagError);
      expect((error as RagError).code).toBe("PROVIDER_UNAVAILABLE");
    });

    it("rejects with PROVIDER_UNAVAILABLE on an HTTP error", async () => {
      const broken: typeof fetch = () =>
        Promise.resolve(new Response('{"error":{"message":"boom"}}', { status: 500 }));
      const error = await failureOf(harness.make(broken).chat(ask));
      expect((error as RagError).code).toBe("PROVIDER_UNAVAILABLE");
    });

    it("fails with PROVIDER_UNAVAILABLE in the middle of a reply, after passing on earlier text", async () => {
      const { fetchFn } = server(harness, {
        texts: ["partial"],
        ending: { kind: "error", message: "model crashed" },
      });
      const seen: ChatDelta[] = [];
      let error: unknown;
      try {
        for await (const delta of harness.make(fetchFn).chat(ask)) seen.push(delta);
      } catch (caught) {
        error = caught;
      }
      expect(seen).toEqual([{ kind: "text", text: "partial" }]);
      expect((error as RagError).code).toBe("PROVIDER_UNAVAILABLE");
    });

    it("fails with PROVIDER_UNAVAILABLE when the stream closes before the reply is done", async () => {
      const { fetchFn } = server(harness, { texts: ["a"], ending: { kind: "closed" } });
      const error = await failureOf(harness.make(fetchFn).chat(ask));
      expect((error as RagError).code).toBe("PROVIDER_UNAVAILABLE");
    });

    it("never starts a request when the signal is already aborted", async () => {
      const { fetchFn, seen } = server(harness, normal);
      const controller = new AbortController();
      controller.abort();
      const error = await failureOf(harness.make(fetchFn).chat(ask, { signal: controller.signal }));
      expect(error).toBe(controller.signal.reason);
      expect(seen.requests).toBe(0);
    });

    it("throws the signal's reason when aborted in the middle of a reply, and closes the connection", async () => {
      const { fetchFn, seen } = server(
        harness,
        { texts: ["a"], ending: normal.ending },
        { hang: true },
      );
      const controller = new AbortController();
      const events: ChatDelta[] = [];
      let error: unknown;
      try {
        for await (const delta of harness.make(fetchFn).chat(ask, { signal: controller.signal })) {
          events.push(delta);
          controller.abort();
        }
      } catch (caught) {
        error = caught;
      }
      expect(events).toEqual([{ kind: "text", text: "a" }]);
      expect(error).toBe(controller.signal.reason);
      expect(seen.cancelled).toBe(true);
    });

    it("closes the connection when the caller breaks out of the loop", async () => {
      const { fetchFn, seen } = server(
        harness,
        { texts: ["a", "b"], ending: normal.ending },
        { hang: true },
      );
      for await (const delta of harness.make(fetchFn).chat(ask)) {
        expect(delta.kind).toBe("text");
        break;
      }
      expect(seen.cancelled).toBe(true);
    });
  });
}
