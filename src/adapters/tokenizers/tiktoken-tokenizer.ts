import { getEncoding } from "js-tiktoken";
import type { Tiktoken } from "js-tiktoken";
import type { Tokenizer } from "../../core/index.js";

/**
 * Counts tokens with the cl100k_base vocabulary (js-tiktoken). Exact for OpenAI models and a close
 * estimate for most others, including the local models served by Ollama.
 *
 * The vocabulary loads when the tokenizer is created, not when it is imported.
 */
export class TiktokenTokenizer implements Tokenizer {
  readonly name = "tiktoken";
  private readonly encoding: Tiktoken = getEncoding("cl100k_base");

  count(text: string): number {
    return this.encode(text).length;
  }

  encode(text: string): readonly number[] {
    // Special tokens are neither allowed nor banned, so text that contains a special-token string
    // (e.g. "<|endoftext|>") is encoded as ordinary text instead of throwing or becoming one token.
    return this.encoding.encode(text, [], []);
  }
}
