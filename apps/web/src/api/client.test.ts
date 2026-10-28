import type { AskEvent } from "@rag-book/api-contract";
import { describe, expect, it } from "vitest";
import { ApiError, createApiClient } from "./client.js";

const DOC = "a1b2c3d4-e5f6-5a7b-8c9d-0e1f2a3b4c5d";
const BOOK = { docId: DOC, title: "Vectors", pageCount: 3, pdf: true, outline: [] };
const PAGE = {
  docId: DOC,
  title: "Vectors",
  number: 2,
  pageCount: 3,
  text: "Cosine similarity.",
  span: { start: 0, end: 18 },
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A fetch that answers from a function, and remembers what it was asked. */
function fakeFetch(answer: (url: string) => Response | Promise<Response>) {
  const urls: string[] = [];
  const fetcher = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    return Promise.resolve(answer(url));
  }) as typeof fetch;
  return { fetcher, urls };
}

describe("createApiClient", () => {
  it("fetches and validates the book", async () => {
    const { fetcher, urls } = fakeFetch(() => json(BOOK));
    const client = createApiClient({ baseUrl: "/api", fetch: fetcher });
    expect(await client.getBook()).toEqual(BOOK);
    expect(urls).toEqual(["/api/book"]);
  });

  it("names the document when asked, and encodes it", async () => {
    const { fetcher, urls } = fakeFetch(() => json(BOOK));
    const client = createApiClient({ baseUrl: "/api", fetch: fetcher });
    await client.getBook("a b&c");
    expect(urls).toEqual(["/api/book?doc=a%20b%26c"]);
  });

  it("fetches a page", async () => {
    const { fetcher, urls } = fakeFetch(() => json(PAGE));
    const client = createApiClient({ baseUrl: "http://127.0.0.1:8787/", fetch: fetcher });
    expect((await client.getPage(2, DOC)).text).toBe("Cosine similarity.");
    expect(urls).toEqual([`http://127.0.0.1:8787/pages/2?doc=${DOC}`]);
  });

  it("builds the address of the PDF, for pdf.js to load", () => {
    const client = createApiClient({ baseUrl: "/api/" });
    expect(client.pdfUrl()).toBe("/api/book/pdf");
    expect(client.pdfUrl(DOC)).toBe(`/api/book/pdf?doc=${DOC}`);
  });

  it("says the API cannot be reached, and how to start it", async () => {
    const client = createApiClient({
      baseUrl: "/api",
      fetch: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    const failure = await client.getBook().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ kind: "unreachable" });
    expect((failure as ApiError).message).toContain("pnpm api");
  });

  it("passes on the API's own message and code for an error answer", async () => {
    const { fetcher } = fakeFetch(() =>
      json({ error: { code: "NOT_FOUND", message: "The book has no page 9 (it has 3)." } }, 404),
    );
    const failure = await createApiClient({ baseUrl: "/api", fetch: fetcher })
      .getPage(9)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      kind: "api",
      status: 404,
      code: "NOT_FOUND",
      message: "The book has no page 9 (it has 3).",
    });
  });

  it("does not trust an answer that is not in the contract's shape", async () => {
    const { fetcher } = fakeFetch(() => json({ title: "no id, no pages" }));
    const failure = await createApiClient({ baseUrl: "/api", fetch: fetcher })
      .getBook()
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "invalid-response" });
  });

  it("says so when the server is not the API at all (an HTML page, say)", async () => {
    const { fetcher } = fakeFetch(() => new Response("<html>nope</html>", { status: 200 }));
    const failure = await createApiClient({ baseUrl: "/api", fetch: fetcher })
      .getBook()
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "invalid-response" });
    expect((failure as ApiError).message).toContain("RAG Book API");
  });

  it("describes an error answer that is not in the contract's shape by its status", async () => {
    const { fetcher } = fakeFetch(() => json({ oops: true }, 502));
    const failure = await createApiClient({ baseUrl: "/api", fetch: fetcher })
      .getBook()
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "api", status: 502, message: "The API answered 502." });
  });

  it("lets an abort through as it is, not as 'cannot reach the API'", async () => {
    const controller = new AbortController();
    const reason = new DOMException("aborted", "AbortError");
    const client = createApiClient({
      baseUrl: "/api",
      fetch: () => {
        controller.abort();
        return Promise.reject(reason);
      },
    });
    await expect(client.getBook(undefined, controller.signal)).rejects.toBe(reason);
  });
});

describe("ask", () => {
  const sse = (...frames: [string, unknown][]): string =>
    frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  const streamOf = (text: string, status = 200): Response =>
    new Response(text, { status, headers: { "Content-Type": "text/event-stream" } });
  const collect = async (events: AsyncIterable<AskEvent>): Promise<AskEvent[]> => {
    const all: AskEvent[] = [];
    for await (const event of events) all.push(event);
    return all;
  };
  const CITATION = {
    index: 1,
    chunkId: "c".repeat(64),
    docId: DOC,
    pageStart: 2,
    pageEnd: 2,
    charStart: 0,
    charEnd: 4,
    quote: "text",
  };

  it("posts the question as JSON and reads the events in order", async () => {
    let sent: { url: string; init: RequestInit | undefined } | undefined;
    const client = createApiClient({
      baseUrl: "/api",
      fetch: ((url: string, init?: RequestInit) => {
        sent = { url, init };
        return Promise.resolve(
          streamOf(
            sse(
              ["token", { text: "Hi " }],
              ["token", { text: "[1]" }],
              ["citations", { citations: [CITATION] }],
              ["done", { answered: true, cited: [1], unknownCitations: [], complete: true }],
            ),
          ),
        );
      }) as typeof fetch,
    });

    const events = await collect(client.ask({ question: "Why?", filter: { documents: [DOC] } }));
    expect(events.map((e) => e.event)).toEqual(["token", "token", "citations", "done"]);
    expect(sent?.url).toBe("/api/ask");
    expect(sent?.init?.method).toBe("POST");
    expect(JSON.parse(sent?.init?.body as string)).toEqual({
      question: "Why?",
      filter: { documents: [DOC] },
    });
    expect((sent?.init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });

  it("rejects with the API's own message when the question is refused before the answer starts", async () => {
    const { fetcher } = fakeFetch(() =>
      json({ error: { code: "INVALID_REQUEST", message: "The request is not valid." } }, 400),
    );
    const failure = await collect(
      createApiClient({ baseUrl: "/api", fetch: fetcher }).ask({ question: "?" }),
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "api", status: 400, code: "INVALID_REQUEST" });
  });

  it("says the API cannot be reached", async () => {
    const client = createApiClient({
      baseUrl: "/api",
      fetch: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    const failure = await collect(client.ask({ question: "?" })).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "unreachable" });
  });

  it("does not trust an event that is not in the contract's shape", async () => {
    const { fetcher } = fakeFetch(() => streamOf(sse(["token", { text: "" }])));
    const failure = await collect(
      createApiClient({ baseUrl: "/api", fetch: fetcher }).ask({ question: "?" }),
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "invalid-response" });
  });

  it("says the connection was lost when the stream breaks in the middle", async () => {
    // one piece arrives, and the connection drops before the next is asked for
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode(sse(["token", { text: "Hi" }])));
        } else {
          controller.error(new TypeError("network error"));
        }
      },
    });
    const client = createApiClient({
      baseUrl: "/api",
      fetch: () => Promise.resolve(new Response(body)),
    });
    const seen: AskEvent[] = [];
    const failure = await (async () => {
      for await (const event of client.ask({ question: "?" })) seen.push(event);
    })().catch((error: unknown) => error);
    expect(seen).toHaveLength(1);
    expect(failure).toMatchObject({ kind: "unreachable" });
    expect((failure as ApiError).message).toContain("lost");
  });

  it("lets an abort through as it is", async () => {
    const controller = new AbortController();
    const reason = new DOMException("aborted", "AbortError");
    const client = createApiClient({
      baseUrl: "/api",
      fetch: () => {
        controller.abort();
        return Promise.reject(reason);
      },
    });
    await expect(collect(client.ask({ question: "?" }, controller.signal))).rejects.toBe(reason);
  });
});

describe("getHighlights", () => {
  const RESPONSE = {
    docId: DOC,
    pages: [{ number: 2, boxes: [{ x: 1, y: 2, width: 3, height: 4 }] }],
  };

  it("asks for the passage by its character range, and the document", async () => {
    const { fetcher, urls } = fakeFetch(() => json(RESPONSE));
    const client = createApiClient({ baseUrl: "/api", fetch: fetcher });
    expect(await client.getHighlights(120, 480, DOC)).toEqual(RESPONSE);
    expect(urls).toEqual([`/api/highlights?from=120&to=480&doc=${DOC}`]);
  });

  it("leaves the document out when none is named", async () => {
    const { fetcher, urls } = fakeFetch(() => json(RESPONSE));
    await createApiClient({ baseUrl: "/api", fetch: fetcher }).getHighlights(1, 2);
    expect(urls).toEqual(["/api/highlights?from=1&to=2"]);
  });

  it("does not trust a box that is not in the contract's shape", async () => {
    const bad = {
      docId: DOC,
      pages: [{ number: 2, boxes: [{ x: 1, y: 2, width: 0, height: 4 }] }],
    };
    const { fetcher } = fakeFetch(() => json(bad));
    const failure = await createApiClient({ baseUrl: "/api", fetch: fetcher })
      .getHighlights(1, 2)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "invalid-response" });
  });
});
