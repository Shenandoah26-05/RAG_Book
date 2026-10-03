// Public API of src/shared. Named exports only.
export { RagError, serializeError } from "./errors.js";
export type { RagErrorCode, RagErrorOptions, SerializedError } from "./errors.js";
export { createConsoleLogger, createJsonLogger, noopLogger } from "./logger.js";
export type { LogFields, Logger, LoggerOptions, LogLevel, LogRecord } from "./logger.js";
export { Trace } from "./trace.js";
export type { StageHandle, StageRecord, TraceSnapshot, TraceSummary } from "./trace.js";
