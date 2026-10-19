import { describe, expect, it } from "vitest";
import { IdentityQueryTransformer } from "./identity-query-transformer.js";

describe("IdentityQueryTransformer", () => {
  it("returns the question unchanged", async () => {
    const query = { text: "What is a vector?" };
    expect(await new IdentityQueryTransformer().transform(query)).toBe(query);
  });

  it.each(["", "  \n"])("rejects the blank question %j as INVALID_ARGUMENT", async (text) => {
    await expect(new IdentityQueryTransformer().transform({ text })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("is called identity", () => {
    expect(new IdentityQueryTransformer().name).toBe("identity");
  });
});
