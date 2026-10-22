import {
  bookResponseSchema,
  errorResponseSchema,
  pageResponseSchema,
} from "@rag-book/api-contract";
import type { BookResponse, PageResponse } from "@rag-book/api-contract";

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
  ): Promise<T> {
    let response: Response;
    try {
      response = await call(`${base}${path}`, signal === undefined ? {} : { signal });
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

  return {
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
