import { askRequestSchema, chunkRequestSchema, pageRequestSchema } from "@rag-book/api-contract";
import type { ErrorBody, ErrorResponse } from "@rag-book/api-contract";
import type { ZodType } from "zod";
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { ApiServices } from "../composition/index.js";
import type { ChunkId, DocId, ParsedDocument } from "../core/index.js";
import { noopLogger } from "../shared/index.js";
import type { Logger } from "../shared/index.js";
import { describeError, invalidRequest, notFound } from "./errors.js";
import type { ErrorAnswer } from "./errors.js";
import {
  toMetadataFilter,
  toWireChunk,
  toWireCitation,
  toWirePage,
  toWireTrace,
} from "./mappers.js";

/** The address of the Vite dev server, which is where the web app is served while it is built. */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

/** A question and a short history fit in far less than this; a larger body is not a question. */
export const MAX_BODY_BYTES = 256 * 1024;

export interface AppOptions {
  /**
   * The web pages allowed to call the API from a browser (CORS). Default: the Vite dev server. A page
   * on any other address cannot read an answer, even though the API is on the same machine.
   */
  readonly allowedOrigins?: readonly string[];
  readonly logger?: Logger;
}

/** Writes a failure as JSON: `{ "error": { "code", "message" } }`. */
function fail(c: Context, answer: ErrorAnswer): Response {
  const body: ErrorResponse = { error: answer.body };
  return c.json(body, answer.status);
}

/** What went wrong in a request that did not match its schema, as `path: message` pairs. */
function issuesOf(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): NonNullable<ErrorBody["issues"]> {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "(body)",
    message: issue.message,
  }));
}

function check<T>(
  schema: ZodType<T>,
  input: unknown,
): { ok: true; value: T } | { ok: false; answer: ErrorAnswer } {
  const parsed = schema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : {
        ok: false,
        answer: invalidRequest("The request is not valid.", issuesOf(parsed.error)),
      };
}

/**
 * The HTTP API, as a web-standard `fetch` handler: `app.request(...)` calls a route without a socket,
 * and `serve.ts` puts it on one. It is an entry point and nothing else: each route validates the
 * request with the contract's schema, calls the services the composition root built, and writes
 * the answer in the contract's shapes. No retrieval, ranking or prompting happens here.
 *
 *   POST /ask         a question; the answer streams back as server-sent events (see below)
 *   GET  /pages/:n    one page of the book, as text
 *   GET  /chunks/:id  one passage as the index holds it
 *
 * `POST /ask` answers with `Content-Type: text/event-stream` and these events, in this order: any
 * number of `token`, then `citations`, then `trace`, then `done`. A failure after the stream began is
 * an `error` event, and nothing follows it. A failure before it began (a bad request, the model
 * unreachable while the sources are looked up) is an ordinary JSON error with a status code.
 */
export function createApp(services: ApiServices, options: AppOptions = {}): Hono {
  const logger = options.logger ?? noopLogger;
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: [...(options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS)],
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
      maxAge: 600,
    }),
  );

  // The pages are read from disk once and kept: a reader turns pages quickly.
  const documents = new Map<DocId, Promise<ParsedDocument | undefined>>();
  const document = (id: DocId): Promise<ParsedDocument | undefined> => {
    let loading = documents.get(id);
    if (loading === undefined) {
      loading = services.documents.load(id);
      documents.set(id, loading);
      // a failed read is not kept, so the next request tries again
      loading.catch(() => documents.delete(id));
    }
    return loading;
  };

  // ---- POST /ask ----

  app.post(
    "/ask",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        fail(
          c,
          invalidRequest(
            `The request is larger than ${MAX_BODY_BYTES.toString()} bytes.`,
            undefined,
            413,
          ),
        ),
    }),
    async (c) => {
      // JSON only. A page on another site can send text/plain without asking permission first (no
      // preflight); insisting on JSON makes the browser ask, and CORS then says no.
      if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
        return fail(c, invalidRequest("Send the request as application/json.", undefined, 415));
      }
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return fail(c, invalidRequest("The body is not valid JSON."));
      }
      const request = check(askRequestSchema, body);
      if (!request.ok) return fail(c, request.answer);
      const { question, k, history, filter } = request.value;

      // stops the work when the reader goes away: between stages, or in the middle of the answer
      const controller = new AbortController();
      const gone = c.req.raw.signal;
      if (gone.aborted) controller.abort();
      else
        gone.addEventListener(
          "abort",
          () => {
            controller.abort();
          },
          { once: true },
        );

      let answer;
      try {
        const metadataFilter = toMetadataFilter(filter);
        answer = await services.pipeline.ask(question, {
          signal: controller.signal,
          ...(k === undefined ? {} : { k }),
          ...(history === undefined || history.length === 0 ? {} : { history }),
          ...(metadataFilter === undefined ? {} : { filter: metadataFilter }),
        });
      } catch (error) {
        if (controller.signal.aborted) return c.body(null, 499 as never);
        const answered = describeError(error);
        if (answered.status >= 500) logger.error("ask failed", { error: String(error) });
        return fail(c, answered);
      }

      return streamSSE(c, async (stream) => {
        stream.onAbort(() => {
          controller.abort();
        });
        const send = (event: string, data: unknown): Promise<void> =>
          stream.writeSSE({ event, data: JSON.stringify(data) });
        try {
          for await (const delta of answer.stream) {
            if (delta.kind === "text") await send("token", { text: delta.text });
          }
          await send("citations", { citations: answer.citations.map(toWireCitation) });
          // read once the stream is over, so it holds the generate stage and the model calls
          await send("trace", { trace: toWireTrace(answer.trace.snapshot(), services.prices) });
          const grounding = await answer.grounding;
          await send("done", {
            answered: grounding.answered,
            ...(grounding.refusal === undefined ? {} : { refusal: grounding.refusal }),
            cited: [...grounding.cited],
            unknownCitations: [...grounding.unknownCitations],
            complete: grounding.complete,
          });
        } catch (error) {
          // a reader that left is not an error, and there is nobody to tell
          if (controller.signal.aborted) return;
          logger.error("answer failed while streaming", { error: String(error) });
          await send("error", describeError(error).body);
        }
      });
    },
  );

  // ---- GET /pages/:n ----

  app.get("/pages/:n", async (c) => {
    const request = check(pageRequestSchema, { n: c.req.param("n"), doc: c.req.query("doc") });
    if (!request.ok) return fail(c, request.answer);
    const { n, doc } = request.value;

    const ids = services.documentIds;
    let id: DocId;
    if (doc !== undefined) {
      const known = ids.find((candidate) => candidate === doc);
      if (known === undefined) return fail(c, notFound(`The index holds no document ${doc}.`));
      id = known;
    } else if (ids.length === 1 && ids[0] !== undefined) {
      id = ids[0];
    } else if (ids.length === 0) {
      return fail(c, notFound("The index holds no document."));
    } else {
      return fail(
        c,
        invalidRequest(
          `The index holds ${ids.length.toString()} documents: say which with ?doc=<id> (${ids.join(", ")}).`,
        ),
      );
    }

    let loaded: ParsedDocument | undefined;
    try {
      loaded = await document(id);
    } catch (error) {
      logger.error("a page could not be read", { error: String(error) });
      return fail(c, describeError(error));
    }
    if (loaded === undefined) {
      return fail(
        c,
        notFound(`The document ${id} has not been processed. Run: pnpm ingest <book.pdf>`),
      );
    }
    const page = loaded.pages.find((candidate) => candidate.number === n);
    if (page === undefined) {
      return fail(
        c,
        notFound(`The book has no page ${n.toString()} (it has ${loaded.pageCount.toString()}).`),
      );
    }
    return c.json(toWirePage(loaded, page));
  });

  // ---- GET /chunks/:id ----

  app.get("/chunks/:id", async (c) => {
    const request = check(chunkRequestSchema, { id: c.req.param("id") });
    if (!request.ok) return fail(c, request.answer);
    const [chunk] = await services.chunks.get([request.value.id as ChunkId]);
    if (chunk === undefined)
      return fail(c, notFound(`The index holds no chunk ${request.value.id}.`));
    return c.json(toWireChunk(chunk));
  });

  app.notFound((c) =>
    fail(c, notFound(`No route ${c.req.method} ${new URL(c.req.url).pathname}.`)),
  );

  app.onError((error, c) => {
    logger.error("unhandled error", { error: String(error) });
    return fail(c, describeError(error));
  });

  return app;
}
