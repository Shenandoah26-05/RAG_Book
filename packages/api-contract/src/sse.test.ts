import { describe, expect, it } from "vitest";
import { ContractError, decodeAskEvent, readAskEvents, SseParser } from "./sse.js";

const CITATION = {
  index: 1,
  chunkId: "a".repeat(64),
  docId: "3f2b8a1e-7c4d-5e9a-b5d6-1a2c3e4f5a6b",
  pageStart: 4,
  pageEnd: 5,
  charStart: 10,
  charEnd: 90,
  quote: "Embeddings map text to vectors.",
};

const frame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe("SseParser", () => {
  it("reads a frame once its blank line has arrived", () => {
    const parser = new SseParser();
    expect(parser.push("event: token\ndata: {}\n")).toEqual([]);
    expect(parser.push("\n")).toEqual([{ event: "token", data: "{}" }]);
  });

  it("reads several frames from one chunk, in order", () => {
    const frames = new SseParser().push("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n");
    expect(frames).toEqual([
      { event: "a", data: "1" },
      { event: "b", data: "2" },
    ]);
  });

  it("copes with a chunk that ends anywhere, even inside a word", () => {
    const text = "event: token\ndata: hello world\n\n";
    for (let cut = 1; cut < text.length; cut++) {
      const parser = new SseParser();
      const frames = [...parser.push(text.slice(0, cut)), ...parser.push(text.slice(cut))];
      expect(frames, `cut at ${cut.toString()}`).toEqual([{ event: "token", data: "hello world" }]);
    }
  });

  it.each([
    ["\n", "LF"],
    ["\r\n", "CRLF"],
    ["\r", "CR"],
  ])("accepts %j (%s) as the end of a line", (eol) => {
    const frames = new SseParser().push(`event: x${eol}data: y${eol}${eol}z`);
    expect(frames).toEqual([{ event: "x", data: "y" }]);
  });

  it("does not lose a frame when CRLF is split between two chunks", () => {
    const parser = new SseParser();
    expect(parser.push("event: x\r\ndata: y\r\n\r")).toEqual([]);
    expect(parser.push("\n")).toEqual([{ event: "x", data: "y" }]);
  });

  it("joins several data lines with a newline", () => {
    expect(new SseParser().push("data: one\ndata: two\n\n")).toEqual([
      { event: "message", data: "one\ntwo" },
    ]);
  });

  it("names a frame without an event 'message'", () => {
    expect(new SseParser().push("data: x\n\n")[0]?.event).toBe("message");
  });

  it("drops one space after the colon, and only one", () => {
    expect(new SseParser().push("data:  two spaces\n\n")[0]?.data).toBe(" two spaces");
    expect(new SseParser().push("data:none\n\n")[0]?.data).toBe("none");
  });

  it("ignores comments, id and retry, and unknown fields", () => {
    const frames = new SseParser().push(
      ": keep-alive\nid: 7\nretry: 100\nfoo: bar\nevent: a\ndata: 1\n\n",
    );
    expect(frames).toEqual([{ event: "a", data: "1" }]);
  });

  it("gives nothing for a blank line with no data, and the next frame does not inherit its event", () => {
    const frames = new SseParser().push("event: lonely\n\ndata: x\n\n");
    expect(frames).toEqual([{ event: "message", data: "x" }]);
  });

  it("keeps an empty data line as an empty string", () => {
    expect(new SseParser().push("event: e\ndata\n\n")).toEqual([{ event: "e", data: "" }]);
  });

  it("flush gives no half-finished frame", () => {
    const parser = new SseParser();
    parser.push("event: a\ndata: partial");
    expect(parser.flush()).toEqual([]);
  });
});

describe("decodeAskEvent", () => {
  it("reads each event of the contract", () => {
    const events = [
      { event: "token", data: { text: "Hi" } },
      { event: "citations", data: { citations: [CITATION] } },
      { event: "trace", data: { trace: { totalMs: 5, stages: [] } } },
      {
        event: "done",
        data: { answered: true, cited: [1], unknownCitations: [], complete: true },
      },
      { event: "error", data: { code: "INTERNAL", message: "boom" } },
    ] as const;
    for (const { event, data } of events) {
      expect(decodeAskEvent({ event, data: JSON.stringify(data) })).toEqual({ event, data });
    }
  });

  it("rejects an event the contract does not have", () => {
    expect(() => decodeAskEvent({ event: "surprise", data: "{}" })).toThrow(ContractError);
  });

  it("rejects data that is not JSON", () => {
    expect(() => decodeAskEvent({ event: "token", data: "{nope" })).toThrow(/does not carry JSON/);
  });

  it("rejects data of the wrong shape, and says where", () => {
    expect(() => decodeAskEvent({ event: "token", data: JSON.stringify({ text: 5 }) })).toThrow(
      /not what the contract says.*text/,
    );
    expect(() =>
      decodeAskEvent({ event: "token", data: JSON.stringify({ text: "x", extra: 1 }) }),
    ).toThrow(ContractError);
    expect(() => decodeAskEvent({ event: "token", data: JSON.stringify({ text: "" }) })).toThrow(
      ContractError,
    );
  });
});

/** A response body that arrives in the given pieces. */
function bodyOf(pieces: readonly (string | Uint8Array)[]): {
  body: ReadableStream<Uint8Array>;
  cancelled: () => boolean;
} {
  const encoder = new TextEncoder();
  let next = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const piece = pieces[next++];
      if (piece === undefined) controller.close();
      else controller.enqueue(typeof piece === "string" ? encoder.encode(piece) : piece);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, cancelled: () => cancelled };
}

const collect = async <T>(stream: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const item of stream) out.push(item);
  return out;
};

describe("readAskEvents", () => {
  it("yields the events of an answer as they arrive", async () => {
    const { body } = bodyOf([
      frame("token", { text: "Hel" }),
      frame("token", { text: "lo" }),
      frame("citations", { citations: [] }),
      frame("done", { answered: true, cited: [], unknownCitations: [], complete: true }),
    ]);
    const events = await collect(readAskEvents(body));
    expect(events.map((e) => e.event)).toEqual(["token", "token", "citations", "done"]);
  });

  it("puts a frame back together that was cut into network packets", async () => {
    const all = frame("token", { text: "split me" });
    const { body } = bodyOf([all.slice(0, 7), all.slice(7, 20), all.slice(20)]);
    expect(await collect(readAskEvents(body))).toEqual([
      { event: "token", data: { text: "split me" } },
    ]);
  });

  it("does not break a character that is cut between two packets", async () => {
    const bytes = new TextEncoder().encode(frame("token", { text: "café ☕" }));
    // cut inside the two-byte 'é'
    const cut = bytes.indexOf(0xc3) + 1;
    const { body } = bodyOf([bytes.slice(0, cut), bytes.slice(cut)]);
    expect(await collect(readAskEvents(body))).toEqual([
      { event: "token", data: { text: "café ☕" } },
    ]);
  });

  it("ends quietly when the stream ends, whether or not it finished with done", async () => {
    const { body } = bodyOf([frame("token", { text: "x" })]);
    expect(await collect(readAskEvents(body))).toHaveLength(1);
  });

  it("closes the stream when the reader stops early", async () => {
    const { body, cancelled } = bodyOf([
      frame("token", { text: "a" }),
      frame("token", { text: "b" }),
      frame("token", { text: "c" }),
    ]);
    const events = readAskEvents(body);
    await events.next();
    await events.return(undefined);
    expect(cancelled()).toBe(true);
  });

  it("fails with a ContractError on a frame that is not an event", async () => {
    const { body } = bodyOf(["event: nonsense\ndata: {}\n\n"]);
    await expect(collect(readAskEvents(body))).rejects.toBeInstanceOf(ContractError);
  });
});
