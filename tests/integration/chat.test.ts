import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFixtureIndex } from "../../src/composition/search-fixture.testing.js";

const ROOT = path.resolve(import.meta.dirname, "../..");

interface ChatRequest {
  readonly model: string;
  readonly stream: boolean;
  readonly messages: { readonly role: string; readonly content: string }[];
}

/**
 * Stands in for Ollama's `/api/chat`: answers with the given pieces as a stream of JSON lines. With
 * `gate`, the pieces after the first are held back until it resolves, so a test can tell whether
 * the first piece reached the reader before the answer was finished.
 */
function fakeOllama(options: { pieces: string[]; gate?: Promise<void> }): {
  start(): Promise<string>;
  stop(): Promise<void>;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  let server: Server | undefined;
  const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    requests.push(JSON.parse(body) as ChatRequest);
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    const [first = "", ...rest] = options.pieces;
    res.write(line({ message: { role: "assistant", content: first } }));
    if (options.gate !== undefined) await options.gate;
    for (const piece of rest) res.write(line({ message: { role: "assistant", content: piece } }));
    res.end(line({ done: true, done_reason: "stop", prompt_eval_count: 50, eval_count: 9 }));
  }

  return {
    requests,
    async start() {
      server = createServer((req, res) => {
        void handle(req, res);
      });
      await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
      return `127.0.0.1:${(server.address() as AddressInfo).port.toString()}`;
    },
    async stop() {
      server?.closeAllConnections();
      await new Promise<void>((resolve) => {
        server?.close(() => {
          resolve();
        });
      });
    },
  };
}

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Starts `pnpm chat` (the same file), feeds it lines and collects what it prints. */
function startChat(args: string[], env: Record<string, string>) {
  const child = spawn(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "src/cli/chat.ts", ...args],
    { cwd: ROOT, env: { ...process.env, ...env } },
  );
  let stdout = "";
  let stderr = "";
  const watchers: (() => void)[] = [];
  child.stdout.on("data", (data: Buffer) => {
    stdout += data.toString();
    watchers.forEach((check) => {
      check();
    });
  });
  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  const done = new Promise<Run>((resolve) => {
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
  return {
    send: (text: string) => child.stdin.write(text),
    end: () => child.stdin.end(),
    /** Resolves as soon as what the command has printed so far contains `text`. */
    printed: (text: string) =>
      new Promise<void>((resolve) => {
        const check = (): void => {
          if (stdout.includes(text)) resolve();
        };
        watchers.push(check);
        check();
      }),
    done,
  };
}

describe("pnpm chat, as a command", () => {
  let dir: string;
  let indexDir: string;
  let ollama: ReturnType<typeof fakeOllama> | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rag-chat-e2e-"));
    indexDir = path.join(dir, "index");
    await writeFixtureIndex(indexDir);
  });
  afterEach(async () => {
    await ollama?.stop();
    ollama = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  const common = (): string[] => [
    "--variant",
    "bm25",
    "--index-dir",
    indexDir,
    "--cache-dir",
    path.join(dir, "cache"),
  ];

  it("streams the answer as it is written, then prints the sources with page numbers", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    ollama = fakeOllama({ pieces: ["Cats purr ", "when they are content [1]."], gate });
    const host = await ollama.start();

    const chat = startChat(common(), { OLLAMA_HOST: host });
    chat.send("cats\n");
    // The model has sent only the first piece and is holding the rest until we release it. If the
    // command waited for the whole answer, this would never resolve and the test would time out.
    await chat.printed("Cats purr ");
    release();
    chat.send("/quit\n");
    const { code, stdout, stderr } = await chat.done;

    expect(code).toBe(0);
    expect(stdout).toContain("Cats purr when they are content [1].");
    expect(stdout).toContain("Sources:");
    expect(stdout).toContain("● [1] p.1");
    expect(stdout).toContain('"cats purr"');
    expect(stdout.indexOf("content [1].")).toBeLessThan(stdout.indexOf("Sources:"));
    expect(stderr).toBe("");

    // what the model was asked: the retrieved text in the system message, the question as typed
    expect(ollama.requests).toHaveLength(1);
    const asked = ollama.requests[0];
    expect(asked?.stream).toBe(true);
    expect(asked?.model).toBe("llama3.2");
    expect(asked?.messages[0]).toMatchObject({ role: "system" });
    expect(asked?.messages[0]?.content).toContain("cats purr");
    expect(asked?.messages[1]).toEqual({ role: "user", content: "cats" });
  }, 60_000);

  it("prints only answers when the input is piped, and ends when the input does", async () => {
    ollama = fakeOllama({ pieces: ["Kittens are young cats [2]."] });
    const host = await ollama.start();
    const chat = startChat(common(), { OLLAMA_HOST: host });
    chat.send("cats\n");
    chat.end();
    const { code, stdout } = await chat.done;

    expect(code).toBe(0);
    // no greeting and no prompt: standard output holds the answer and its sources
    expect(stdout.startsWith("Kittens are young cats [2].")).toBe(true);
    expect(stdout).not.toContain("Ask the book");
    expect(stdout).not.toContain("> ");
    expect(stdout).toMatch(/○ \[1\] p\.1/);
    // default ordering is "sandwich": the best source first, the second best last, so [2] is the
    // third-ranked "furry animals" chunk on page 2, and it is the one the model cited
    expect(stdout).toMatch(/● \[2\] p\.2/);
    expect(stdout).toMatch(/○ \[3\] p\.1/);
  }, 60_000);

  it("/config shows the variant and /debug shows the trace after the next answer", async () => {
    ollama = fakeOllama({ pieces: ["Yes [1]."] });
    const host = await ollama.start();
    const chat = startChat(common(), { OLLAMA_HOST: host });
    chat.send("/config\n/debug\ncats\n/debug\n/help\n/quit\n");
    const { code, stdout } = await chat.done;

    expect(code).toBe(0);
    expect(stdout).toMatch(/Variant: {4}bm25/);
    expect(stdout).toContain("retriever bm25");
    expect(stdout).toContain("Debug on");
    expect(stdout).toMatch(/Trace \(\d+ ms in total\):/);
    for (const stage of ["transform", "retrieve", "rerank", "assemble", "generate"]) {
      expect(stdout).toMatch(new RegExp(`${stage}\\s+\\d+ ms`));
    }
    expect(stdout).toContain("Debug off");
    expect(stdout).toContain("/quit");
  }, 60_000);

  it("prints a failed question to standard error and keeps the session going", async () => {
    // nothing listens on this port
    const chat = startChat(common(), { OLLAMA_HOST: "127.0.0.1:9" });
    chat.send("cats\n/config\n/quit\n");
    const { code, stdout, stderr } = await chat.done;

    expect(code).toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
    expect(stderr).not.toContain("at async"); // a message, not a stack trace
    expect(stdout).not.toContain("Sources:");
    // the session was still alive for the next line
    expect(stdout).toMatch(/Variant: {4}bm25/);
  }, 60_000);

  it("exits with 1 and says to run pnpm index when there is no index", async () => {
    const chat = startChat(
      ["--variant", "bm25", "--index-dir", path.join(dir, "empty"), "--cache-dir", dir],
      {},
    );
    chat.end();
    const { code, stdout, stderr } = await chat.done;
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("pnpm index");
  }, 60_000);

  it("exits with 2 and shows the usage for a bad option, and 0 for --help", async () => {
    const bad = startChat(["--k", "0"], {});
    bad.end();
    const badRun = await bad.done;
    expect(badRun.code).toBe(2);
    expect(badRun.stderr).toContain("--k needs a whole number of 1 or more");
    expect(badRun.stderr).toContain("Usage: pnpm chat");

    const help = startChat(["--help"], {});
    help.end();
    const helpRun = await help.done;
    expect(helpRun.code).toBe(0);
    expect(helpRun.stdout).toContain("Usage: pnpm chat");
  }, 60_000);
});
