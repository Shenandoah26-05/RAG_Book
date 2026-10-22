import { describe, expect, it } from "vitest";
import { CHAT_USAGE, parseChatArgs } from "./chat-args.js";

describe("parseChatArgs", () => {
  it("accepts no arguments", () => {
    expect(parseChatArgs([])).toEqual({ debug: false });
  });

  it("reads every option, with a space or an equals sign", () => {
    expect(
      parseChatArgs([
        "--k",
        "3",
        "--debug",
        "--variant=bm25",
        "--index-dir",
        "idx",
        "--cache-dir=cache",
      ]),
    ).toEqual({ k: 3, debug: true, variant: "bm25", indexDir: "idx", cacheDir: "cache" });
  });

  it("skips config overrides, with their values, for the config loader", () => {
    expect(
      parseChatArgs([
        "--retrieval.strategy",
        "bm25",
        "--rerank.enabled",
        "--chunking.max-tokens=300",
      ]),
    ).toEqual({ debug: false });
    expect(parseChatArgs(["--config", "my.json", "--k", "2"])).toEqual({ debug: false, k: 2 });
  });

  it("asks for help", () => {
    expect(parseChatArgs(["--help"])).toEqual({ help: true });
    expect(parseChatArgs(["-h"])).toEqual({ help: true });
    expect(CHAT_USAGE).toContain("pnpm chat");
  });

  it("rejects an option that needs a value and has none", () => {
    for (const flag of ["--k", "--variant", "--index-dir", "--cache-dir"]) {
      expect(parseChatArgs([flag])).toEqual({ error: `${flag} needs a value` });
      expect(parseChatArgs([`${flag}=`])).toEqual({ error: `${flag} needs a value` });
    }
    // the next word is another option, not a value
    expect(parseChatArgs(["--k", "--debug"])).toEqual({ error: "--k needs a value" });
  });

  it("rejects a k that is not a whole number of 1 or more", () => {
    const expected = { error: "--k needs a whole number of 1 or more" };
    for (const k of ["0", "-1", "1.5", "three", "2x"]) {
      expect(parseChatArgs([`--k=${k}`])).toEqual(expected);
    }
    expect(parseChatArgs(["--k", "0"])).toEqual(expected);
  });

  it("rejects an unknown option", () => {
    expect(parseChatArgs(["--verbose"])).toEqual({ error: "Unknown option --verbose" });
  });

  it("rejects a question on the command line, pointing at the prompt", () => {
    const result = parseChatArgs(["What is a vector?"]);
    expect("error" in result ? result.error : "").toBe(
      'Unexpected argument "What is a vector?": type your questions at the prompt',
    );
  });

  it("rejects --variant together with --config", () => {
    expect(parseChatArgs(["--variant", "bm25", "--config", "x.json"])).toEqual({
      error: "Use --variant or --config, not both",
    });
  });
});
