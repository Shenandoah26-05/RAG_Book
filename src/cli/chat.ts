import { createInterface } from "node:readline";
import { buildChat } from "../composition/index.js";
import type { ChatOutput } from "../composition/index.js";
import { createConsoleLogger } from "../shared/index.js";
import { CHAT_USAGE, parseChatArgs } from "./chat-args.js";

// A thin shell: it connects the terminal to a ChatSession and decides nothing itself. What a line
// means, how an answer is shown and what the commands do all live in composition/chat-session.ts.

const args = parseChatArgs(process.argv.slice(2));

if ("help" in args) {
  console.log(CHAT_USAGE);
} else if ("error" in args) {
  console.error(`${args.error}\n\n${CHAT_USAGE}`);
  process.exitCode = 2;
} else {
  try {
    const session = await buildChat({
      // progress logs would interleave with the answers; only problems are worth a line here
      logger: createConsoleLogger({ level: "warn" }),
      debug: args.debug,
      ...(args.k === undefined ? {} : { k: args.k }),
      ...(args.variant === undefined ? {} : { variant: args.variant }),
      ...(args.indexDir === undefined ? {} : { indexDir: args.indexDir }),
      ...(args.cacheDir === undefined ? {} : { cacheDir: args.cacheDir }),
    });

    // At a terminal there is a prompt and a greeting. With input piped in, each line is a question
    // and standard output holds nothing but the answers.
    const interactive = process.stdin.isTTY;
    const reader = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "> ",
      terminal: interactive,
    });
    const out: ChatOutput = {
      write: (text) => process.stdout.write(text),
      error: (text) => process.stderr.write(text),
    };

    // Ctrl+C stops an answer that is being written; with nothing running it leaves
    reader.on("SIGINT", () => {
      if (!session.interrupt()) reader.close();
    });

    if (interactive) {
      console.log(session.welcome());
      reader.prompt();
    }
    for await (const line of reader) {
      if ((await session.handle(line, out)) === "quit") break;
      if (interactive) reader.prompt();
    }
    reader.close();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
