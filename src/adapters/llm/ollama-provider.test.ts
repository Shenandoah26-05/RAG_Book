import { describe, expect, it, vi } from "vitest";
import type { ChatDelta, ChatMessage } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { OllamaProvider } from "./ollama-provider.js";

const ask: ChatMessage[] = [{ role: "user", content: "Hi" }];

const text = (content: string): string =>
  `${JSON.stringify({ message: { role: "assistant", content }, done: false })}\n`;
const end = (extra: object = {}): string =>
  `${JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop", ...extra })}\n`;

/** A response whose body arrives in the given pieces (strings or raw bytes). */
function streamed(pieces: (string | Uint8Array)[], init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const piece = pieces[next];
      next += 1;
      if (piece === undefined) controller.close();
      else controller.enqueue(typeof piece === "string" ? encoder.encode(piece) : piece);
    },
  });
  return new Response(body, init);
}

const provider = (fetchFn: typeof fetch, extra: object = {}): OllamaProvider =>
  new OllamaProvider({ address: "http://h:1", model: "llama3.2", fetch: fetchFn, ...extra });

function sentBody(init: RequestInit | undefined): unknown {
  return JSON.parse(typeof init?.body === "string" ? init.body : "null");
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

describe("OllamaProvider: the reply", () => {
  it("streams text events and one end event", async () => {
    const p = provider(() =>
      Promise.resolve(
        streamed([text("Hel"), text("lo"), end({ prompt_eval_count: 7, eval_count: 2 })]),
      ),
    );
    expect(await collect(p.chat(ask))).toEqual([
      { kind: "text", text: "Hel" },
      { kind: "text", text: "lo" },
      { kind: "end", reason: "stop", promptTokens: 7, outputTokens: 2 },
    ]);
  });

  it("reports that the output limit was reached", async () => {
    const p = provider(() =>
      Promise.resolve(streamed([text("a"), end({ done_reason: "length" })])),
    );
    expect((await collect(p.chat(ask))).at(-1)).toEqual({ kind: "end", reason: "length" });
  });

  it("puts lines back together when a network chunk cuts them anywhere", async () => {
    const whole = text("one") + text("two") + end();
    const cuts = Array.from(whole); // one character per chunk
    const p = provider(() => Promise.resolve(streamed(cuts)));
    const events = await collect(p.chat(ask));
    expect(events.map((e) => (e.kind === "text" ? e.text : "END"))).toEqual(["one", "two", "END"]);
  });

  it("does not break a multi-byte character cut between two chunks", async () => {
    const bytes = new TextEncoder().encode(text("héllo €"));
    const middle = bytes.indexOf(0xc3) + 1; // between the two bytes of "é"
    const p = provider(() =>
      Promise.resolve(
        streamed([bytes.slice(0, middle), bytes.slice(middle), new TextEncoder().encode(end())]),
      ),
    );
    const joined = (await collect(p.chat(ask)))
      .map((e) => (e.kind === "text" ? e.text : ""))
      .join("");
    expect(joined).toBe("héllo €");
  });

  it("accepts a final line without a newline and skips empty content", async () => {
    const p = provider(() => Promise.resolve(streamed([text(""), text("a"), end().trimEnd()])));
    expect((await collect(p.chat(ask))).map((e) => e.kind)).toEqual(["text", "end"]);
  });
});

describe("OllamaProvider: the request", () => {
  it("posts the conversation with streaming on and the configured options", async () => {
    const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(streamed([end()])));
    const p = provider(fetchFn, { temperature: 0.1, maxOutputTokens: 256 });
    await collect(
      p.chat([
        { role: "system", content: "Be brief." },
        { role: "user", content: "Q" },
      ]),
    );

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("http://h:1/api/chat");
    expect(init?.method).toBe("POST");
    expect(sentBody(init)).toEqual({
      model: "llama3.2",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Q" },
      ],
      stream: true,
      options: { temperature: 0.1, num_predict: 256 },
    });
  });

  it("lets a call override the provider's options, and omits what is not set", async () => {
    const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(streamed([end()])));
    await collect(provider(fetchFn, { temperature: 0.1 }).chat(ask, { temperature: 0 }));
    await collect(provider(fetchFn).chat(ask));
    const options = (i: number): unknown =>
      (sentBody(fetchFn.mock.calls[i]?.[1]) as { options: unknown }).options;
    expect(options(0)).toEqual({ temperature: 0 });
    expect(options(1)).toEqual({});
  });

  it("rejects an empty conversation on the first read", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const error = await failureOf(provider(fetchFn).chat([]));
    expect((error as RagError).code).toBe("INVALID_ARGUMENT");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses bad settings when created", () => {
    const make = (extra: object): OllamaProvider =>
      new OllamaProvider({ address: "http://h:1", model: "m", ...extra });
    expect(() => make({ maxOutputTokens: 0 })).toThrow(RagError);
    expect(() => make({ temperature: -1 })).toThrow(RagError);
    expect(() => make({ idleTimeoutMs: 0 })).toThrow(RagError);
  });
});

describe("OllamaProvider: failures", () => {
  it("wraps a connection failure in PROVIDER_UNAVAILABLE and keeps the cause", async () => {
    const cause = new TypeError("fetch failed");
    const error = await failureOf(provider(() => Promise.reject(cause)).chat(ask));
    expect((error as RagError).code).toBe("PROVIDER_UNAVAILABLE");
    expect((error as RagError).message).toBe("Cannot reach Ollama at http://h:1");
    expect((error as RagError).cause).toBe(cause);
  });

  it("tells the user to pull a model that is not installed", async () => {
    const p = provider(() =>
      Promise.resolve(new Response('{"error":"model not found"}', { status: 404 })),
    );
    expect(((await failureOf(p.chat(ask))) as RagError).message).toContain(
      "Run: ollama pull llama3.2",
    );
  });

  it("reports another HTTP error with its status", async () => {
    const p = provider(() => Promise.resolve(new Response("boom", { status: 500 })));
    expect(((await failureOf(p.chat(ask))) as RagError).message).toContain("HTTP 500");
  });

  it("reports an error line in the middle of a reply, after the text before it was passed on", async () => {
    const p = provider(() =>
      Promise.resolve(streamed([text("par"), `${JSON.stringify({ error: "out of memory" })}\n`])),
    );
    const seen: ChatDelta[] = [];
    let error: unknown;
    try {
      for await (const delta of p.chat(ask)) seen.push(delta);
    } catch (e) {
      error = e;
    }
    expect(seen).toEqual([{ kind: "text", text: "par" }]);
    expect((error as RagError).code).toBe("PROVIDER_UNAVAILABLE");
    expect((error as RagError).message).toContain("out of memory");
  });

  it("reports a reply that is not JSON, or not shaped like Ollama's", async () => {
    const notJson = provider(() => Promise.resolve(streamed(["<html>hi</html>\n"])));
    expect(((await failureOf(notJson.chat(ask))) as RagError).message).toContain("not JSON");
    const wrongShape = provider(() => Promise.resolve(streamed(['{"done":"yes"}\n'])));
    expect(((await failureOf(wrongShape.chat(ask))) as RagError).message).toContain(
      "unexpected response",
    );
  });

  it("reports a stream that closes before the reply is done", async () => {
    const p = provider(() => Promise.resolve(streamed([text("half")])));
    expect(((await failureOf(p.chat(ask))) as RagError).message).toContain("before the reply");
  });

  it("gives up when the server stays silent for longer than the idle timeout", async () => {
    const hanging = (_url: unknown, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const p = provider(hanging, { idleTimeoutMs: 20 });
    const error = await failureOf(p.chat(ask));
    expect((error as RagError).code).toBe("PROVIDER_UNAVAILABLE");
    expect((error as RagError).message).toContain("sent nothing for 20 ms");
  });
});

describe("OllamaProvider: cancelling", () => {
  it("never starts a request when the signal is already aborted", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort();
    const error = await failureOf(provider(fetchFn).chat(ask, { signal: controller.signal }));
    expect((error as Error).name).toBe("AbortError");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("stops in the middle of a reply and throws the signal's reason", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(encoder.encode(text(`t${sent.toString()}`)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchFn = vi.fn<typeof fetch>((_url, init) => {
      init?.signal?.addEventListener("abort", () => {
        // a real fetch errors the body stream on abort
      });
      return Promise.resolve(new Response(body));
    });
    const controller = new AbortController();
    const seen: string[] = [];
    let error: unknown;
    try {
      for await (const delta of provider(fetchFn).chat(ask, { signal: controller.signal })) {
        if (delta.kind === "text") seen.push(delta.text);
        if (seen.length === 2) controller.abort();
      }
    } catch (e) {
      error = e;
    }
    expect((error as Error).name).toBe("AbortError");
    expect(seen).toHaveLength(2);
    expect(cancelled).toBe(true);
  });

  it("closes the connection when the caller breaks out of the loop", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode(text("x")));
      },
      cancel() {
        cancelled = true;
      },
    });
    const p = provider(() => Promise.resolve(new Response(body)));
    for await (const delta of p.chat(ask)) {
      expect(delta.kind).toBe("text");
      break;
    }
    expect(cancelled).toBe(true);
  });
});
