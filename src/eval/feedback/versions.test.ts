import { describe, expect, it } from "vitest";
import { nextVersion } from "./versions.js";

describe("nextVersion", () => {
  it("counts on from a numbered version", () => {
    expect(nextVersion("v1")).toBe("v2");
    expect(nextVersion("v9")).toBe("v10");
  });

  it.each(["v1-smoke", "smoke", "1", "v", ""])("has no next version for %j", (version) => {
    expect(nextVersion(version)).toBeUndefined();
  });
});
