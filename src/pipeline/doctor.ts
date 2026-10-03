import type { ModelHost } from "../core/index.js";

export interface RequiredModel {
  readonly model: string;
  /** What the project uses it for, e.g. "embedding". */
  readonly purpose: string;
}

export type CheckStatus = "ok" | "fail" | "skip";

export interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  /** What to do about a failure. */
  readonly fix?: string;
}

/** "all-minilm" and "all-minilm:latest" are the same model; a name with another tag is not. */
export function hasModel(installed: readonly string[], required: string): boolean {
  const withTag = (name: string): string => (name.includes(":") ? name : `${name}:latest`);
  const wanted = withTag(required);
  return installed.some((name) => withTag(name) === wanted);
}

/** The same model needed for two purposes is checked once. */
function mergeByModel(required: readonly RequiredModel[]): RequiredModel[] {
  const merged = new Map<string, RequiredModel>();
  for (const item of required) {
    const existing = merged.get(item.model);
    merged.set(
      item.model,
      existing === undefined
        ? item
        : { model: item.model, purpose: `${existing.purpose}, ${item.purpose}` },
    );
  }
  return [...merged.values()];
}

/**
 * Checks that the model host is reachable and that every required model is installed. Never
 * throws: every problem becomes a failed result with the fix to try.
 */
export async function runDoctor(
  host: ModelHost,
  required: readonly RequiredModel[],
): Promise<readonly CheckResult[]> {
  const models = mergeByModel(required);
  if (models.length === 0) {
    return [
      { name: host.name, status: "skip", detail: "the configuration uses no models from it" },
    ];
  }

  let installed: readonly string[];
  try {
    installed = await host.listModels();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [
      {
        name: `${host.name} is reachable`,
        status: "fail",
        detail: reason,
        fix: `${host.hints.start}. If it runs somewhere else, set OLLAMA_HOST in .env (see .env.example).`,
      },
      ...models.map(({ model, purpose }): CheckResult => ({
        name: `Model ${model} (${purpose})`,
        status: "skip",
        detail: `cannot check without ${host.name}`,
      })),
    ];
  }

  return [
    { name: `${host.name} is reachable`, status: "ok", detail: host.address },
    ...models.map(({ model, purpose }): CheckResult => {
      const name = `Model ${model} (${purpose})`;
      return hasModel(installed, model)
        ? { name, status: "ok", detail: "installed" }
        : { name, status: "fail", detail: "not installed", fix: host.hints.pull(model) };
    }),
  ];
}
