import { describe, expect, it, vi } from "vitest";
import type { ChatDelta, ChatMessage } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { describeLlmProviderContract } from "../../testing/llm-provider-contract.testing.js";
import type { Script } from "../../testing/llm-provider-contract.testing.js";
import { OpenAiEndpoint } from "../openai-compatible/index.js";
import { OpenAiChatProvider } from "./openai-chat-provider.js";

const KEY = "sk-test-SECRET-1234567890";
const ask: ChatMessage[] = [{ role: "user", content: "Hi" }];

const event = (value: object): string => `data: ${JSON.stringify(value)}\n\n`;
const delta = (content: string): string =>
  event({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const finish = (reason = "stop"): string =>
  event({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const usage = (promptTokens: number, completionTokens: number): string =>
  event({
    choices: [],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  });
const DONE = "data: [DONE]\n\n";

/** The wire format of the contract's scripts. */
function encode(script: Script): string[] {
  const pieces = script.texts.map(delta);
  const { ending } = script;
  if (ending.kind === "end") {
    pieces.push(finish(ending.reason));
    if (ending.outputTokens !== undefined) pieces.push(usage(1, ending.outputTokens));
    pieces.push(DONE);
  } else if (ending.kind === "error") {
    pieces.push(event({ error: { message: ending.message } }));
  }
  return pieces;
}

const endpoint = (apiKey: string | null = KEY): OpenAiEndpoint =>
  new OpenAiEndpoint({ baseUrl: "http://h:1/v1", ...(apiKey === null ? {} : { apiKey }) });

const make = (fetchFn: typeof fetch, extra: object = {}): OpenAiChatProvider =>
  new OpenAiChatProvider({ endpoint: endpoint(), model: "gpt-test", fetch: fetchFn, ...extra });

describeLlmProviderContract("OpenAiChatProvider", { make: (fetchFn) => make(fetchFn), encode });

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

const reply =
  (...pieces: (string | Uint8Array)[]): typeof fetch =>
  () =>
    Promise.resolve(streamed(pieces));

async function collect(stream: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const out: ChatDelta[] = [];
  for await (const d of stream) out.push(d);
  return out;
}

async function failureOf(stream: AsyncIterable<ChatDelta>): Promise<RagError> {
  try {
    await collect(stream);
  } catch (error) {
    return error as RagError;
  }
  throw new Error("expected a failure");
}

const textOf = (events: ChatDelta[]): string =>
  events.map((e) => (e.kind === "text" ? e.text : "")).join("");

describe("OpenAiChatProvider: the reply", () => {
  it("takes the token counts from the usage chunk that follows the finish reason", async () => {
    const events = await collect(make(reply(delta("Hi"), finish(), usage(7, 2), DONE)).chat(ask));
    expect(events).toEqual([
      { kind: "text", text: "Hi" },
      { kind: "end", reason: "stop", promptTokens: 7, outputTokens: 2 },
    ]);
  });

  it("maps every finish reason but length to stop", async () => {
    for (const reason of ["stop", "content_filter", "tool_calls"]) {
      const events = await collect(make(reply(delta("a"), finish(reason), DONE)).chat(ask));
      expect(events.at(-1)).toEqual({ kind: "end", reason: "stop" });
    }
  });

  it("ends a reply whose server leaves out [DONE], once a finish reason was seen", async () => {
    const events = await collect(make(reply(delta("a"), finish("length"))).chat(ask));
    expect(events.at(-1)).toEqual({ kind: "end", reason: "length" });
  });

  it("puts events back together when a network chunk cuts them anywhere", async () => {
    const whole = delta("one") + delta("two") + finish() + DONE;
    const events = await collect(make(reply(...Array.from(whole))).chat(ask));
    expect(textOf(events)).toBe("onetwo");
    expect(events.at(-1)?.kind).toBe("end");
  });

  it("does not break a multi-byte character cut between two chunks", async () => {
    const bytes = new TextEncoder().encode(delta("héllo €"));
    const middle = bytes.indexOf(0xc3) + 1; // between the two bytes of "é"
    const events = await collect(
      make(
        reply(
          bytes.slice(0, middle),
          bytes.slice(middle),
          new TextEncoder().encode(finish() + DONE),
        ),
      ).chat(ask),
    );
    expect(textOf(events)).toBe("héllo €");
  });

  it("copes with CRLF line ends, comments, other fields and null content", async () => {
    const events = await collect(
      make(
        reply(
          ": keep-alive\r\n\r\n",
          "event: message\r\n",
          delta("a").replaceAll("\n", "\r\n"),
          event({ choices: [{ delta: { content: null, role: "assistant" } }] }),
          event({ choices: [] }),
          finish().replaceAll("\n", "\r\n"),
          "data: [DONE]\r\n\r\n",
        ),
      ).chat(ask),
    );
    expect(events).toEqual([
      { kind: "text", text: "a" },
      { kind: "end", reason: "stop" },
    ]);
  });

  it("stops reading at [DONE]", async () => {
    const events = await collect(
      make(reply(delta("a"), finish(), DONE, "this is not even JSON\n")).chat(ask),
    );
    expect(events.map((e) => e.kind)).toEqual(["text", "end"]);
  });
});

describe("OpenAiChatProvider: the request", () => {
  it("posts the conversation with streaming on, the key and the configured options", async () => {
    const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(streamed([finish(), DONE])));
    const provider = make(fetchFn, { temperature: 0.1, maxOutputTokens: 256 });
    await collect(
      provider.chat([
        { role: "system", content: "Be brief." },
        { role: "user", content: "Q" },
      ]),
    );

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("http://h:1/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: `Bearer ${KEY}`,
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      model: "gpt-test",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Q" },
      ],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.1,
      max_tokens: 256,
    });
  });

  it("lets a call override the provider's options, and omits what is not set", async () => {
    const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(streamed([finish(), DONE])));
    await collect(make(fetchFn, { temperature: 0.1 }).chat(ask, { temperature: 0.9 }));
    await collect(make(fetchFn).chat(ask));
    const bodies = fetchFn.mock.calls.map((c) => JSON.parse(c[1]?.body as string) as object);
    expect(bodies[0]).toMatchObject({ temperature: 0.9 });
    expect(bodies[1]).not.toHaveProperty("temperature");
    expect(bodies[1]).not.toHaveProperty("max_tokens");
  });

  it("sends no Authorization header when there is no key (local servers)", async () => {
    const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(streamed([finish(), DONE])));
    const provider = new OpenAiChatProvider({
      endpoint: endpoint(null),
      model: "m",
      fetch: fetchFn,
    });
    await collect(provider.chat(ask));
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("names the model with the provider prefix", () => {
    expect(make(reply()).modelId).toBe("openai-compatible:gpt-test");
  });

  it("refuses bad settings when created", () => {
    const bad =
      (extra: object): unknown =>
      () =>
        make(reply(), extra);
    expect(bad({ temperature: -1 })).toThrow(/temperature/);
    expect(bad({ maxOutputTokens: 0 })).toThrow(/maxOutputTokens/);
    expect(bad({ idleTimeoutMs: 1.5 })).toThrow(/idleTimeoutMs/);
  });
});

describe("OpenAiChatProvider: failures", () => {
  const failing =
    (status: number, body: string): typeof fetch =>
    () =>
      Promise.resolve(new Response(body, { status }));

  it("keeps the cause of a connection failure", async () => {
    const cause = new TypeError("fetch failed");
    const error = await failureOf(make(() => Promise.reject(cause)).chat(ask));
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error.message).toContain("http://h:1/v1");
    expect(error.cause).toBe(cause);
  });

  it("explains a refused key, differently when there is none", async () => {
    const body = '{"error":{"message":"bad key"}}';
    const withKey = await failureOf(make(failing(401, body)).chat(ask));
    expect(withKey.message).toMatch(/HTTP 401: bad key.*Check OPENAI_API_KEY/);

    const without = new OpenAiChatProvider({
      endpoint: endpoint(null),
      model: "m",
      fetch: failing(401, body),
    });
    expect((await failureOf(without.chat(ask))).message).toMatch(/set OPENAI_API_KEY/);
  });

  it("names the model when the server does not have it", async () => {
    const error = await failureOf(
      make(failing(404, '{"error":{"message":"The model does not exist"}}')).chat(ask),
    );
    expect(error.message).toMatch(/no model "gpt-test".*does not exist/);
  });

  it("reports another HTTP error with its status and falls back to the status text", async () => {
    const error = await failureOf(make(failing(503, "<html>")).chat(ask));
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error.message).toMatch(/HTTP 503/);
  });

  it("reports a reply that is not JSON, or not shaped like an OpenAI chunk", async () => {
    expect((await failureOf(make(reply("data: nope\n\n")).chat(ask))).message).toMatch(/not JSON/);
    expect((await failureOf(make(reply(event({ choices: "x" }))).chat(ask))).message).toMatch(
      /unexpected response/,
    );
  });

  it("gives up when the server stays silent for longer than the idle timeout", async () => {
    vi.useFakeTimers();
    try {
      const silent: typeof fetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        });
      const pending = failureOf(make(silent, { idleTimeoutMs: 50 }).chat(ask));
      await vi.advanceTimersByTimeAsync(60);
      const error = await pending;
      expect(error.code).toBe("PROVIDER_UNAVAILABLE");
      expect(error.message).toMatch(/sent nothing for 50 ms/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OpenAiChatProvider: the key stays secret", () => {
  /** Everything an error could show: message, stack, and each cause, as text. */
  function everythingOf(error: unknown): string {
    const parts: string[] = [];
    for (let e: unknown = error; e instanceof Error; e = e.cause) {
      parts.push(e.message, e.stack ?? "", JSON.stringify(e));
    }
    return parts.join("\n");
  }

  it("removes a key the server echoes in an error body", async () => {
    const echo = `{"error":{"message":"Incorrect API key provided: ${KEY}"}}`;
    const error = await failureOf(
      make(() => Promise.resolve(new Response(echo, { status: 401 }))).chat(ask),
    );
    expect(error.message).toContain("[redacted]");
    expect(everythingOf(error)).not.toContain(KEY);
  });

  it("removes a key the server echoes in an error event in the middle of a reply", async () => {
    const error = await failureOf(
      make(reply(delta("a"), event({ error: { message: `bad ${KEY}` } }))).chat(ask),
    );
    expect(error.message).toContain("[redacted]");
    expect(everythingOf(error)).not.toContain(KEY);
  });

  it("leaves the key out of every other failure", async () => {
    const cases: (typeof fetch)[] = [
      () => Promise.reject(new TypeError("fetch failed")),
      reply("data: nope\n\n"),
      reply(delta("a")),
      () => Promise.resolve(new Response("x", { status: 500 })),
    ];
    for (const fetchFn of cases) {
      expect(everythingOf(await failureOf(make(fetchFn).chat(ask)))).not.toContain(KEY);
    }
  });

  it("does not show the key when the provider itself is printed or serialised", () => {
    const provider = make(reply());
    expect(JSON.stringify(provider)).not.toContain(KEY);
    expect(JSON.stringify(endpoint())).not.toContain(KEY);
    expect(String(Object.keys(provider))).not.toContain(KEY);
  });
});
