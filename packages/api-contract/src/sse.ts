import { askEventSchema } from "./schemas.js";
import type { AskEvent } from "./schemas.js";

// Server-sent events, read by a client. `EventSource` only does GET and `POST /ask` carries a body,
// so the browser reads the response with `fetch` and decodes the frames itself. This is the small
// function ADR-0006 promised: no Node built-ins, so it runs in a browser.

/** One frame of an event stream, before its data is understood. */
export interface SseFrame {
  readonly event: string;
  /** The `data:` lines of the frame, joined with a newline. */
  readonly data: string;
}

/** The server sent something that is not an event of the contract. */
export class ContractError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ContractError";
  }
}

/**
 * Cuts an event stream into frames. Text arrives in pieces that can end anywhere, even in the middle
 * of a line, so `push` keeps what is not finished and gives back only whole frames.
 *
 * It follows the rules of the format: lines end with `\n`, `\r\n` or `\r`; a blank line ends a frame;
 * a line starting with `:` is a comment; `event:` names the frame (default `message`); several `data:`
 * lines are joined with `\n`; one space after the colon is dropped; `id:` and `retry:` are ignored.
 */
export class SseParser {
  #buffer = "";
  #event = "";
  #data: string[] = [];

  push(chunk: string): SseFrame[] {
    this.#buffer += chunk;

    const frames: SseFrame[] = [];
    for (;;) {
      // a `\r` at the very end waits: the next chunk may start with the `\n` that goes with it
      const end = /\r\n|\n|\r(?!$)/.exec(this.#buffer);
      if (end === null) break;
      const line = this.#buffer.slice(0, end.index);
      this.#buffer = this.#buffer.slice(end.index + end[0].length);
      const frame = this.#line(line);
      if (frame !== undefined) frames.push(frame);
    }
    return frames;
  }

  /** The frame still open when the stream ends. A frame is complete only after its blank line. */
  flush(): SseFrame[] {
    return [];
  }

  #line(line: string): SseFrame | undefined {
    if (line === "") {
      if (this.#data.length === 0) {
        this.#event = "";
        return undefined;
      }
      const frame = {
        event: this.#event === "" ? "message" : this.#event,
        data: this.#data.join("\n"),
      };
      this.#event = "";
      this.#data = [];
      return frame;
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.#event = value;
    else if (field === "data") this.#data.push(value);
    return undefined;
  }
}

/**
 * Turns a frame into an event of the contract.
 * @throws ContractError if the name is unknown, the data is not JSON, or it is not the right shape
 */
export function decodeAskEvent(frame: SseFrame): AskEvent {
  let data: unknown;
  try {
    data = JSON.parse(frame.data);
  } catch (cause) {
    throw new ContractError(`The "${frame.event}" event does not carry JSON`, { cause });
  }
  const parsed = askEventSchema.safeParse({ event: frame.event, data });
  if (!parsed.success) {
    throw new ContractError(
      `The "${frame.event}" event is not what the contract says: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

/**
 * Reads the events of an answer as they arrive: `for await (const event of readAskEvents(body))`.
 * Stops when the stream ends. It does not check that the stream ended with `done` or `error`; a
 * client that needs to know the answer was cut short can see that neither came.
 *
 * @param body the `body` of the response to `POST /ask`
 * @throws ContractError for a frame that is not an event of the contract
 */
export async function* readAskEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AskEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      for (const frame of parser.push(text)) yield decodeAskEvent(frame);
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
