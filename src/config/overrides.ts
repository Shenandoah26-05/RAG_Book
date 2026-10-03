import { DEFAULT_CONFIG } from "./defaults.js";

/** A value someone asked for, before it has been checked against the type of the setting. */
export interface RawOverride {
  readonly path: readonly string[];
  readonly raw: string;
  /** Where it came from, for error messages: "RAG_CHUNKING__MAX_TOKENS" or "--chunking.max-tokens". */
  readonly source: string;
}

export type PlainObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const screamingToCamel = (part: string): string =>
  part.toLowerCase().replace(/_([a-z0-9])/g, (_match, ch: string) => ch.toUpperCase());

const kebabToCamel = (part: string): string =>
  part.replace(/-([a-z0-9])/g, (_match, ch: string) => ch.toUpperCase());

/** The default value at `path`, which also tells us the type a setting must have. */
function defaultAt(path: readonly string[]): unknown {
  let node: unknown = DEFAULT_CONFIG;
  for (const key of path) {
    if (!isPlainObject(node) || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

/**
 * Environment variables named `RAG_<SECTION>__<KEY>`, with `__` between levels and `_` inside a
 * name: `RAG_CHUNKING__MAX_TOKENS=300` sets `chunking.maxTokens`. Variables without `__`
 * (such as RAG_CONFIG) are not settings and are ignored.
 */
export function envOverrides(
  env: Readonly<Record<string, string | undefined>>,
): readonly RawOverride[] {
  const overrides: RawOverride[] = [];
  for (const [key, raw] of Object.entries(env)) {
    if (raw === undefined || !key.startsWith("RAG_") || !key.includes("__")) continue;
    overrides.push({
      path: key.slice("RAG_".length).split("__").map(screamingToCamel),
      raw,
      source: key,
    });
  }
  return overrides;
}

export interface CliOverrides {
  readonly overrides: readonly RawOverride[];
  readonly errors: readonly string[];
}

/**
 * Flags named `--<section>.<key>`, in kebab-case: `--chunking.max-tokens 300` or
 * `--chunking.max-tokens=300`. A true/false setting may be given bare: `--rerank.enabled`.
 * Anything without a dot (`--config`, `--strategy`) belongs to the command and is skipped.
 */
export function cliOverrides(argv: readonly string[]): CliOverrides {
  const overrides: RawOverride[] = [];
  const errors: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--") !== true) continue;

    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (!flag.includes(".")) continue;

    const path = flag.slice(2).split(".").map(kebabToCamel);
    let raw: string | undefined = eq === -1 ? undefined : arg.slice(eq + 1);

    if (raw === undefined) {
      const next = argv[i + 1];
      if (typeof defaultAt(path) === "boolean") {
        raw = next !== undefined && /^(true|false)$/i.test(next) ? next : "true";
        if (raw === next) i++;
      } else if (next === undefined || next.startsWith("--")) {
        errors.push(`${flag}: needs a value`);
        continue;
      } else {
        raw = next;
        i++;
      }
    }
    overrides.push({ path, raw, source: flag });
  }
  return { overrides, errors };
}

type Coerced =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

/** Turns the text of an override into the type of the setting it replaces. */
function coerce(template: unknown, raw: string): Coerced {
  if (typeof template === "string") return { ok: true, value: raw };

  if (typeof template === "number") {
    const value = Number(raw);
    return raw.trim() === "" || Number.isNaN(value)
      ? { ok: false, error: `expected a number, got "${raw}"` }
      : { ok: true, value };
  }

  if (typeof template === "boolean") {
    const lowered = raw.trim().toLowerCase();
    if (lowered === "true" || lowered === "1") return { ok: true, value: true };
    if (lowered === "false" || lowered === "0") return { ok: true, value: false };
    return { ok: false, error: `expected true or false, got "${raw}"` };
  }

  // A list of names: JSON (`["a","b"]`) or comma separated (`a,b`).
  if (raw.trim().startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return { ok: true, value: parsed };
    } catch {
      // fall through to the error below
    }
    return { ok: false, error: `expected a JSON list, got "${raw}"` };
  }
  return {
    ok: true,
    value: raw
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  };
}

function setAt(target: PlainObject, path: readonly string[], value: unknown): void {
  let node = target;
  for (const key of path.slice(0, -1)) {
    const existing = node[key];
    if (isPlainObject(existing)) {
      node = existing;
    } else {
      const created: PlainObject = {};
      node[key] = created;
      node = created;
    }
  }
  const last = path.at(-1);
  if (last !== undefined) node[last] = value;
}

export interface AppliedOverrides {
  /** A nested object holding only the overridden settings, ready to merge over the defaults. */
  readonly patch: PlainObject;
  readonly errors: readonly string[];
}

/** Checks each override against the known settings and builds a patch from the valid ones. */
export function applyOverrides(overrides: readonly RawOverride[]): AppliedOverrides {
  const patch: PlainObject = {};
  const errors: string[] = [];

  for (const { path, raw, source } of overrides) {
    const template = defaultAt(path);
    if (template === undefined) {
      errors.push(`${source}: unknown setting "${path.join(".")}"`);
    } else {
      const result = coerce(template, raw);
      if (result.ok) setAt(patch, path, result.value);
      else errors.push(`${source}: ${result.error}`);
    }
  }
  return { patch, errors };
}
