import type { LlmProvider } from "../../core/index.js";

/** What a transformer asks of the model: one short, predictable reply. */
export interface CompletionSettings {
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Asks the model one thing and returns the whole reply. A transformer needs the finished text, so
 * the stream is read to the end here. Temperature is 0: a rewrite should not vary between runs.
 *
 * @throws whatever the provider throws (PROVIDER_UNAVAILABLE), or the signal's reason if aborted
 */
export async function completeText(
  llm: LlmProvider,
  prompt: string,
  settings: CompletionSettings,
): Promise<string> {
  let text = "";
  const stream = llm.chat([{ role: "user", content: prompt }], {
    temperature: 0,
    maxOutputTokens: settings.maxOutputTokens,
    ...(settings.signal === undefined ? {} : { signal: settings.signal }),
  });
  for await (const delta of stream) {
    if (delta.kind === "text") text += delta.text;
  }
  return text.trim();
}
