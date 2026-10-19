import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { RagError } from "../shared/index.js";

/** Where variants are looked up by name. */
export const DEFAULT_VARIANTS_DIR = "configs/variants";

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** The names of the variants in `dir` (the files `<name>.json`), sorted. */
export async function listVariants(dir: string = DEFAULT_VARIANTS_DIR): Promise<readonly string[]> {
  try {
    return (await readdir(dir))
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -".json".length))
      .sort();
  } catch {
    return [];
  }
}

/**
 * The config file of a variant. A variant is a small config file that lists only what it changes
 * (the defaults fill in the rest). `name` is a bare name, looked up as `<dir>/<name>.json`, or a
 * path (anything with a folder or ending in `.json`), used as it is.
 * @throws RagError INVALID_ARGUMENT, listing the variants that exist, if the file is not there
 */
export async function resolveVariant(
  name: string,
  dir: string = DEFAULT_VARIANTS_DIR,
): Promise<string> {
  const isPath = /[\\/]/.test(name) || name.endsWith(".json");
  const file = isPath ? name : path.join(dir, `${name}.json`);
  if (await isFile(file)) return file;

  const known = await listVariants(dir);
  throw new RagError(
    "INVALID_ARGUMENT",
    `No variant "${name}": ${file} does not exist. ` +
      (known.length === 0
        ? `There are no variants in ${dir}.`
        : `Variants in ${dir}: ${known.join(", ")}.`),
  );
}
