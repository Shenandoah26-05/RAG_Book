import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePromptTemplate } from "./prompt-template.js";

describe("parsePromptTemplate", () => {
  it("reads the id and version from the file name", () => {
    expect(parsePromptTemplate("rag-system.v2.txt", "Sources:\n{{sources}}")).toEqual({
      id: "rag-system",
      version: "v2",
      text: "Sources:\n{{sources}}",
    });
  });

  it.each(["rag-system.txt", "rag-system.v1.md", "RagSystem.v1.txt", "v1.txt"])(
    "rejects the file name %s",
    (name) => {
      expect(() => parsePromptTemplate(name, "{{sources}}")).toThrow(/<id>\.v<N>\.txt/);
    },
  );

  it("needs the sources placeholder exactly once", () => {
    expect(() => parsePromptTemplate("p.v1.txt", "no placeholder")).toThrow(/found 0/);
    expect(() => parsePromptTemplate("p.v1.txt", "{{sources}} {{sources}}")).toThrow(/found 2/);
  });

  it("accepts the shipped prompt file", () => {
    const url = new URL("../../../prompts/rag-system.v1.txt", import.meta.url);
    const template = parsePromptTemplate("rag-system.v1.txt", readFileSync(url, "utf8"));
    expect(template.version).toBe("v1");
  });
});
