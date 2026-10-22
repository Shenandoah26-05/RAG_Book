import { RagError } from "../../shared/index.js";
import { experimentSchema, VARIANT_NAME } from "./schema.js";
import type { Experiment } from "./schema.js";

/** More than this is a mistake in the matrix, not an experiment. */
export const MAX_VARIANTS = 200;

type Plain = Record<string, unknown>;

const isPlain = (value: unknown): value is Plain =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One variant, ready to run. */
export interface ExperimentVariant {
  readonly name: string;
  /** What this variant changes: the matrix assignments and the variant's own config, merged. */
  readonly settings: Readonly<Plain>;
  /** The whole partial config to run with: `base` with `settings` on top. */
  readonly config: Readonly<Plain>;
}

/** Objects merge key by key; anything else (lists too) is replaced by the later value. */
function merge(base: unknown, patch: unknown): unknown {
  if (!isPlain(base) || !isPlain(patch)) return patch;
  const result: Plain = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    result[key] = key in base ? merge(base[key], value) : value;
  }
  return result;
}

/** `{"retrieval.k": 5}` as `{ retrieval: { k: 5 } }`. */
function expandPath(path: string, value: unknown): Plain {
  return path
    .split(".")
    .reverse()
    .reduce<unknown>((inner, key) => ({ [key]: inner }), value) as Plain;
}

/** One chosen value of one matrix axis: `retrieval.k` is 3. */
interface Assignment {
  readonly path: string;
  readonly value: string | number | boolean;
}

/** Every combination of the matrix values, first axis varying slowest. */
function combinations(
  matrix: Readonly<Record<string, readonly (string | number | boolean)[]>>,
): Assignment[][] {
  // no axes is no variants, not one empty combination
  if (Object.keys(matrix).length === 0) return [];
  return Object.entries(matrix).reduce<Assignment[][]>(
    (rows, [path, values]) =>
      rows.flatMap((row) => values.map((value) => [...row, { path, value }])),
    [[]],
  );
}

const safe = (text: string): string => text.replace(/[^A-Za-z0-9._=+-]+/g, "-");

/**
 * Turns an experiment into the list of variants to run: the written-out `variants` first, then one
 * per combination of the `matrix`. A matrix variant is named after its values,
 * `retrieval.strategy=dense+retrieval.k=3`, so a result names exactly what was changed.
 *
 * @param input the parsed JSON of an experiment file
 * @throws RagError INVALID_ARGUMENT for a malformed experiment, a name used twice, or more than
 * `MAX_VARIANTS` variants
 */
export function expandVariants(input: unknown): {
  readonly experiment: Experiment;
  readonly variants: readonly ExperimentVariant[];
} {
  const parsed = experimentSchema.safeParse(input);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`,
    );
    throw new RagError("INVALID_ARGUMENT", `Invalid experiment:\n  ${problems.join("\n  ")}`);
  }
  const experiment = parsed.data;

  const written: ExperimentVariant[] = experiment.variants.map((variant) => ({
    name: variant.name,
    settings: variant.config,
    config: merge(experiment.base, variant.config) as Plain,
  }));

  const fromMatrix: ExperimentVariant[] = combinations(experiment.matrix).map((row) => {
    const settings = row.reduce<unknown>(
      (acc, { path, value }) => merge(acc, expandPath(path, value)),
      {},
    ) as Plain;
    const name = safe(row.map(({ path, value }) => `${path}=${String(value)}`).join("+"));
    return { name, settings, config: merge(experiment.base, settings) as Plain };
  });

  const variants = [...written, ...fromMatrix];
  if (variants.length > MAX_VARIANTS) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `The experiment has ${variants.length.toString()} variants; the most allowed is ${MAX_VARIANTS.toString()}. Narrow the matrix.`,
    );
  }
  const seen = new Set<string>();
  for (const { name } of variants) {
    if (!VARIANT_NAME.test(name) || seen.has(name)) {
      throw new RagError(
        "INVALID_ARGUMENT",
        seen.has(name)
          ? `Two variants are called "${name}"; names must be unique`
          : `"${name}" is not a usable variant name`,
      );
    }
    seen.add(name);
  }
  return { experiment, variants };
}
