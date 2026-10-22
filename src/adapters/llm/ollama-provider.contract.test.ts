import { describeLlmProviderContract } from "../../testing/llm-provider-contract.testing.js";
import type { Script } from "../../testing/llm-provider-contract.testing.js";
import { OllamaProvider } from "./ollama-provider.js";

const line = (value: object): string => `${JSON.stringify(value)}\n`;

/** Ollama's wire format: one JSON object per line. */
function encode(script: Script): string[] {
  const pieces = script.texts.map((content) =>
    line({ message: { role: "assistant", content }, done: false }),
  );
  const { ending } = script;
  if (ending.kind === "end") {
    pieces.push(
      line({
        done: true,
        done_reason: ending.reason,
        ...(ending.outputTokens === undefined ? {} : { eval_count: ending.outputTokens }),
      }),
    );
  } else if (ending.kind === "error") {
    pieces.push(line({ error: ending.message }));
  }
  return pieces;
}

describeLlmProviderContract("OllamaProvider", {
  make: (fetchFn) =>
    new OllamaProvider({ address: "http://h:1", model: "llama3.2", fetch: fetchFn }),
  encode,
});
