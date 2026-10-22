import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { chunkResponseSchema, pageResponseSchema, readAskEvents } from "@rag-book/api-contract";
import type { AskEvent } from "@rag-book/api-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileDocumentStore, FileIndexWriter } from "../adapters/index.js";
import { buildApiServices } from "../composition/index.js";
import { INDEX_MANIFEST_VERSION } from "../core/index.js";
import type { Embedder, IndexContents, LlmProvider } from "../core/index.js";
import { indexNamespace } from "../pipeline/index.js";
import { Bm25Index, MeteredEmbedder, MeteredProvider } from "../strategies/index.js";
import { createApp } from "./app.js";
import { BOOK, DOC, chunkOf } from "./api.testing.js";

// The real pipeline over a small index on disk, behind a real HTTP server on a real socket, read the
// way a browser reads it. Only the models are fakes.

const unit = (...v: number[]): Float32Array => {
  const length = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return Float32Array.from(v.map((x) => x / length));
};

const EMBEDDING = chunkOf("Embeddings map text to vectors.");
const COSINE = chunkOf("Cosine similarity compares the direction of two vectors.");
const STORE = chunkOf("A vector store keeps vectors and finds the nearest ones.");
const CHUNKS = [EMBEDDING, COSINE, STORE];

const DIRECTIONS = new Map<string, Float32Array>([
  [EMBEDDING.text, unit(1, 0, 0)],
  [COSINE.text, unit(0, 1, 0)],
  [STORE.text, unit(0, 0, 1)],
  ["What is an embedding?", unit(1, 0.05, 0)],
]);
const embedder: Embedder = {
  modelId: "ollama:all-minilm",
  dimensions: 3,
  embed: (texts) => Promise.resolve(texts.map((t) => DIRECTIONS.get(t) ?? unit(1, 1, 1))),
};
const llm: LlmProvider = {
  modelId: "fake:model",
  async *chat() {
    await Promise.resolve();
    yield { kind: "text", text: "Embeddings " } as const;
    yield { kind: "text", text: "are vectors [1]." } as const;
    yield { kind: "end", reason: "stop", promptTokens: 200, outputTokens: 6 } as const;
  },
};

function indexContents(): IndexContents {
  const keyword = new Bm25Index();
  keyword.add(CHUNKS);
  return {
    manifest: {
      version: INDEX_MANIFEST_VERSION,
      namespace: indexNamespace("recursive", embedder.modelId),
      createdAt: "2026-10-22T10:00:00.000Z",
      gitCommit: null,
      configHash: "c".repeat(64),
      fingerprint: "f".repeat(64),
      chunker: { name: "recursive", tokenizer: "approx", maxTokens: 400, overlapTokens: 60 },
      embedder: { modelId: embedder.modelId, dimensions: 3, batchSize: 32 },
      documents: [DOC],
      counts: { documents: 1, chunks: 3, parents: 0, vectors: 3 },
      timingsMs: { total: 1 },
    },
    chunks: CHUNKS,
    vectors: CHUNKS.map((c) => ({
      id: c.id,
      vector: DIRECTIONS.get(c.text) as Float32Array,
      metadata: c.metadata,
    })),
    keywordIndex: keyword.serialize(),
  };
}

let workdir: string;
let close: () => Promise<void>;
let base: string;

beforeAll(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "rag-api-"));
  const processedDir = path.join(workdir, "processed");
  const indexDir = path.join(workdir, "index");
  await new FileDocumentStore(processedDir).save(BOOK);
  await new FileIndexWriter(indexDir).write(indexContents());

  const services = await buildApiServices({
    argv: [],
    env: {},
    processedDir,
    indexDir,
    promptsDir: path.resolve("prompts"),
    embedder: new MeteredEmbedder(embedder),
    llm: new MeteredProvider(llm),
  });
  const server = serve({ fetch: createApp(services).fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port.toString()}`;
  close = () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
});

afterAll(async () => {
  await close();
  await rm(workdir, { recursive: true, force: true });
});

const ask = (body: unknown): Promise<Response> =>
  fetch(`${base}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function read(response: Response): Promise<AskEvent[]> {
  const out: AskEvent[] = [];
  if (response.body === null) throw new Error("no body");
  for await (const event of readAskEvents(response.body)) out.push(event);
  return out;
}

describe("the API over a socket, with the real pipeline", () => {
  it("answers a question as a stream of events, read the way a browser reads it", async () => {
    const response = await ask({ question: "What is an embedding?", k: 2 });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = await read(response);
    expect(events.map((e) => e.event)).toEqual(["token", "token", "citations", "trace", "done"]);
    const text = events.flatMap((e) => (e.event === "token" ? [e.data.text] : [])).join("");
    expect(text).toBe("Embeddings are vectors [1].");
    expect(events.at(-1)?.data).toMatchObject({ answered: true, cited: [1], unknownCitations: [] });
  });

  it("cites the passage the question is about, and the citation leads to its page and chunk", async () => {
    const events = await read(await ask({ question: "What is an embedding?", k: 2 }));
    const citations = events.flatMap((e) => (e.event === "citations" ? e.data.citations : []));
    const first = citations[0];
    expect(first?.chunkId).toBe(EMBEDDING.id);

    const chunk = chunkResponseSchema.parse(
      await (await fetch(`${base}/chunks/${first?.chunkId ?? ""}`)).json(),
    );
    expect(chunk.text).toBe(first?.quote);

    const page = pageResponseSchema.parse(
      await (await fetch(`${base}/pages/${(first?.pageStart ?? 0).toString()}`)).json(),
    );
    expect(page.docId).toBe(first?.docId);
    // the citation's character range sits inside the text of the document the page is cut from
    expect(BOOK.text.slice(first?.charStart, first?.charEnd)).toBe(first?.quote);
  });

  it("reports what the answer cost, on the trace", async () => {
    const events = await read(await ask({ question: "What is an embedding?", k: 2 }));
    const trace = events.flatMap((e) => (e.event === "trace" ? [e.data.trace] : []))[0];
    expect(trace?.stages.map((s) => s.stage)).toEqual(
      expect.arrayContaining(["transform", "retrieve", "rerank", "assemble", "generate"]),
    );
    // the answer, and the embedding of the question
    expect(trace?.usage).toMatchObject({ calls: 2, promptTokens: 200, outputTokens: 6 });
  });

  it("restricts an answer to the pages asked for", async () => {
    const events = await read(
      await ask({ question: "What is an embedding?", k: 3, filter: { pages: { from: 3 } } }),
    );
    const citations = events.flatMap((e) => (e.event === "citations" ? e.data.citations : []));
    // the embeddings passage is on pages 1 and 2: it cannot be a source for pages from 3
    expect(citations.map((c) => c.chunkId)).not.toContain(EMBEDDING.id);
  });

  it("answers a bad request with a JSON error over the socket", async () => {
    const response = await ask({ question: "" });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("answers the pages and chunks the book does not have with 404", async () => {
    expect((await fetch(`${base}/pages/99`)).status).toBe(404);
    expect((await fetch(`${base}/chunks/${"d".repeat(64)}`)).status).toBe(404);
  });

  it("answers a browser's preflight for the dev server", async () => {
    const response = await fetch(`${base}/ask`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  it("stops the work when the reader closes the connection", async () => {
    const reader = new AbortController();
    const response = await fetch(`${base}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "What is an embedding?" }),
      signal: reader.signal,
    });
    reader.abort();
    // the connection is gone; the server must still be fine for the next reader
    await response.body?.cancel().catch(() => undefined);
    expect((await read(await ask({ question: "What is an embedding?" }))).at(-1)?.event).toBe(
      "done",
    );
  });
});
