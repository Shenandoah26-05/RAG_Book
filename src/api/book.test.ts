import { bookResponseSchema, errorResponseSchema } from "@rag-book/api-contract";
import { describe, expect, it } from "vitest";
import type { ByteRange, ParsedDocument, Section, SourceFile } from "../core/index.js";
import { createApp } from "./app.js";
import { BOOK, DOC, OTHER_DOC, fakeServices } from "./api.testing.js";
import type { FakeServicesOptions } from "./api.testing.js";

const section = (
  title: string,
  level: number,
  pageStart: number,
  pageEnd: number,
  children: Section[] = [],
): Section => ({
  title,
  level,
  pageStart,
  pageEnd,
  span: { start: 0, end: 1 },
  titleSpan: { start: 0, end: 1 },
  children,
});

const BOOK_WITH_SECTIONS: ParsedDocument = {
  ...BOOK,
  sections: [
    section("Embeddings", 1, 1, 2, [section("Similarity", 2, 2, 2)]),
    section("Stores", 1, 3, 3),
  ],
};

const PDF_TEXT = "%PDF-1.4 pretend this is a whole book";

/** A file held in memory that honours a byte range, and notes whether reading was cut short. */
function memoryPdf(text = PDF_TEXT): SourceFile & { stopped: () => boolean } {
  const bytes = new TextEncoder().encode(text);
  let stopped = false;
  return {
    size: bytes.length,
    mediaType: "application/pdf",
    stopped: () => stopped,
    read(range?: ByteRange): AsyncIterable<Uint8Array> {
      const part = range === undefined ? bytes : bytes.slice(range.start, range.end + 1);
      return (async function* () {
        try {
          // two pieces, so a reader that stops after the first leaves something unread
          const half = Math.ceil(part.length / 2);
          yield part.slice(0, half);
          await Promise.resolve();
          if (half < part.length) yield part.slice(half);
        } finally {
          stopped = true;
        }
      })();
    },
  };
}

function setup(options: FakeServicesOptions = {}, pdf?: SourceFile) {
  const services = fakeServices({
    documents: new Map([[DOC, BOOK_WITH_SECTIONS]]),
    ...(pdf === undefined ? {} : { pdfs: new Map([[BOOK.sha256, pdf]]) }),
    ...options,
  });
  return { services, app: createApp(services) };
}

async function errorOf(response: Response) {
  return errorResponseSchema.parse(await response.json()).error;
}

describe("GET /book", () => {
  it("gives the title, the page count and the section tree", async () => {
    const response = await setup({}, memoryPdf()).app.request("/book");
    expect(response.status).toBe(200);
    expect(bookResponseSchema.parse(await response.json())).toEqual({
      docId: DOC,
      title: "Vectors",
      pageCount: 3,
      pdf: true,
      outline: [
        {
          title: "Embeddings",
          level: 1,
          pageStart: 1,
          pageEnd: 2,
          children: [{ title: "Similarity", level: 2, pageStart: 2, pageEnd: 2, children: [] }],
        },
        { title: "Stores", level: 1, pageStart: 3, pageEnd: 3, children: [] },
      ],
    });
  });

  it("says when the PDF is not available, so the reader can fall back to text", async () => {
    const response = await setup().app.request("/book");
    expect(bookResponseSchema.parse(await response.json())).toMatchObject({ pdf: false });
  });

  it("gives an empty outline for a book with no headings", async () => {
    const { app } = setup({ documents: new Map([[DOC, BOOK]]) });
    expect(bookResponseSchema.parse(await (await app.request("/book")).json()).outline).toEqual([]);
  });

  it("asks which document when the index holds several, and refuses an unknown one", async () => {
    const { app } = setup({ documentIds: [DOC, OTHER_DOC] });
    const several = await app.request("/book");
    expect(several.status).toBe(400);
    expect((await errorOf(several)).message).toContain("?doc=<id>");
    expect((await app.request(`/book?doc=${OTHER_DOC}&x=1`)).status).toBe(404);
    expect((await app.request("/book?doc=nope")).status).toBe(400);
  });

  it("says so when the document was never processed", async () => {
    const { app } = setup({ documents: new Map() });
    const response = await app.request("/book");
    expect(response.status).toBe(404);
    expect((await errorOf(response)).message).toContain("pnpm ingest");
  });
});

describe("GET /book/pdf", () => {
  it("sends the whole file with its length and a hash-based ETag", async () => {
    const response = await setup({}, memoryPdf()).app.request("/book/pdf");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-length")).toBe(String(PDF_TEXT.length));
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("etag")).toBe(`"${BOOK.sha256}"`);
    expect(await response.text()).toBe(PDF_TEXT);
  });

  it("sends the part asked for, with 206 and where it sits in the file", async () => {
    const { app } = setup({}, memoryPdf());
    const response = await app.request("/book/pdf", { headers: { Range: "bytes=5-9" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 5-9/${PDF_TEXT.length.toString()}`);
    expect(response.headers.get("content-length")).toBe("5");
    expect(await response.text()).toBe(PDF_TEXT.slice(5, 10));
  });

  it("reads open-ended and suffix ranges", async () => {
    const { app } = setup({}, memoryPdf());
    const tail = await app.request("/book/pdf", { headers: { Range: "bytes=-4" } });
    expect(await tail.text()).toBe(PDF_TEXT.slice(-4));
    const from = await app.request("/book/pdf", { headers: { Range: "bytes=30-" } });
    expect(from.headers.get("content-range")).toBe(
      `bytes 30-${(PDF_TEXT.length - 1).toString()}/${PDF_TEXT.length.toString()}`,
    );
    expect(await from.text()).toBe(PDF_TEXT.slice(30));
  });

  it("answers 416 for a range past the end, saying how long the file is", async () => {
    const response = await setup({}, memoryPdf()).app.request("/book/pdf", {
      headers: { Range: "bytes=500-" },
    });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${PDF_TEXT.length.toString()}`);
  });

  it("sends the whole file when the range is something it does not serve", async () => {
    const response = await setup({}, memoryPdf()).app.request("/book/pdf", {
      headers: { Range: "bytes=0-1,5-6" },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PDF_TEXT);
  });

  it("looks the file up by the document's hash, never by a path in the request", async () => {
    const asked: string[] = [];
    const services = fakeServices({ documents: new Map([[DOC, BOOK]]) });
    const app = createApp({
      ...services,
      sources: {
        find: (sha256) => {
          asked.push(sha256);
          return Promise.resolve(undefined);
        },
      },
    });
    await app.request("/book/pdf?file=../../etc/passwd&path=/etc/passwd");
    expect(asked).toEqual([BOOK.sha256]);
  });

  it("says where to put the PDF when it is not there", async () => {
    const response = await setup().app.request("/book/pdf");
    expect(response.status).toBe(404);
    expect((await errorOf(response)).message).toContain("data/raw");
  });

  it("stops reading the file when the client goes away", async () => {
    const pdf = memoryPdf();
    const response = await setup({}, pdf).app.request("/book/pdf");
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    expect(pdf.stopped()).toBe(true);
  });

  it("lets the browser send Range and read the headers it needs (CORS)", async () => {
    const { app } = setup({}, memoryPdf());
    const preflight = await app.request("/book/pdf", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "range",
      },
    });
    expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("range");
    const response = await app.request("/book/pdf", {
      headers: { Origin: "http://localhost:5173" },
    });
    expect(response.headers.get("access-control-expose-headers")?.toLowerCase()).toContain(
      "content-range",
    );
  });
});
