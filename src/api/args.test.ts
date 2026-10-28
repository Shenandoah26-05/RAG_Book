import { describe, expect, it } from "vitest";
import { DEFAULT_HOST, DEFAULT_PORT, parseApiArgs } from "./args.js";

describe("parseApiArgs", () => {
  it("listens on this machine only, on a fixed port, by default", () => {
    expect(parseApiArgs([])).toEqual({ port: DEFAULT_PORT, host: DEFAULT_HOST, origins: [] });
    expect(DEFAULT_HOST).toBe("127.0.0.1");
  });

  it("reads the port and the host, with a space or =", () => {
    expect(parseApiArgs(["--port", "9000", "--host=localhost"])).toMatchObject({
      port: 9000,
      host: "localhost",
    });
  });

  it("allows port 0, which means any free port", () => {
    expect(parseApiArgs(["--port", "0"])).toMatchObject({ port: 0 });
  });

  it.each(["-1", "65536", "80.5", "http", ""])("rejects the port %j", (port) => {
    expect(parseApiArgs(["--port", port])).toHaveProperty("error");
  });

  it("collects origins, and writes each as scheme://host:port with no path", () => {
    expect(
      parseApiArgs(["--origin", "http://localhost:3000/", "--origin=https://reader.example/app"]),
    ).toMatchObject({ origins: ["http://localhost:3000", "https://reader.example"] });
  });

  it.each(["localhost:3000", "ftp://x", "not a url", "*"])("rejects the origin %j", (origin) => {
    expect(parseApiArgs(["--origin", origin])).toMatchObject({
      error: expect.stringContaining("--origin") as string,
    });
  });

  it("reads the variant and the folders", () => {
    expect(
      parseApiArgs([
        "--variant",
        "dense",
        "--processed-dir",
        "p",
        "--raw-dir",
        "r",
        "--index-dir=i",
        "--cache-dir",
        "c",
      ]),
    ).toMatchObject({
      variant: "dense",
      processedDir: "p",
      rawDir: "r",
      indexDir: "i",
      cacheDir: "c",
    });
  });

  it("skips config overrides and --config, with their values", () => {
    expect(
      parseApiArgs(["--retrieval.k", "8", "--rerank.enabled", "--config", "x.json", "--port", "9"]),
    ).toMatchObject({ port: 9 });
    expect(parseApiArgs(["--retrieval.k=8", "--config=x.json"])).toMatchObject({
      port: DEFAULT_PORT,
    });
  });

  it("rejects a flag without a value, an unknown flag and a stray argument", () => {
    expect(parseApiArgs(["--port"])).toEqual({ error: "--port needs a value" });
    expect(parseApiArgs(["--host", "--port", "1"])).toEqual({ error: "--host needs a value" });
    expect(parseApiArgs(["--bogus"])).toEqual({ error: "Unknown option --bogus" });
    expect(parseApiArgs(["serve"])).toEqual({ error: 'Unexpected argument "serve"' });
  });
});
