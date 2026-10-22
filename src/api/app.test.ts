import {
  chunkResponseSchema,
  errorResponseSchema,
  pageResponseSchema,
  readAskEvents,
  wireTraceSchema,
} from "@rag-book/api-contract";
import type { AskEvent } from "@rag-book/api-contract";
import { describe, expect, it } from "vitest";
import { RagError } from "../shared/index.js";
import { createApp, DEFAULT_ALLOWED_ORIGINS, MAX_BODY_BYTES } from "./app.js";
import {
  BOOK,
  CHUNK,
  DOC,
  OTHER_DOC,
  chunkOf,
  fakeServices,
  groundedAnswer,
} from "./api.testing.js";
import type { FakeServicesOptions } from "./api.testing.js";

const VITE = "http://localhost:5173";

const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

function setup(options: FakeServicesOptions = {}) {
  const services = fakeServices(options);
  return { services, app: createApp(services) };
}

async function events(response: Response): Promise<AskEvent[]> {
  const out: AskEvent[] = [];
  if (response.body === null) throw new Error("no body");
  for await (const event of readAskEvents(response.body)) out.push(event);
  return out;
}

async function errorOf(response: Response) {
  return errorResponseSchema.parse(await response.json()).error;
}

describe("POST /ask", () => {
  it("streams the answer as server-sent events: tokens, then citations, trace and done", async () => {
    const { app } = setup();
    const response = await app.request("/ask", post({ question: "What is an embedding?" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const got = await events(response);
    expect(got.map((e) => e.event)).toEqual([
      "token",
      "token",
      "token",
      "citations",
      "trace",
      "done",
    ]);
  });

  it("sends the pieces of the answer in order, and they join to the answer", async () => {
    const { app } = setup();
    const got = await events(await app.request("/ask", post({ question: "Q?" })));
    const text = got.flatMap((e) => (e.event === "token" ? [e.data.text] : [])).join("");
    expect(text).toBe("Embeddings are vectors [1].");
  });

  it("sends the citations with the page and character span of each source", async () => {
    const { app } = setup();
    const got = await events(await app.request("/ask", post({ question: "Q?" })));
    const citations = got.find((e) => e.event === "citations");
    expect(citations?.data).toMatchObject({
      citations: [
        {
          index: 1,
          chunkId: CHUNK.id,
          docId: DOC,
          pageStart: 1,
          pageEnd: 2,
          charStart: CHUNK.metadata.charStart,
          charEnd: CHUNK.metadata.charEnd,
          quote: "Embeddings map text to vectors.",
        },
      ],
    });
  });

  it("sends a trace that the contract accepts, with the stages the pipeline recorded", async () => {
    const { app } = setup({
      answer: () =>
        groundedAnswer({
          stages: [{ stage: "rerank", summary: { kept: 3, reordered: true } }],
        }),
    });
    const got = await events(await app.request("/ask", post({ question: "Q?" })));
    const trace = got.find((e) => e.event === "trace");
    if (trace?.event !== "trace") throw new Error("no trace event");
    expect(wireTraceSchema.safeParse(trace.data.trace).success).toBe(true);
    expect(trace.data.trace.stages.map((s) => s.stage)).toEqual(["retrieve", "rerank"]);
  });

  it("adds what the answer cost to the trace, with money when there are prices", async () => {
    const model = {
      stage: "model-call",
      summary: {
        model: "openai-compatible:cheap",
        promptTokens: 1000,
        outputTokens: 500,
        completed: true,
      },
    };
    const priced = setup({
      answer: () => groundedAnswer({ stages: [model] }),
      prices: {
        currency: "USD",
        models: { "openai-compatible:cheap": { inputPerMillion: 1, outputPerMillion: 2 } },
      },
    });
    const withMoney = await events(await priced.app.request("/ask", post({ question: "Q?" })));
    const usage = withMoney.flatMap((e) => (e.event === "trace" ? [e.data.trace.usage] : []))[0];
    expect(usage).toMatchObject({ calls: 1, promptTokens: 1000, outputTokens: 500 });
    expect(usage?.cost?.amount).toBeCloseTo(0.002, 12);
    expect(usage?.cost?.currency).toBe("USD");

    const free = setup({ answer: () => groundedAnswer({ stages: [model] }) });
    const noMoney = await events(await free.app.request("/ask", post({ question: "Q?" })));
    const freeUsage = noMoney.flatMap((e) => (e.event === "trace" ? [e.data.trace.usage] : []))[0];
    expect(freeUsage).toBeDefined();
    expect(freeUsage).not.toHaveProperty("cost");
  });

  it("ends with what the guardrails found", async () => {
    const { app } = setup({
      answer: () =>
        groundedAnswer({ grounding: { cited: [1, 3], unknownCitations: [3], complete: true } }),
    });
    const got = await events(await app.request("/ask", post({ question: "Q?" })));
    expect(got.at(-1)).toEqual({
      event: "done",
      data: { answered: true, cited: [1, 3], unknownCitations: [3], complete: true },
    });
  });

  it("says so when the book had nothing to answer with: no citations, and the reason", async () => {
    const { app } = setup({
      answer: () =>
        groundedAnswer({
          pieces: ["I could not find the answer to that in the book."],
          sources: [],
          grounding: { answered: false, refusal: "no-sources", cited: [] },
        }),
    });
    const got = await events(await app.request("/ask", post({ question: "Q?" })));
    expect(got.find((e) => e.event === "citations")?.data).toEqual({ citations: [] });
    expect(got.at(-1)?.data).toMatchObject({ answered: false, refusal: "no-sources" });
  });

  describe("what it asks the pipeline", () => {
    it("passes the question trimmed, and a signal", async () => {
      const { app, services } = setup();
      await app.request("/ask", post({ question: "  What is a vector?  " }));
      expect(services.asked).toHaveLength(1);
      expect(services.asked[0]?.question).toBe("What is a vector?");
      expect(services.asked[0]?.options?.signal).toBeInstanceOf(AbortSignal);
    });

    it("passes k and the history, and leaves out an empty history", async () => {
      const { app, services } = setup();
      const history = [{ question: "What is chunking?", answer: "Splitting a book." }];
      await app.request("/ask", post({ question: "And size?", k: 7, history }));
      await app.request("/ask", post({ question: "Again?", history: [] }));
      expect(services.asked[0]?.options).toMatchObject({ k: 7, history });
      expect(services.asked[1]?.options).not.toHaveProperty("history");
      expect(services.asked[1]?.options).not.toHaveProperty("k");
    });

    it("translates the filter into the library's, one clause for each part", async () => {
      const { app, services } = setup();
      await app.request(
        "/ask",
        post({
          question: "Q?",
          filter: {
            documents: [DOC],
            strategies: ["recursive", "fixed-size"],
            section: ["Chapter 3", "3.2 Embeddings"],
            pages: { from: 10, to: 20 },
          },
        }),
      );
      expect(services.asked[0]?.options?.filter).toEqual([
        { kind: "equals", field: "docId", value: DOC },
        { kind: "in", field: "strategy", values: ["recursive", "fixed-size"] },
        { kind: "section", path: ["Chapter 3", "3.2 Embeddings"] },
        { kind: "pageRange", from: 10, to: 20 },
      ]);
    });

    it("sends no filter for an empty one", async () => {
      const { app, services } = setup();
      await app.request("/ask", post({ question: "Q?", filter: {} }));
      expect(services.asked[0]?.options).not.toHaveProperty("filter");
    });

    it("stops the work when the reader goes away", async () => {
      const { app, services } = setup();
      const reader = new AbortController();
      const pending = app.request("/ask", { ...post({ question: "Q?" }), signal: reader.signal });
      reader.abort();
      await Promise.resolve(pending).catch(() => undefined);
      expect(services.asked[0]?.options?.signal?.aborted).toBe(true);
    });

    it("stops the model in the middle of an answer when the reader goes away", async () => {
      let stopped = false;
      const { app } = setup({
        answer: ({ options }) => {
          const answer = groundedAnswer();
          // a model that has written one piece and then waits for more, until it is told to stop
          const stream = (async function* () {
            yield { kind: "text", text: "The ans" } as const;
            await new Promise<void>((_, reject) => {
              const stop = (): void => {
                stopped = true;
                reject(new Error("aborted"));
              };
              // like an adapter: a signal that is already aborted stops it at once
              if (options?.signal?.aborted === true) stop();
              else options?.signal?.addEventListener("abort", stop, { once: true });
            });
          })();
          return { ...answer, stream };
        },
      });
      const reader = new AbortController();
      const response = await app.request("/ask", {
        ...post({ question: "Q?" }),
        signal: reader.signal,
      });
      const stream = response.body?.getReader();
      await stream?.read(); // the first piece has arrived
      reader.abort();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(stopped).toBe(true);
      await stream?.cancel().catch(() => undefined);
    });
  });

  describe("a request that is not valid", () => {
    it.each([
      ["a blank question", { question: "   " }, "question"],
      ["no question", {}, "question"],
      ["a k that is too big", { question: "Q?", k: 51 }, "k"],
      ["a k of 0", { question: "Q?", k: 0 }, "k"],
      ["an unknown field", { question: "Q?", extra: 1 }, "(body)"],
      [
        "a page range backwards",
        { question: "Q?", filter: { pages: { from: 9, to: 4 } } },
        "filter.pages",
      ],
      [
        "a history entry without an answer",
        { question: "Q?", history: [{ question: "a" }] },
        "history.0.answer",
      ],
    ])("answers %s with 400 and says where", async (_name, body, path) => {
      const { app, services } = setup();
      const response = await app.request("/ask", post(body));
      expect(response.status).toBe(400);
      const error = await errorOf(response);
      expect(error.code).toBe("INVALID_REQUEST");
      expect(error.issues?.map((i) => i.path).join(" ")).toContain(path);
      expect(services.asked).toHaveLength(0);
    });

    it("answers a body that is not JSON with 400", async () => {
      const { app } = setup();
      const response = await app.request("/ask", post("{not json"));
      expect(response.status).toBe(400);
      expect((await errorOf(response)).message).toContain("not valid JSON");
    });

    it("answers anything but JSON with 415, so a page on another site cannot post to it unasked", async () => {
      const { app, services } = setup();
      for (const type of [
        "text/plain",
        "application/x-www-form-urlencoded",
        "multipart/form-data",
      ]) {
        const response = await app.request("/ask", {
          method: "POST",
          headers: { "Content-Type": type },
          body: JSON.stringify({ question: "Q?" }),
        });
        expect(response.status, type).toBe(415);
      }
      expect(services.asked).toHaveLength(0);
    });

    it("answers a body that is too large with 413", async () => {
      const { app, services } = setup();
      const response = await app.request(
        "/ask",
        post(JSON.stringify({ question: "Q?", pad: "x".repeat(MAX_BODY_BYTES) })),
      );
      expect(response.status).toBe(413);
      expect(services.asked).toHaveLength(0);
    });
  });

  describe("a failure", () => {
    it("before the answer begins is an ordinary error with a status", async () => {
      const cases: [Error, number, string][] = [
        [
          new RagError("PROVIDER_UNAVAILABLE", "Cannot reach Ollama at http://h:1"),
          503,
          "PROVIDER_UNAVAILABLE",
        ],
        [new RagError("INVALID_ARGUMENT", "k must be 1 or more"), 400, "INVALID_REQUEST"],
        [new RagError("INDEX_CORRUPT", "the index is damaged"), 500, "INDEX_UNAVAILABLE"],
        [new RagError("CONFIG_INVALID", "bad config"), 500, "INTERNAL"],
      ];
      for (const [failure, status, code] of cases) {
        const { app } = setup({ answer: () => Promise.reject(failure) });
        const response = await app.request("/ask", post({ question: "Q?" }));
        expect(response.status, code).toBe(status);
        expect(await errorOf(response)).toEqual({ code, message: failure.message });
      }
    });

    it("that is not the library's is a plain 500 that does not leak its message", async () => {
      const { app } = setup({
        answer: () => Promise.reject(new Error("ENOENT: C:\\Users\\secret\\data\\index.json")),
      });
      const response = await app.request("/ask", post({ question: "Q?" }));
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).not.toContain("secret");
      expect(JSON.parse(text)).toEqual({
        error: { code: "INTERNAL", message: "Something went wrong on the server." },
      });
    });

    it("after the answer began is an error event, and no done follows", async () => {
      const failure = new RagError("PROVIDER_UNAVAILABLE", "the model dropped the connection");
      const { app } = setup({
        answer: () => groundedAnswer({ pieces: ["The ans"], failWith: failure }),
      });
      const response = await app.request("/ask", post({ question: "Q?" }));
      expect(response.status).toBe(200);
      const got = await events(response);
      expect(got.map((e) => e.event)).toEqual(["token", "error"]);
      expect(got.at(-1)?.data).toEqual({
        code: "PROVIDER_UNAVAILABLE",
        message: "the model dropped the connection",
      });
    });
  });
});

describe("GET /pages/:n", () => {
  it("gives a page of the book, with where it sits in the text", async () => {
    const { app } = setup();
    const response = await app.request("/pages/2");
    expect(response.status).toBe(200);
    const page = pageResponseSchema.parse(await response.json());
    const second = BOOK.pages[1];
    expect(page).toEqual({
      docId: DOC,
      title: "Vectors",
      number: 2,
      pageCount: 3,
      text: second?.text,
      span: second?.span,
    });
    // the span says where the text is, so a citation's character range can be found in it
    expect(BOOK.text.slice(page.span.start, page.span.end)).toBe(page.text);
  });

  it("needs no document when the index holds one, and lets one be named", async () => {
    const { app } = setup();
    expect((await app.request(`/pages/1?doc=${DOC}`)).status).toBe(200);
  });

  it("asks which document when the index holds several", async () => {
    const { app } = setup({ documentIds: [DOC, OTHER_DOC] });
    const response = await app.request("/pages/1");
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain("?doc=<id>");
    expect((await app.request(`/pages/1?doc=${DOC}`)).status).toBe(200);
  });

  it("does not serve a document the index does not hold", async () => {
    const { app, services } = setup();
    const response = await app.request(`/pages/1?doc=${OTHER_DOC}`);
    expect(response.status).toBe(404);
    expect(services.loads).toEqual([]);
  });

  it("answers 404 for a page beyond the book, and says how many there are", async () => {
    const { app } = setup();
    const response = await app.request("/pages/4");
    expect(response.status).toBe(404);
    const error = await errorOf(response);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toContain("it has 3");
  });

  it.each(["0", "-1", "abc", "1.5", "1e2"])("answers 400 for the page %s", async (n) => {
    const { app } = setup();
    expect((await app.request(`/pages/${n}`)).status).toBe(400);
  });

  it("answers 400 for a document that is not an id, before touching the disk", async () => {
    const { app, services } = setup();
    expect((await app.request("/pages/1?doc=..%2F..%2Fsecret")).status).toBe(400);
    expect(services.loads).toEqual([]);
  });

  it("says to ingest the book when the index holds a document that is not processed", async () => {
    const { app } = setup({ documents: new Map() });
    const response = await app.request("/pages/1");
    expect(response.status).toBe(404);
    expect((await errorOf(response)).message).toContain("pnpm ingest");
  });

  it("answers 404 when the index holds no document at all", async () => {
    const { app } = setup({ documentIds: [] });
    expect((await app.request("/pages/1")).status).toBe(404);
  });

  it("reads the document from disk once, however many pages are asked for", async () => {
    const { app, services } = setup();
    await app.request("/pages/1");
    await app.request("/pages/2");
    await app.request("/pages/3");
    expect(services.loads).toEqual([DOC]);
  });

  it("does not keep a failed read: the next request tries again", async () => {
    const { app, services } = setup({ loadFailures: 1 });
    expect((await app.request("/pages/1")).status).toBe(500);
    expect((await app.request("/pages/1")).status).toBe(200);
    expect(services.loads).toHaveLength(2);
  });
});

describe("GET /chunks/:id", () => {
  it("gives a passage as the index holds it", async () => {
    const { app } = setup();
    const response = await app.request(`/chunks/${CHUNK.id}`);
    expect(response.status).toBe(200);
    expect(chunkResponseSchema.parse(await response.json())).toEqual({
      id: CHUNK.id,
      docId: DOC,
      text: "Embeddings map text to vectors.",
      pageStart: 1,
      pageEnd: 2,
      sectionPath: ["Chapter 1", "1.1 Vectors"],
      charStart: CHUNK.metadata.charStart,
      charEnd: CHUNK.metadata.charEnd,
      strategy: "recursive",
    });
  });

  it("names the parent of a small chunk of the parent-child strategy", async () => {
    const parent = chunkOf("Cosine similarity compares the direction of two vectors.");
    const child = chunkOf("Cosine similarity compares", { parentId: parent.id });
    const { app } = setup({ chunks: [child, parent] });
    const body = chunkResponseSchema.parse(await (await app.request(`/chunks/${child.id}`)).json());
    expect(body.parentId).toBe(parent.id);
  });

  it("answers 404 for a chunk the index does not hold", async () => {
    const { app } = setup();
    const response = await app.request(`/chunks/${"c".repeat(64)}`);
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe("NOT_FOUND");
  });

  it.each(["short", "../../etc/passwd", "G".repeat(64), "A".repeat(64)])(
    "answers 400 for the id %s without looking it up",
    async (id) => {
      const { app } = setup();
      const response = await app.request(`/chunks/${encodeURIComponent(id)}`);
      expect(response.status).toBe(400);
    },
  );
});

describe("everything else", () => {
  it("answers a route that does not exist with 404 in the same error shape", async () => {
    const { app } = setup();
    const response = await app.request("/nope");
    expect(response.status).toBe(404);
    expect((await errorOf(response)).message).toContain("GET /nope");
  });

  it("answers the wrong method with 404 in the same shape", async () => {
    const { app } = setup();
    expect((await app.request("/ask")).status).toBe(404);
    expect((await app.request("/pages/1", { method: "POST" })).status).toBe(404);
  });
});

describe("CORS", () => {
  const preflight = (origin: string) => ({
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });

  it("lets the Vite dev server call the API, and says which methods and headers", async () => {
    const { app } = setup();
    const response = await app.request("/ask", preflight(VITE));
    expect(response.headers.get("access-control-allow-origin")).toBe(VITE);
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "content-type",
    );
  });

  it("lets both spellings of localhost, by default", () => {
    expect(DEFAULT_ALLOWED_ORIGINS).toEqual(["http://localhost:5173", "http://127.0.0.1:5173"]);
  });

  it("answers a page on any other address with no permission", async () => {
    const { app } = setup();
    const response = await app.request("/ask", preflight("https://evil.example"));
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("marks the answers to the allowed page, and not to another", async () => {
    const { app } = setup();
    const allowed = await app.request("/pages/1", { headers: { Origin: VITE } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe(VITE);
    const other = await app.request("/pages/1", { headers: { Origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allows the origins it is given instead of the defaults", async () => {
    const app = createApp(fakeServices(), { allowedOrigins: ["http://localhost:3000"] });
    const ok = await app.request("/pages/1", { headers: { Origin: "http://localhost:3000" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const no = await app.request("/pages/1", { headers: { Origin: VITE } });
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
  });
});
