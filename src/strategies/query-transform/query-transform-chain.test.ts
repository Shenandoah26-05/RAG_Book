import { describe, expect, it } from "vitest";
import type { Query, QueryTransformer } from "../../core/index.js";
import { IdentityQueryTransformer } from "./identity-query-transformer.js";
import { QueryTransformChain } from "./query-transform-chain.js";

const appender = (name: string, calls: string[] = []): QueryTransformer => ({
  name,
  transform: (q: Query) => {
    calls.push(`${name}(${q.text})`);
    return Promise.resolve({ ...q, text: `${q.text}+${name}` });
  },
});

describe("QueryTransformChain", () => {
  it("runs the transformers in order, each on the result of the one before", async () => {
    const calls: string[] = [];
    const chain = new QueryTransformChain([appender("a", calls), appender("b", calls)]);
    expect((await chain.transform({ text: "q" })).text).toBe("q+a+b");
    expect(calls).toEqual(["a(q)", "b(q+a)"]);
  });

  it("is a transformer with a name that shows its parts", () => {
    expect(new QueryTransformChain([appender("rewrite"), appender("hyde")]).name).toBe(
      "chain(rewrite>hyde)",
    );
  });

  it("can hold another chain", async () => {
    const inner = new QueryTransformChain([appender("a"), appender("b")]);
    const outer = new QueryTransformChain([inner, appender("c")]);
    expect((await outer.transform({ text: "q" })).text).toBe("q+a+b+c");
  });

  it("passes the options on and stops once aborted", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const spy: QueryTransformer = {
      name: "spy",
      transform: (q, options) => {
        seen.push(options?.signal);
        return Promise.resolve(q);
      },
    };
    const controller = new AbortController();
    await new QueryTransformChain([spy]).transform({ text: "q" }, { signal: controller.signal });
    expect(seen).toEqual([controller.signal]);

    controller.abort();
    await expect(
      new QueryTransformChain([spy]).transform({ text: "q" }, { signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(seen).toHaveLength(1);
  });

  it("lets a failure through", async () => {
    const chain = new QueryTransformChain([new IdentityQueryTransformer()]);
    await expect(chain.transform({ text: " " })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("rejects an empty chain", () => {
    expect(() => new QueryTransformChain([])).toThrow(/at least one/);
  });
});
