import type { ErrorBody, ErrorCode } from "@rag-book/api-contract";
import { RagError } from "../shared/index.js";

/** The status line and body for a failure. */
export interface ErrorAnswer {
  readonly status: 400 | 404 | 413 | 415 | 500 | 503;
  readonly body: ErrorBody;
}

/** What the library's error codes mean to a client. A code never changes meaning. */
const BY_RAG_CODE: Readonly<
  Record<RagError["code"], { status: ErrorAnswer["status"]; code: ErrorCode }>
> = {
  INVALID_ARGUMENT: { status: 400, code: "INVALID_REQUEST" },
  PROVIDER_UNAVAILABLE: { status: 503, code: "PROVIDER_UNAVAILABLE" },
  INDEX_CORRUPT: { status: 500, code: "INDEX_UNAVAILABLE" },
  CONFIG_INVALID: { status: 500, code: "INTERNAL" },
  INGESTION_FAILED: { status: 500, code: "INTERNAL" },
  INTERNAL: { status: 500, code: "INTERNAL" },
};

/**
 * Turns any thrown value into an answer for the client.
 *
 * A `RagError` is a failure the library reports on purpose, in words written for a person (and with
 * any API key already taken out), so its message is passed on. Anything else is a bug or a failure
 * of something below the library, and its message may name a path or a stack: the client gets a
 * plain sentence, and the caller logs the real error.
 */
export function describeError(error: unknown): ErrorAnswer {
  if (error instanceof RagError) {
    const mapped = BY_RAG_CODE[error.code];
    return { status: mapped.status, body: { code: mapped.code, message: error.message } };
  }
  return {
    status: 500,
    body: { code: "INTERNAL", message: "Something went wrong on the server." },
  };
}

/** A request that could not be understood. */
export function invalidRequest(
  message: string,
  issues?: ErrorBody["issues"],
  status: 400 | 413 | 415 = 400,
): ErrorAnswer {
  return {
    status,
    body: { code: "INVALID_REQUEST", message, ...(issues === undefined ? {} : { issues }) },
  };
}

/** Something that is not there. */
export function notFound(message: string): ErrorAnswer {
  return { status: 404, body: { code: "NOT_FOUND", message } };
}
