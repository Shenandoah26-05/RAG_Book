// Shared fakes for the tests of the reader and the chat: an API, a PDF and storage, all in memory.
// Not part of the app (nothing imports it but tests).
import type {
  AskEvent,
  AskRequest,
  BookResponse,
  FeedbackRequest,
  FeedbackResponse,
  HighlightResponse,
  PageResponse,
  WireCitation,
} from "@rag-book/api-contract";
import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { App } from "./App.js";
import type { ApiClient } from "./api/client.js";
import type { PageView } from "./highlight/geometry.js";
import type { OpenPdf, PdfBook } from "./pdf/types.js";
import type { PositionStorage } from "./reader/position.js";

export const DOC = "a1b2c3d4-e5f6-5a7b-8c9d-0e1f2a3b4c5d";
const CHUNK = "c".repeat(64);

export const entry = (
  title: string,
  level: number,
  pageStart: number,
  pageEnd: number,
  children: BookResponse["outline"] = [],
) => ({ title, level, pageStart, pageEnd, children });

export const BOOK: BookResponse = {
  docId: DOC,
  title: "Vectors",
  pageCount: 12,
  pdf: true,
  outline: [
    entry("Embeddings", 1, 1, 5, [entry("Similarity", 2, 3, 5)]),
    entry("Stores", 1, 6, 12),
  ],
};

/** A source of an answer. */
export const citation = (index: number, extra: Partial<WireCitation> = {}): WireCitation => ({
  index,
  chunkId: CHUNK,
  docId: DOC,
  pageStart: 3,
  pageEnd: 3,
  charStart: 1004,
  charEnd: 1012,
  quote: "Cosine similarity compares direction.",
  ...extra,
});

export const token = (text: string): AskEvent => ({ event: "token", data: { text } });
export const citationsEvent = (...citations: WireCitation[]): AskEvent => ({
  event: "citations",
  data: { citations },
});
export const doneEvent = (
  extra: Partial<Extract<AskEvent, { event: "done" }>["data"]> = {},
): AskEvent => ({
  event: "done",
  data: { answered: true, cited: [], unknownCitations: [], complete: true, ...extra },
});

/** A stream of events that a test feeds one at a time, so it can look at the screen in between. */
export interface Channel {
  push(event: AskEvent): void;
  close(): void;
  fail(error: unknown): void;
  iterate(): AsyncGenerator<AskEvent>;
}

export function channel(): Channel {
  const items: AskEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  let failure: unknown;
  const notify = (): void => {
    wake?.();
    wake = undefined;
  };
  return {
    push: (event) => {
      items.push(event);
      notify();
    },
    close: () => {
      closed = true;
      notify();
    },
    fail: (error) => {
      failure = error;
      closed = true;
      notify();
    },
    async *iterate() {
      for (;;) {
        const next = items.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (failure !== undefined) throw failure as Error;
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

export interface FakeOptions {
  book?: BookResponse;
  openFails?: boolean;
  /** How the fake PDF says it drew a page. */
  view?: Partial<PageView>;
  /** The boxes for a passage. Default: one box on page 3. */
  highlights?: (from: number, to: number) => Promise<HighlightResponse>;
  /** The text of a page and where it starts in the whole text. Default: "Text of page N." at 1000. */
  pageText?: (number: number) => { text: string; start: number };
  /** Make `ask` reject at once (the request itself fails). */
  askFails?: Error;
  /** What sending feedback does. Default: it is kept at once. A test can hold it to look in between. */
  feedback?: (request: FeedbackRequest) => Promise<FeedbackResponse>;
  /** The text the fake PDF puts in its text layer (what a reader could select). */
  textLayer?: string;
}

export interface Fakes {
  client: ApiClient;
  /** The mock behind `client.getBook`, to see how it was called and to make it fail. */
  getBook: ReturnType<typeof vi.fn>;
  ask: ReturnType<typeof vi.fn>;
  getHighlights: ReturnType<typeof vi.fn>;
  /** What each rating was sent as, in order. */
  feedbacks: FeedbackRequest[];
  /** The stream of each question asked, in order. */
  channels: Channel[];
  /** What each question was sent as. */
  requests: AskRequest[];
  /** Whether the signal of each question was aborted. */
  aborted: boolean[];
  rendered: number[];
  opened: string[];
  destroyed: () => number;
  openPdf: OpenPdf;
  storage: PositionStorage & { data: Map<string, string> };
}

export function fakes(options: FakeOptions = {}): Fakes {
  const rendered: number[] = [];
  const opened: string[] = [];
  const channels: Channel[] = [];
  const requests: AskRequest[] = [];
  const aborted: boolean[] = [];
  const feedbacks: FeedbackRequest[] = [];
  let destroyed = 0;

  const view: PageView = {
    scale: 1,
    originX: 0,
    originY: 0,
    heightPoints: 800,
    overlay: true,
    ...options.view,
  };
  const pdf: PdfBook = {
    pageCount: 12,
    render: (page, surface) => {
      rendered.push(page);
      const span = document.createElement("span");
      span.textContent = options.textLayer ?? "";
      surface.textLayer.replaceChildren(span);
      return Promise.resolve(view);
    },
    destroy: () => {
      destroyed++;
      return Promise.resolve();
    },
  };

  const getBook = vi.fn(() => Promise.resolve(options.book ?? BOOK));
  const getHighlights = vi.fn(
    (from: number, to: number): Promise<HighlightResponse> =>
      options.highlights?.(from, to) ??
      Promise.resolve({
        docId: DOC,
        pages: [{ number: 3, boxes: [{ x: 100, y: 700, width: 200, height: 12 }] }],
      }),
  );
  const ask = vi.fn((request: AskRequest, signal?: AbortSignal) => {
    requests.push(request);
    const index = channels.length;
    aborted.push(false);
    const stream = channel();
    channels.push(stream);
    signal?.addEventListener("abort", () => {
      aborted[index] = true;
      stream.fail(new DOMException("aborted", "AbortError"));
    });
    if (options.askFails !== undefined) stream.fail(options.askFails);
    return stream.iterate();
  });

  const client: ApiClient = {
    getBook,
    ask,
    getHighlights,
    sendFeedback: (request) => {
      feedbacks.push(request);
      return (
        options.feedback?.(request) ??
        Promise.resolve<FeedbackResponse>({ answerId: request.answerId, saved: true })
      );
    },
    getPage: (number) => {
      const { text, start } = options.pageText?.(number) ?? {
        text: `Text of page ${number.toString()}.`,
        start: 1000,
      };
      return Promise.resolve<PageResponse>({
        docId: DOC,
        title: "Vectors",
        number,
        pageCount: 12,
        text,
        span: { start, end: start + text.length },
      });
    },
    pdfUrl: (doc?: string) => `/api/book/pdf${doc === undefined ? "" : `?doc=${doc}`}`,
  };

  const data = new Map<string, string>();
  return {
    client,
    getBook,
    ask,
    getHighlights,
    channels,
    feedbacks,
    requests,
    aborted,
    rendered,
    opened,
    destroyed: () => destroyed,
    openPdf: (url) => {
      opened.push(url);
      return options.openFails === true
        ? Promise.reject(new Error("Missing PDF"))
        : Promise.resolve(pdf);
    },
    storage: {
      data,
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
    },
  };
}

export function mount(f: Fakes, doc?: string) {
  return render(
    <App
      client={f.client}
      openPdf={f.openPdf}
      storage={f.storage}
      {...(doc === undefined ? {} : { doc })}
    />,
  );
}

/** The page the reader says it is on, from the page box. */
export const pageBox = (): HTMLInputElement => screen.getByLabelText("Page number");

/** jsdom has no layout: give the reading area a width, and a ResizeObserver that never fires. */
export function installDomStubs(): void {
  window.history.replaceState(null, "", "/");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 800 });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
}
