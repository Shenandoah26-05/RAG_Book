import { describe, expect, it } from "vitest";
import { fillQueryPrompt, parseQueryPrompt } from "./query-prompt.js";

describe("parseQueryPrompt", () => {
  it("reads the id and version from the file name", () => {
    expect(parseQueryPrompt("hyde.v2.txt", "{{question}}", ["question"])).toEqual({
      id: "hyde",
      version: "v2",
      text: "{{question}}",
    });
  });

  it.each(["hyde.txt", "Hyde.v1.txt", "hyde.v1.md"])("rejects the file name %s", (name) => {
    expect(() => parseQueryPrompt(name, "{{question}}", ["question"])).toThrow(/<id>\.v<N>\.txt/);
  });

  it("needs each placeholder exactly once", () => {
    expect(() => parseQueryPrompt("p.v1.txt", "none", ["question"])).toThrow(/found 0/);
    expect(() => parseQueryPrompt("p.v1.txt", "{{question}}{{question}}", ["question"])).toThrow(
      /found 2/,
    );
    expect(() => parseQueryPrompt("p.v1.txt", "{{question}}", ["question", "count"])).toThrow(
      /\{\{count\}\}/,
    );
  });
});

describe("fillQueryPrompt", () => {
  const template = { id: "p", version: "v1", text: "Q={{question}} N={{count}}" };

  it("fills every placeholder", () => {
    expect(fillQueryPrompt(template, { question: "why?", count: "3" })).toBe("Q=why? N=3");
  });

  it("does not fill again inside a value, and keeps $ patterns literal", () => {
    expect(fillQueryPrompt(template, { question: "{{count}} $& $1", count: "3" })).toBe(
      "Q={{count}} $& $1 N=3",
    );
  });

  it("leaves an unknown placeholder as it is", () => {
    expect(fillQueryPrompt({ ...template, text: "{{other}}" }, {})).toBe("{{other}}");
  });
});
