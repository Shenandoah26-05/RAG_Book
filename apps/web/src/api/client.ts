import {
  bookResponseSchema,
  ContractError,
  errorResponseSchema,
  feedbackResponseSchema,
  highlightResponseSchema,
  pageResponseSchema,
  readAskEvents,
} from "@rag-book/api-contract";
import type {
  AskEvent,
  AskRequest,
  BookResponse,
  FeedbackRequest,
  FeedbackResponse,
  HighlightResponse,
  PageResponse,
} from "@rag-book/api-contract";

/**
 * Why a call to the API failed, in terms a reader can act on:
 * - `unreachable`: nothing answered (the API is not running, or the address is wrong)
 * - `api`: the API answered with an error, and `message` is its own
 * - `invalid-response`: something answered, but not in the contract's shape (the wrong server, or a
 *   version of the API this page does not match)
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: "unreachable" | "api" | "invalid-response",
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClient {
  getBook(doc?: string, signal?: AbortSignal): Promise<BookResponse>;
  getPage(number: number, doc?: string, signal?: AbortSignal): Promise<PageResponse>;
  /** Where the PDF is, for pdf.js to load in ranges. */
  pdfUrl(doc?: string): string;
  /** Where the passage `[from, to)` of the text is, as boxes on its pages. */
  getHighlights(
    from: number,
    to: number,
    doc?: string,
    signal?: AbortSignal,
  ): Promise<HighlightResponse>;
  /**
   * Asks a question. The answer arrives as events: `token`s, then `citations`, `trace` and `done`
   * (or `error`). The request itself failing (the API is not running, the question is refused before
   * the answer starts) rejects with an `ApiError` when the first event is read.
   */
  ask(request: AskRequest, signal?: AbortSignal): AsyncGenerator<AskEvent>;
  /**
   * Gives the API a rating of an answer, with the answer. Rating the same `answerId` again replaces
   * the earlier rating. Rejects when it could not be kept: the reader must know it was not.
   */
  sendFeedback(request: FeedbackRequest, signal?: AbortSignal): Promise<FeedbackResponse>;
}

export interface ApiClientOptions {
  /** The API's address with no trailing slash: `/api` in development, or `http://host:port`. */
  readonly baseUrl: string;
  /** For tests. Default: the browser's `fetch`. */
  readonly fetch?: typeof fetch;
}

const query = (doc: string | undefined): string =>
  doc === undefined ? "" : `?doc=${encodeURIComponent(doc)}`;

export function createApiClient(options: ApiClientOptions): ApiClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const call = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function getJson<T>(
    path: string,
    parse: (json: unknown) => T | undefined,
    signal: AbortSignal | undefined,
    init: RequestInit = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await call(`${base}${path}`, signal === undefined ? init : { ...init, signal });
    } catch (error) {
      if (signal?.aborted === true) throw error;
      throw new ApiError("Cannot reach the API. Start it with: pnpm api", "unreachable");
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ApiError(
        `The server did not answer with JSON (status ${response.status.toString()}). Is it the RAG Book API?`,
        "invalid-response",
        response.status,
      );
    }
    if (!response.ok) {
      const failure = errorResponseSchema.safeParse(json);
      throw new ApiError(
        failure.success
          ? failure.data.error.message
          : `The API answered ${response.status.toString()}.`,
        "api",
        response.status,
        failure.success ? failure.data.error.code : undefined,
      );
    }
    const parsed = parse(json);
    if (parsed === undefined) {
      throw new ApiError(
        "The API answered in a shape this page does not understand. Update both to the same version.",
        "invalid-response",
        response.status,
      );
    }
    return parsed;
  }

  /** The error an answer that is not a success stands for, in words a reader can act on. */
  async function failureOf(response: Response): Promise<ApiError> {
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return new ApiError(
        `The API answered ${response.status.toString()}.`,
        "api",
        response.status,
      );
    }
    const failure = errorResponseSchema.safeParse(json);
    return new ApiError(
      failure.success
        ? failure.data.error.message
        : `The API answered ${response.status.toString()}.`,
      "api",
      response.status,
      failure.success ? failure.data.error.code : undefined,
    );
  }

  async function* ask(request: AskRequest, signal?: AbortSignal): AsyncGenerator<AskEvent> {
    let response: Response;
    try {
      response = await call(`${base}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(request),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal?.aborted === true) throw error;
      throw new ApiError("Cannot reach the API. Start it with: pnpm api", "unreachable");
    }
    if (!response.ok) throw await failureOf(response);
    if (response.body === null) {
      throw new ApiError("The API sent no answer.", "invalid-response", response.status);
    }
    try {
      yield* readAskEvents(response.body);
    } catch (error) {
      if (error instanceof ContractError) {
        throw new ApiError(
          "The API answered in a shape this page does not understand. Update both to the same version.",
          "invalid-response",
        );
      }
      // the connection dropped in the middle of the answer, or the reader stopped it
      if (signal?.aborted === true) throw error;
      throw new ApiError("The connection to the API was lost during the answer.", "unreachable");
    }
  }

  return {
    ask,
    sendFeedback: (request, signal) =>
      getJson(
        "/feedback",
        (json) => {
          const parsed = feedbackResponseSchema.safeParse(json);
          return parsed.success ? parsed.data : undefined;
        },
        signal,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        },
      ),
    getHighlights: (from, to, doc, signal) =>
      getJson(
        `/highlights?from=${from.toString()}&to=${to.toString()}${doc === undefined ? "" : `&doc=${encodeURIComponent(doc)}`}`,
        (json) => {
          const parsed = highlightResponseSchema.safeParse(json);
          return parsed.success ? parsed.data : undefined;
        },
        signal,
      ),
    getBook: (doc, signal) =>
      getJson(
        `/book${query(doc)}`,
        (json) => {
          const parsed = bookResponseSchema.safeParse(json);
          return parsed.success ? parsed.data : undefined;
        },
        signal,
      ),
    getPage: (number, doc, signal) =>
      getJson(
        `/pages/${number.toString()}${query(doc)}`,
        (json) => {
          const parsed = pageResponseSchema.safeParse(json);
          return parsed.success ? parsed.data : undefined;
        },
        signal,
      ),
    pdfUrl: (doc) => `${base}/book/pdf${query(doc)}`,
  };
}
