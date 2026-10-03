import { describe, expect, it } from "vitest";
import { RagError, serializeError } from "./errors.js";

describe("RagError", () => {
  it("carries a stable code and a message", () => {
    const error = new RagError("PROVIDER_UNAVAILABLE", "Ollama is not reachable");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RagError);
    expect(error.name).toBe("RagError");
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error.message).toBe("Ollama is not reachable");
    expect(error.cause).toBeUndefined();
  });

  it("keeps the underlying cause", () => {
    const cause = new TypeError("fetch failed");
    const error = new RagError("PROVIDER_UNAVAILABLE", "Ollama is not reachable", { cause });
    expect(error.cause).toBe(cause);
  });

  it("serialises to plain data with the code and the cause chain", () => {
    const root = new Error("ECONNREFUSED");
    const error = new RagError("PROVIDER_UNAVAILABLE", "Ollama is not reachable", {
      cause: new RagError("INTERNAL", "request failed", { cause: root }),
    });

    const json = JSON.parse(JSON.stringify(error)) as Record<string, unknown>;
    expect(json).toMatchObject({
      name: "RagError",
      code: "PROVIDER_UNAVAILABLE",
      message: "Ollama is not reachable",
      cause: {
        code: "INTERNAL",
        message: "request failed",
        cause: { name: "Error", message: "ECONNREFUSED" },
      },
    });
  });
});

describe("serializeError", () => {
  it("describes non-Error values", () => {
    expect(serializeError("oops")).toEqual({ name: "NonError", message: "oops" });
    expect(serializeError(undefined)).toEqual({ name: "NonError", message: "undefined" });
  });

  it("does not add a code to plain errors", () => {
    expect(serializeError(new Error("x"))).not.toHaveProperty("code");
  });

  it("stops following causes after a fixed depth, so a cycle cannot loop forever", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    Object.defineProperty(a, "cause", { value: b });

    let depth = 0;
    for (let node = serializeError(a).cause; node !== undefined; node = node.cause) depth++;
    expect(depth).toBe(5);
  });
});
