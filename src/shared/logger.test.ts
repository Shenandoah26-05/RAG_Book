import { describe, expect, it, vi } from "vitest";
import { RagError } from "./errors.js";
import { createConsoleLogger, createJsonLogger, noopLogger } from "./logger.js";

const NOW = new Date("2026-10-03T12:00:00.000Z");

function capture() {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line), now: () => NOW };
}

describe("console logger", () => {
  it("writes one readable line with level, message and fields", () => {
    const out = capture();
    createConsoleLogger(out).info("embedded", { count: 32, model: "all-minilm" });
    expect(out.lines).toEqual([
      "2026-10-03T12:00:00.000Z INFO  embedded count=32 model=all-minilm",
    ]);
  });

  it("quotes values that need it", () => {
    const out = capture();
    createConsoleLogger(out).warn("slow", { query: "what is RAG?", ok: false, tags: ["a", "b"] });
    expect(out.lines[0]).toBe(
      '2026-10-03T12:00:00.000Z WARN  slow query="what is RAG?" ok=false tags=["a","b"]',
    );
  });

  it("shows an Error's name and message", () => {
    const out = capture();
    createConsoleLogger(out).error("failed", { error: new RagError("INTERNAL", "bad state") });
    expect(out.lines[0]).toContain('error="RagError: bad state"');
  });

  it("writes to standard error by default, never to standard output", () => {
    const toStderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const toStdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      createConsoleLogger({ now: () => NOW }).info("hello");
      expect(toStderr).toHaveBeenCalledExactlyOnceWith("2026-10-03T12:00:00.000Z INFO  hello\n");
      expect(toStdout).not.toHaveBeenCalled();
    } finally {
      toStderr.mockRestore();
      toStdout.mockRestore();
    }
  });
});

describe("JSON logger", () => {
  it("writes one JSON object per line", () => {
    const out = capture();
    createJsonLogger(out).info("embedded", { count: 32 });
    expect(out.lines).toHaveLength(1);
    expect(JSON.parse(out.lines[0] ?? "")).toEqual({
      time: "2026-10-03T12:00:00.000Z",
      level: "info",
      message: "embedded",
      count: 32,
    });
  });

  it("serialises errors with their code and cause", () => {
    const out = capture();
    const error = new RagError("PROVIDER_UNAVAILABLE", "down", {
      cause: new Error("ECONNREFUSED"),
    });
    createJsonLogger(out).error("failed", { error });

    const record = JSON.parse(out.lines[0] ?? "") as { error: Record<string, unknown> };
    expect(record.error).toMatchObject({
      name: "RagError",
      code: "PROVIDER_UNAVAILABLE",
      message: "down",
      cause: { message: "ECONNREFUSED" },
    });
  });

  it("keeps time, level and message from being overwritten by fields", () => {
    const out = capture();
    createJsonLogger(out).info("real", { message: "fake", level: "fake", time: "fake" });
    expect(JSON.parse(out.lines[0] ?? "")).toMatchObject({
      message: "real",
      level: "info",
      time: "2026-10-03T12:00:00.000Z",
    });
  });

  it("copes with bigints and circular values", () => {
    const out = capture();
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const logger = createJsonLogger(out);
    logger.info("big", { n: 10n });
    logger.info("loop", { circular });

    expect(JSON.parse(out.lines[0] ?? "")).toMatchObject({ n: "10" });
    expect(out.lines).toHaveLength(2);
    expect(JSON.parse(out.lines[1] ?? "")).toBe("[unserializable]");
  });
});

describe("levels, children and the no-op logger", () => {
  it("drops records below the minimum level (default info)", () => {
    const out = capture();
    const logger = createJsonLogger(out);
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(out.lines.map((l) => (JSON.parse(l) as { level: string }).level)).toEqual([
      "info",
      "warn",
      "error",
    ]);
  });

  it("can be set to debug or to error", () => {
    const debug = capture();
    createJsonLogger({ ...debug, level: "debug" }).debug("d");
    expect(debug.lines).toHaveLength(1);

    const errors = capture();
    const logger = createJsonLogger({ ...errors, level: "error" });
    logger.warn("w");
    logger.error("e");
    expect(errors.lines).toHaveLength(1);
  });

  it("child loggers add their fields to every record, and call-site fields win", () => {
    const out = capture();
    const logger = createJsonLogger(out).child({ stage: "embed", run: 1 });
    logger.info("a");
    logger.child({ batch: 3 }).info("b", { run: 2 });

    expect(JSON.parse(out.lines[0] ?? "")).toMatchObject({ stage: "embed", run: 1 });
    expect(JSON.parse(out.lines[1] ?? "")).toMatchObject({ stage: "embed", run: 2, batch: 3 });
  });

  it("child loggers keep the parent's level", () => {
    const out = capture();
    createJsonLogger({ ...out, level: "warn" })
      .child({ a: 1 })
      .info("dropped");
    expect(out.lines).toEqual([]);
  });

  it("the no-op logger accepts everything and writes nothing", () => {
    expect(() => {
      noopLogger.info("x");
      noopLogger.child({ a: 1 }).error("y", { b: 2 });
    }).not.toThrow();
  });
});
