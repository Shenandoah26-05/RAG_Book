import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config/index.js";
import { expandVariants } from "../eval/index.js";

const DIR = path.resolve("evals", "experiments");
const files = (await readdir(DIR)).filter((f) => f.endsWith(".json")).sort();

// The experiments that ship with the project must stay runnable: a rename of a config key or a
// strategy would otherwise be found only when someone starts a long run.
describe.each(files)("evals/experiments/%s", (file) => {
  it("expands into variants whose configs the config loader accepts", async () => {
    const { experiment, variants } = expandVariants(
      JSON.parse(await readFile(path.join(DIR, file), "utf8")) as unknown,
    );
    expect(experiment.name).toBe(file.replace(/\.json$/, ""));
    expect(variants.length).toBeGreaterThan(0);
    for (const variant of variants) {
      expect(() => resolveConfig({ file: variant.config, fileLabel: variant.name })).not.toThrow();
    }
  });

  it("points at a dataset that exists", async () => {
    const { experiment } = expandVariants(
      JSON.parse(await readFile(path.join(DIR, file), "utf8")) as unknown,
    );
    await expect(readFile(experiment.dataset, "utf8")).resolves.toContain("q001");
  });
});

it("ships at least one experiment", () => {
  expect(files.length).toBeGreaterThan(0);
});
