import {
  normalizeOllamaHost,
  OllamaProvider,
  OpenAiChatProvider,
  OpenAiEndpoint,
} from "../adapters/index.js";
import type { RagConfig } from "../config/index.js";
import type { LlmProvider } from "../core/index.js";
import type { Resilience } from "./build-resilience.js";
import { RagError } from "../shared/index.js";
import { MeteredProvider } from "../strategies/index.js";

type Settings = RagConfig["generation"];

export interface BuildLlmProviderOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** Retries, timeouts and rate limits (RAG-092). Without it the provider is used as it is. */
  readonly resilience?: Resilience;
}

const PROVIDERS: ReadonlyMap<
  string,
  (settings: Settings, options: BuildLlmProviderOptions) => LlmProvider
> = new Map<string, (settings: Settings, options: BuildLlmProviderOptions) => LlmProvider>([
  [
    "ollama",
    (settings, options) =>
      new OllamaProvider({
        address: normalizeOllamaHost((options.env ?? process.env)["OLLAMA_HOST"]),
        model: settings.model,
        temperature: settings.temperature,
        maxOutputTokens: settings.maxOutputTokens,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
  ],
  [
    "openai-compatible",
    (settings, options) =>
      new OpenAiChatProvider({
        endpoint: OpenAiEndpoint.fromEnv(options.env ?? process.env),
        model: settings.model,
        temperature: settings.temperature,
        maxOutputTokens: settings.maxOutputTokens,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
  ],
]);

/** The names accepted in `generation.provider`. */
export const llmProviderNames = (): readonly string[] => [...PROVIDERS.keys()];

/**
 * Builds the language model named in `generation.provider`, with the model, temperature and output
 * limit from the same section. Throws CONFIG_INVALID if there is no such provider.
 */
export function buildLlmProvider(
  settings: Settings,
  options: BuildLlmProviderOptions = {},
): LlmProvider {
  const create = PROVIDERS.get(settings.provider);
  if (create === undefined) {
    throw new RagError(
      "CONFIG_INVALID",
      `Unknown provider "${settings.provider}" in generation.provider. Known providers: ${llmProviderNames().join(", ")}`,
    );
  }
  const provider = create(settings, options);
  // metering is outermost: it records what the caller experienced, retries and waits included
  return new MeteredProvider(
    options.resilience === undefined ? provider : options.resilience.llm(provider),
  );
}
