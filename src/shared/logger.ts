import { serializeError } from "./errors.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, unknown>>;

/** What the rest of the code uses to report what happened. Fields are data, not text to parse. */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every record, e.g. `{ stage: "embed" }`. */
  child(fields: LogFields): Logger;
}

export interface LogRecord {
  readonly time: Date;
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

export interface LoggerOptions {
  /** Records below this level are dropped. Default "info". */
  readonly level?: LogLevel;
  /** Where each finished line goes (no trailing newline). Default: standard error. */
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
  /** Fields added to every record. */
  readonly fields?: LogFields;
}

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

const writeToStderr = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

function makeLogger(format: (record: LogRecord) => string, options: LoggerOptions): Logger {
  const {
    level: minimum = "info",
    write = writeToStderr,
    now = () => new Date(),
    fields: bound = {},
  } = options;

  const log = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    if (LEVEL_RANK[level] < LEVEL_RANK[minimum]) return;
    write(format({ time: now(), level, message, fields: { ...bound, ...fields } }));
  };

  return {
    debug: (message, fields) => {
      log("debug", message, fields);
    },
    info: (message, fields) => {
      log("info", message, fields);
    },
    warn: (message, fields) => {
      log("warn", message, fields);
    },
    error: (message, fields) => {
      log("error", message, fields);
    },
    child: (fields) => makeLogger(format, { ...options, fields: { ...bound, ...fields } }),
  };
}

/** Makes a value safe for JSON: errors become plain data, bigints become strings. */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return serializeError(value);
  if (typeof value === "bigint") return value.toString();
  return value;
}

function toJson(value: unknown): string {
  try {
    return JSON.stringify(value, jsonReplacer);
  } catch {
    return JSON.stringify("[unserializable]");
  }
}

function formatFieldValue(value: unknown): string {
  if (typeof value === "string" && /^[\w.:/@+-]+$/.test(value)) return value;
  if (value instanceof Error) return toJson(`${value.name}: ${value.message}`);
  return toJson(value);
}

/** Human-readable single lines: `2026-10-03T12:00:00.000Z INFO  embedded count=32 model=all-minilm`. */
function formatConsole(record: LogRecord): string {
  const fields = Object.entries(record.fields)
    .map(([key, value]) => ` ${key}=${formatFieldValue(value)}`)
    .join("");
  return `${record.time.toISOString()} ${record.level.toUpperCase().padEnd(5)} ${record.message}${fields}`;
}

/** One JSON object per line, for machines: time, level and message plus every field. */
function formatJson(record: LogRecord): string {
  return toJson({
    ...record.fields,
    time: record.time.toISOString(),
    level: record.level,
    message: record.message,
  });
}

export function createConsoleLogger(options: LoggerOptions = {}): Logger {
  return makeLogger(formatConsole, options);
}

export function createJsonLogger(options: LoggerOptions = {}): Logger {
  return makeLogger(formatJson, options);
}

/** Discards everything. Use where a Logger is required but nobody is listening (tests). */
export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};
