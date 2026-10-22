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
