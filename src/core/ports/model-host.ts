/**
 * A server that hosts models (Ollama today). Diagnostics use it to ask what is installed without
 * knowing which server it is.
 */
export interface ModelHost {
  /** Product name, for messages: "Ollama". */
  readonly name: string;
  /** Where it listens, for messages: "http://127.0.0.1:11434". */
  readonly address: string;
  /** Commands the user can run to fix a problem. */
  readonly hints: {
    /** How to start the server. */
    readonly start: string;
    /** How to install a model. */
    pull(model: string): string;
  };
  /**
   * Names of the installed models, e.g. "all-minilm:latest". Rejects with a RagError coded
   * PROVIDER_UNAVAILABLE when the server cannot be reached or does not answer as expected.
   */
  listModels(signal?: AbortSignal): Promise<readonly string[]>;
}
