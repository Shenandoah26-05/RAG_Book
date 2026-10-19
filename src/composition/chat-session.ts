import type { RagConfig } from "../config/index.js";
import type { RagPipeline } from "../pipeline/index.js";
import { CHAT_HELP, describeChatConfig, describeSources, describeTrace } from "./chat-format.js";

/** Where a session writes. The terminal wires these to standard output and standard error. */
export interface ChatOutput {
  /** Answers, sources and command output. Written as given, so a streamed answer can be partial. */
  write(text: string): void;
  /** Problems. A failed question prints here and the session carries on. */
  error(text: string): void;
}

/** Whether the conversation goes on after a line. */
export type ChatResult = "continue" | "quit";

export interface ChatSessionOptions {
  /** Only what the session uses of the pipeline, so a test can stand in for it. */
  readonly pipeline: Pick<RagPipeline, "ask" | "describe">;
  readonly config: RagConfig;
  /** The index in use, `<chunker>__<embedder>`. */
  readonly namespace: string;
  /** The variant in use, shown by `/config`. Undefined means the default configuration. */
  readonly variant?: string | undefined;
  /** How many chunks to use for each question. Default: `retrieval.k`. */
  readonly k?: number | undefined;
  /** Start with `/debug` on. */
  readonly debug?: boolean;
}

/**
 * The conversation behind `pnpm chat`: everything the terminal program does with a line the reader
 * typed, without the terminal. A line is blank (ignored), a `/command`, or a question for the
 * pipeline. Keeping this out of `cli/` is what lets every rule be tested with plain strings.
 *
 * - A question streams its answer as it is written, then prints the sources with page numbers.
 * - A failed question (the model is down, nothing is indexed) prints its message to `error` and the
 *   session carries on; the next question may well work.
 * - Each question stands alone. Follow-up questions and memory are RAG-074.
 */
export class ChatSession {
  readonly #options: ChatSessionOptions;
  #debug: boolean;
  #current: AbortController | undefined;

  constructor(options: ChatSessionOptions) {
    this.#options = options;
    this.#debug = options.debug ?? false;
  }

  /** Whether `/debug` is on. */
  get debug(): boolean {
    return this.#debug;
  }

  /** What to show when the session starts. */
  welcome(): string {
    const { namespace, variant, pipeline } = this.#options;
    return [
      "Ask the book a question. Type /help for commands, /quit to leave.",
      `Index ${namespace}, model ${pipeline.describe().llm}` +
        (variant === undefined ? "" : `, variant ${variant}`),
    ].join("\n");
  }

  /**
   * Stops the answer that is being written, if there is one.
   * @returns whether there was one, so the caller knows whether Ctrl+C meant "stop" or "leave"
   */
  interrupt(): boolean {
    if (this.#current === undefined) return false;
    this.#current.abort();
    return true;
  }

  /** Handles one line the reader typed. Never throws: a failure is printed and the session goes on. */
  async handle(line: string, out: ChatOutput): Promise<ChatResult> {
    const text = line.trim();
    if (text === "") return "continue";
    if (text.startsWith("/")) return this.#command(text, out);
    await this.#ask(text, out);
    return "continue";
  }

  #command(text: string, out: ChatOutput): ChatResult {
    const [name = ""] = text.split(/\s+/);
    switch (name.toLowerCase()) {
      case "/quit":
      case "/exit":
        return "quit";
      case "/help":
        out.write(`${CHAT_HELP}\n`);
        break;
      case "/debug":
        this.#debug = !this.#debug;
        out.write(
          this.#debug ? "Debug on: the trace is shown after each answer.\n" : "Debug off.\n",
        );
        break;
      case "/config": {
        const { config, namespace, variant, pipeline } = this.#options;
        out.write(
          `${describeChatConfig({ config, namespace, variant, parts: pipeline.describe() })}\n`,
        );
        break;
      }
      default:
        out.error(`Unknown command ${name}. Type /help to see the commands.\n`);
    }
    return "continue";
  }

  async #ask(question: string, out: ChatOutput): Promise<void> {
    const controller = new AbortController();
    this.#current = controller;
    let answer: Awaited<ReturnType<ChatSessionOptions["pipeline"]["ask"]>> | undefined;
    let reply = "";
    try {
      answer = await this.#options.pipeline.ask(question, {
        signal: controller.signal,
        ...(this.#options.k === undefined ? {} : { k: this.#options.k }),
      });
      for await (const delta of answer.stream) {
        if (delta.kind === "text") {
          reply += delta.text;
          out.write(delta.text);
        }
      }
      out.write(`\n\n${describeSources(answer.prompt, reply)}\n`);
    } catch (error) {
      if (controller.signal.aborted) {
        out.write("\n[stopped]\n");
      } else {
        out.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
      }
    } finally {
      this.#current = undefined;
    }
    // after a failure too: the trace shows which stage failed, which is what /debug is for
    if (this.#debug && answer !== undefined) {
      out.write(`\n${describeTrace(answer.trace.snapshot(), answer.prompt)}\n`);
    }
  }
}
