/**
 * Stable, machine-readable error codes. Callers and tests branch on these, never on message text,
 * so a code must never change meaning. Add new codes here as tickets need them.
 */
export type RagErrorCode =
  "CONFIG_INVALID" | "INGESTION_FAILED" | "INVALID_ARGUMENT" | "PROVIDER_UNAVAILABLE" | "INTERNAL";

export interface RagErrorOptions {
  /** The lower-level error that caused this one (a failed fetch, a parse error, ...). */
  readonly cause?: unknown;
}

/** The error type for every failure the pipeline reports on purpose. */
export class RagError extends Error {
  readonly code: RagErrorCode;

  constructor(code: RagErrorCode, message: string, options: RagErrorOptions = {}) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = "RagError";
    this.code = code;
  }

  toJSON(): SerializedError {
    return serializeError(this);
  }
}

export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly stack?: string;
  readonly cause?: SerializedError;
}

const MAX_CAUSE_DEPTH = 5;

/** Turns any thrown value into plain data that can be logged as JSON, following `cause` chains. */
export function serializeError(error: unknown, depth = 0): SerializedError {
  if (!(error instanceof Error)) {
    return { name: "NonError", message: String(error) };
  }
  const code = error instanceof RagError ? error.code : undefined;
  return {
    name: error.name,
    message: error.message,
    ...(code === undefined ? {} : { code }),
    ...(error.stack === undefined ? {} : { stack: error.stack }),
    ...(error.cause === undefined || depth >= MAX_CAUSE_DEPTH
      ? {}
      : { cause: serializeError(error.cause, depth + 1) }),
  };
}
