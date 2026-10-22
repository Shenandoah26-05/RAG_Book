// Fakes for the tests of the resilience decorators. Not part of the build (see tsconfig.build.json).
import type {
  ChatDelta,
  ChatMessage,
  ChatOptions,
  EmbedKind,
  Embedder,
  LlmProvider,
} from "../../core/index.js";
import { RagError } from "../../shared/index.js";

export const transient = (message = "connection reset"): RagError =>
  new RagError("PROVIDER_UNAVAILABLE", message, { retryable: true });
export const permanent = (message = "no such model"): RagError =>
  new RagError("PROVIDER_UNAVAILABLE", message, { retryable: false });

export const text = (value: string): ChatDelta => ({ kind: "text", text: value });
export const end: ChatDelta = { kind: "end", reason: "stop" };

/** One attempt of a scripted model: events to pass on, then maybe a failure. */
export interface Attempt {
  readonly events?: readonly ChatDelta[];
  readonly fail?: Error;
  /** Wait for this long (on the fake clock) before each event, to model a slow or steady stream. */
  readonly gapMs?: number;
  /** Never produce anything, and ignore the signal. */
  readonly hang?: boolean;
}

export interface ScriptedProvider extends LlmProvider {
  readonly calls: { messages: readonly ChatMessage[]; options: ChatOptions | undefined }[];
  /** How many streams were closed by the consumer or by a failure. */
  readonly closed: () => number;
}

/** Each call to `chat` plays the next attempt (the last repeats). */
export function scriptedProvider(
  attempts: readonly Attempt[],
  sleep?: (ms: number) => Promise<void>,
): ScriptedProvider {
  const calls: ScriptedProvider["calls"] = [];
  let closed = 0;
  return {
    modelId: "fake:model",
    calls,
    closed: () => closed,
    chat(messages, options) {
      calls.push({ messages, options });
      const attempt = attempts[Math.min(calls.length - 1, attempts.length - 1)] ?? {};
      return (async function* (): AsyncGenerator<ChatDelta> {
        try {
          if (attempt.hang === true) {
            await new Promise<never>(() => undefined);
          }
          for (const event of attempt.events ?? []) {
            if (attempt.gapMs !== undefined) await sleep?.(attempt.gapMs);
            options?.signal?.throwIfAborted();
            yield event;
          }
          if (attempt.fail !== undefined) throw attempt.fail;
        } finally {
          closed++;
        }
      })();
    },
  };
}

/** Reads a stream to the end and returns the text events. */
export async function read(stream: AsyncIterable<ChatDelta>): Promise<string[]> {
  const texts: string[] = [];
  for await (const delta of stream) if (delta.kind === "text") texts.push(delta.text);
  return texts;
}

export interface ScriptedEmbedder extends Embedder {
  readonly calls: { texts: readonly string[]; kind: EmbedKind }[];
}

/** Each call plays the next step: a failure, a promise that never settles, or vectors. */
export function scriptedEmbedder(steps: readonly (Error | "hang" | "ok")[]): ScriptedEmbedder {
  const calls: ScriptedEmbedder["calls"] = [];
  return {
    modelId: "fake:embed",
    dimensions: 2,
    calls,
    embed(texts, kind) {
      calls.push({ texts, kind });
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      if (step === "hang") return new Promise<never>(() => undefined);
      if (step instanceof Error) return Promise.reject(step);
      return Promise.resolve(texts.map(() => Float32Array.of(1, 0)));
    },
  };
}

/** Starts something that waits on the fake clock, runs time forward, and returns its outcome. */
export async function settled<T>(
  start: Promise<T>,
  advance: () => Promise<void>,
): Promise<{ value?: T; error?: unknown }> {
  const outcome = start.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  // let what was started run to the point where it waits
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await advance();
  return outcome;
}
