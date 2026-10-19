import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config/index.js";
import { RagError } from "../shared/index.js";
import type { AskOptions, RagAnswer } from "../pipeline/index.js";
import { ChatSession } from "./chat-session.js";
import { fakeAnswer, recordingOutput } from "./chat-session.testing.js";
import type { AnswerSpec } from "./chat-session.testing.js";

const PARTS = {
  transformer: "identity",
  retriever: "hybrid",
  reranker: "noop",
  llm: "ollama:llama3.2",
} as const;

interface Ask {
  readonly question: string;
  readonly options: AskOptions;
}

/** A pipeline that answers from a script, one entry per question, and records what it was asked. */
function scripted(...answers: (AnswerSpec | Error | ((options: AskOptions) => AnswerSpec))[]): {
  pipeline: ConstructorParameters<typeof ChatSession>[0]["pipeline"];
  asked: Ask[];
} {
  const asked: Ask[] = [];
  let next = 0;
  return {
    asked,
    pipeline: {
      describe: () => PARTS,
      ask: (question: string, given?: AskOptions): Promise<RagAnswer> => {
        const options = given ?? {};
        asked.push({ question, options });
        const step = answers[next++] ?? { pieces: ["(no more answers)"] };
        if (step instanceof Error) return Promise.reject(step);
        const spec = typeof step === "function" ? step(options) : step;
        return Promise.resolve(fakeAnswer({ ...spec, signal: options.signal }));
      },
    },
  };
}

const session = (
  pipeline: ConstructorParameters<typeof ChatSession>[0]["pipeline"],
  extra: Partial<ConstructorParameters<typeof ChatSession>[0]> = {},
): ChatSession =>
  new ChatSession({ pipeline, config: DEFAULT_CONFIG, namespace: "recursive__m", ...extra });

describe("ChatSession: questions", () => {
  it("writes the answer piece by piece as it arrives, then the sources", async () => {
    const { pipeline } = scripted({ pieces: ["Embeddings ", "are ", "numbers [1]."] });
    const out = recordingOutput();
    const result = await session(pipeline).handle("What are embeddings?", out);

    expect(result).toBe("continue");
    // each piece is its own write, in order, before anything else
    expect(out.chunks.slice(0, 3)).toEqual(["Embeddings ", "are ", "numbers [1]."]);
    const text = out.text();
    expect(text.indexOf("numbers [1].")).toBeLessThan(text.indexOf("Sources:"));
    expect(text).toContain("● [1] p.12-13  Chapter 3 > 3.2 Embeddings");
    expect(text).toContain("○ [2] p.40");
    expect(out.errors).toEqual([]);
  });

  it("passes the question as typed, trimmed, and k and a signal", async () => {
    const { pipeline, asked } = scripted({ pieces: ["ok"] });
    await session(pipeline, { k: 3 }).handle("  What is a vector?  ", recordingOutput());
    expect(asked).toHaveLength(1);
    expect(asked[0]?.question).toBe("What is a vector?");
    expect(asked[0]?.options.k).toBe(3);
    expect(asked[0]?.options.signal).toBeInstanceOf(AbortSignal);
  });

  it("leaves k to the pipeline when none is given", async () => {
    const { pipeline, asked } = scripted({ pieces: ["ok"] });
    await session(pipeline).handle("q", recordingOutput());
    expect(asked[0]?.options).not.toHaveProperty("k");
  });

  it("ignores blank lines without asking anything", async () => {
    const { pipeline, asked } = scripted({ pieces: ["x"] });
    const out = recordingOutput();
    for (const line of ["", "   ", "\t"]) {
      expect(await session(pipeline).handle(line, out)).toBe("continue");
    }
    expect(asked).toEqual([]);
    expect(out.chunks).toEqual([]);
  });

  it("answers several questions in turn, each on its own", async () => {
    const { pipeline, asked } = scripted({ pieces: ["first [1]"] }, { pieces: ["second [2]"] });
    const chat = session(pipeline);
    const out = recordingOutput();
    await chat.handle("one", out);
    await chat.handle("two", out);
    expect(asked.map((a) => a.question)).toEqual(["one", "two"]);
    expect(out.text()).toContain("first [1]");
    expect(out.text()).toContain("second [2]");
  });

  it("says when no sources were found", async () => {
    const { pipeline } = scripted({ pieces: ["I could not find that in the book."], sources: [] });
    const out = recordingOutput();
    await session(pipeline).handle("Who won the 1998 World Cup?", out);
    expect(out.text()).toContain("I could not find that in the book.");
    expect(out.text()).toContain("No sources were found for this question.");
    expect(out.text()).not.toContain("Sources:");
  });
});

describe("ChatSession: failures", () => {
  it("prints a question that fails to the error output and carries on", async () => {
    const { pipeline } = scripted(new RagError("PROVIDER_UNAVAILABLE", "Ollama is not running"), {
      pieces: ["Back again [1]."],
    });
    const chat = session(pipeline);
    const first = recordingOutput();
    expect(await chat.handle("q1", first)).toBe("continue");
    expect(first.errors.join("")).toContain("Ollama is not running");
    expect(first.chunks).toEqual([]);

    const second = recordingOutput();
    await chat.handle("q2", second);
    expect(second.text()).toContain("Back again [1].");
    expect(second.errors).toEqual([]);
  });

  it("keeps the part of the answer already written when the model fails half way", async () => {
    const { pipeline } = scripted({
      pieces: ["Embeddings are "],
      failWith: new RagError("PROVIDER_UNAVAILABLE", "connection lost"),
    });
    const out = recordingOutput();
    expect(await session(pipeline).handle("q", out)).toBe("continue");
    expect(out.text()).toContain("Embeddings are ");
    expect(out.text()).not.toContain("Sources:");
    expect(out.errors.join("")).toContain("connection lost");
  });

  it("reports an error that is not an Error", async () => {
    const chat = session({
      describe: () => PARTS,
      ask: () => Promise.reject(new Error("plain failure")),
    });
    const out = recordingOutput();
    await chat.handle("q", out);
    expect(out.errors.join("")).toContain("plain failure");
  });
});

describe("ChatSession: stopping an answer", () => {
  it("interrupt stops the answer being written, says so, and the session goes on", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { pipeline } = scripted(
      (options) => ({ pieces: ["never shown"], waitFor: held, signal: options.signal }),
      { pieces: ["Next answer [1]."] },
    );
    const chat = session(pipeline);
    const out = recordingOutput();

    const running = chat.handle("a slow question", out);
    // let the question reach the point of waiting
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(chat.interrupt()).toBe(true);
    expect(await running).toBe("continue");
    release();

    expect(out.text()).toContain("[stopped]");
    expect(out.text()).not.toContain("never shown");
    expect(out.errors).toEqual([]);

    expect(chat.interrupt()).toBe(false);
    const next = recordingOutput();
    await chat.handle("another", next);
    expect(next.text()).toContain("Next answer [1].");
  });

  it("interrupt does nothing when no answer is being written", () => {
    expect(session(scripted().pipeline).interrupt()).toBe(false);
  });
});

describe("ChatSession: commands", () => {
  it("/quit and /exit end the session, in any case", async () => {
    const chat = session(scripted().pipeline);
    for (const line of ["/quit", "/exit", "/QUIT", "  /Exit  "]) {
      expect(await chat.handle(line, recordingOutput())).toBe("quit");
    }
  });

  it("/help lists the commands", async () => {
    const out = recordingOutput();
    expect(await session(scripted().pipeline).handle("/help", out)).toBe("continue");
    for (const command of ["/debug", "/config", "/help", "/quit"]) {
      expect(out.text()).toContain(command);
    }
  });

  it("/config shows the active variant and the settings", async () => {
    const out = recordingOutput();
    await session(scripted().pipeline, { variant: "hybrid-weighted" }).handle("/config", out);
    expect(out.text()).toMatch(/^Variant: {4}hybrid-weighted$/m);
    expect(out.text()).toContain("recursive__m");
    expect(out.text()).toContain("retriever hybrid, reranker noop, model ollama:llama3.2");
    expect(out.text()).toContain("k = 5");
  });

  it("/config says default when no variant is used", async () => {
    const out = recordingOutput();
    await session(scripted().pipeline).handle("/config", out);
    expect(out.text()).toMatch(/^Variant: {4}default$/m);
  });

  it("/debug toggles the trace", async () => {
    const { pipeline } = scripted(
      { pieces: ["a [1]"] },
      { pieces: ["b [1]"] },
      { pieces: ["c [1]"] },
    );
    const chat = session(pipeline);
    expect(chat.debug).toBe(false);

    const off = recordingOutput();
    await chat.handle("q", off);
    expect(off.text()).not.toContain("Trace (");

    const on = recordingOutput();
    await chat.handle("/debug", on);
    expect(chat.debug).toBe(true);
    expect(on.text()).toContain("Debug on");
    await chat.handle("q", on);
    expect(on.text()).toMatch(/Trace \(\d+ ms in total\):/);
    expect(on.text()).toMatch(/retrieve\s+\d+ ms {2}retriever=hybrid, found=3/);
    expect(on.text()).toContain("Prompt: rag-system@v1, 3 sources");

    const again = recordingOutput();
    await chat.handle("/debug", again);
    expect(chat.debug).toBe(false);
    expect(again.text()).toContain("Debug off");
    await chat.handle("q", again);
    expect(again.text()).not.toContain("Trace (");
  });

  it("can start with the trace on", async () => {
    const { pipeline } = scripted({ pieces: ["a [1]"] });
    const out = recordingOutput();
    await session(pipeline, { debug: true }).handle("q", out);
    expect(out.text()).toContain("Trace (");
  });

  it("shows the trace after a failed answer too, with the stage that failed", async () => {
    const { pipeline } = scripted({
      pieces: ["partial "],
      failWith: new RagError("PROVIDER_UNAVAILABLE", "model not found"),
    });
    const out = recordingOutput();
    await session(pipeline, { debug: true }).handle("q", out);
    expect(out.errors.join("")).toContain("model not found");
    expect(out.text()).toMatch(/generate.*FAILED: model not found/);
  });

  it("answers an unknown command on the error output, without asking the pipeline", async () => {
    const { pipeline, asked } = scripted({ pieces: ["x"] });
    const out = recordingOutput();
    expect(await session(pipeline).handle("/frobnicate now", out)).toBe("continue");
    expect(out.errors.join("")).toContain("Unknown command /frobnicate");
    expect(out.errors.join("")).toContain("/help");
    expect(asked).toEqual([]);
  });
});

describe("ChatSession: welcome", () => {
  it("greets with the index and the model, and the variant when there is one", () => {
    const { pipeline } = scripted();
    expect(session(pipeline).welcome()).toContain("Type /help");
    expect(session(pipeline).welcome()).toContain("Index recursive__m, model ollama:llama3.2");
    expect(session(pipeline).welcome()).not.toContain("variant");
    expect(session(pipeline, { variant: "bm25" }).welcome()).toContain("variant bm25");
  });
});
