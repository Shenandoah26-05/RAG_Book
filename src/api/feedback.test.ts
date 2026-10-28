import { errorResponseSchema, feedbackResponseSchema } from "@rag-book/api-contract";
import { describe, expect, it } from "vitest";
import { createApp, MAX_BODY_BYTES } from "./app.js";
import { DOC, fakeServices } from "./api.testing.js";
import type { FakeServicesOptions } from "./api.testing.js";

const ANSWER = "3f2b8a1e-7c4d-4e9a-b5d6-1a2c3e4f5a6b";
const CHUNK = "c".repeat(64);
const NOW = new Date("2026-10-28T12:30:00.000Z");

const valid = {
  answerId: ANSWER,
  rating: "up",
  question: "What is an embedding?",
  answer: "A vector [1].",
  docId: DOC,
  citations: [
    {
      index: 1,
      chunkId: CHUNK,
      docId: DOC,
      pageStart: 1,
      pageEnd: 1,
      charStart: 0,
      charEnd: 31,
      quote: "Embeddings map text to vectors.",
    },
  ],
};

const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

function setup(options: FakeServicesOptions = {}) {
  const services = fakeServices(options);
  return { services, app: createApp(services, { now: () => NOW }) };
}

describe("POST /feedback", () => {
  it("records the rating with the answer, when it arrived and which system wrote it", async () => {
    const { app, services } = setup();
    const response = await app.request("/feedback", post({ ...valid, note: "  spot on  " }));

    expect(response.status).toBe(200);
    expect(feedbackResponseSchema.parse(await response.json())).toEqual({
      answerId: ANSWER,
      saved: true,
    });
    expect(services.recorded).toEqual([
      {
        answerId: ANSWER,
        savedAt: "2026-10-28T12:30:00.000Z",
        rating: "up",
        note: "spot on",
        question: "What is an embedding?",
        answer: "A vector [1].",
        docId: DOC,
        citations: valid.citations,
        system: { index: "recursive__ollama-all-minilm", model: "fake:model" },
      },
    ]);
  });

  it("leaves out a blank note, and keeps the trace and the refusal when sent", async () => {
    const { app, services } = setup();
    const trace = { totalMs: 12, stages: [] };
    await app.request(
      "/feedback",
      post({
        ...valid,
        rating: "down",
        note: "   ",
        answer: "",
        refusal: "nothing good enough",
        citations: [],
        trace,
      }),
    );
    const [entry] = services.recorded;
    expect(entry).not.toHaveProperty("note");
    expect(entry).toMatchObject({ rating: "down", refusal: "nothing good enough", trace });
  });

  it("records a changed mind as another entry for the same answer, in order", async () => {
    const { app, services } = setup();
    await app.request("/feedback", post(valid));
    await app.request("/feedback", post({ ...valid, rating: "down", note: "wrong page" }));
    expect(services.recorded.map((e) => [e.answerId, e.rating])).toEqual([
      [ANSWER, "up"],
      [ANSWER, "down"],
    ]);
  });

  it.each([
    ["no rating", { ...valid, rating: undefined }],
    ["a rating that is not up or down", { ...valid, rating: "meh" }],
    ["an answer id that is not a version 4 UUID", { ...valid, answerId: "42" }],
    ["a blank question", { ...valid, question: "   " }],
    ["a note over the limit", { ...valid, note: "x".repeat(1001) }],
    ["a citation that is not in the contract's shape", { ...valid, citations: [{ index: 1 }] }],
    ["a field the contract does not have", { ...valid, userEmail: "a@b.c" }],
  ])("refuses %s, and records nothing", async (_name, body) => {
    const { app, services } = setup();
    const response = await app.request("/feedback", post(body));
    expect(response.status).toBe(400);
    expect(errorResponseSchema.parse(await response.json()).error.code).toBe("INVALID_REQUEST");
    expect(services.recorded).toEqual([]);
  });

  it("refuses a body that is not JSON, or is not sent as JSON", async () => {
    const { app, services } = setup();
    expect((await app.request("/feedback", post("{nope"))).status).toBe(400);
    const plain = await app.request("/feedback", post(valid, { "Content-Type": "text/plain" }));
    expect(plain.status).toBe(415);
    expect(services.recorded).toEqual([]);
  });

  it("refuses a body over the limit", async () => {
    const { app, services } = setup();
    const response = await app.request(
      "/feedback",
      post(JSON.stringify({ ...valid, note: "x".repeat(MAX_BODY_BYTES) })),
    );
    expect(response.status).toBe(413);
    expect(services.recorded).toEqual([]);
  });

  it("says so, with a server error, when the rating could not be saved", async () => {
    const { app } = setup({ feedbackFailure: new Error("disk full") });
    const response = await app.request("/feedback", post(valid));
    expect(response.status).toBe(500);
    // the reader is told it failed, not why the disk is full
    expect(JSON.stringify(await response.json())).not.toContain("disk full");
  });

  it("answers a browser's preflight for it from the web app, and from nowhere else", async () => {
    const { app } = setup();
    const ask = (origin: string) =>
      app.request("/feedback", {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      });
    expect((await ask("http://localhost:5173")).headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );
    expect((await ask("https://evil.example")).headers.get("access-control-allow-origin")).toBe(
      null,
    );
  });
});
