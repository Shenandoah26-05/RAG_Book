// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectionEvent } from "./inspector/fixtures.js";
import {
  citation,
  citationsEvent,
  doneEvent,
  fakes,
  installDomStubs,
  mount,
  token,
} from "./test-support.js";
import type { Fakes } from "./test-support.js";

beforeEach(installDomStubs);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const box = (): HTMLTextAreaElement => screen.getByLabelText("Your question");
const toggle = (): HTMLInputElement => screen.getByRole("checkbox", { name: /Inspect/ });

async function open(f: Fakes = fakes()): Promise<Fakes> {
  mount(f);
  await screen.findByRole("textbox", { name: "Your question" });
  return f;
}

async function ask(f: Fakes, question: string): Promise<void> {
  const asked = f.channels.length + 1;
  fireEvent.change(box(), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
  await waitFor(() => {
    expect(f.channels).toHaveLength(asked);
  });
}

/** Asks a question and answers it, with an inspection if `withInspection`. */
async function answered(f: Fakes, withInspection: boolean): Promise<void> {
  await ask(f, "What is an embedding?");
  const stream = f.channels.at(-1);
  act(() => {
    stream?.push(token("Vectors [1]."));
    stream?.push(citationsEvent(citation(1)));
    stream?.push({
      event: "trace",
      data: {
        trace: {
          totalMs: 1234,
          stages: [
            {
              stage: "rerank",
              startMs: 0,
              durationMs: 42,
              status: "ok",
              summary: { reranker: "llm", kept: 2, reordered: true },
            },
          ],
          usage: { calls: 1, promptTokens: 900, outputTokens: 60, embeddedTokens: 0, modelMs: 800 },
        },
      },
    });
    if (withInspection) stream?.push(inspectionEvent());
    stream?.push(doneEvent({ cited: [1] }));
    stream?.close();
  });
  await screen.findByRole("button", { name: /^Source 1/ });
}

describe("the Inspect toggle", () => {
  it("is off at first, and a question is then asked without inspect", async () => {
    const f = await open();
    expect(toggle().checked).toBe(false);
    await ask(f, "Why?");
    expect(f.requests[0]).not.toHaveProperty("inspect");
  });

  it("makes the questions asked after it ask for an inspection", async () => {
    const f = await open();
    fireEvent.click(toggle());
    expect(toggle().checked).toBe(true);
    await ask(f, "Why?");
    expect(f.requests[0]?.inspect).toBe(true);
  });

  it("stops asking for one when switched off again", async () => {
    const f = await open();
    fireEvent.click(toggle());
    await ask(f, "One?");
    act(() => {
      f.channels[0]?.push(doneEvent());
      f.channels[0]?.close();
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Ask" })).toBeTruthy();
    });
    fireEvent.click(toggle());
    await ask(f, "Two?");
    expect(f.requests[0]?.inspect).toBe(true);
    expect(f.requests[1]).not.toHaveProperty("inspect");
  });
});

describe("the inspector panel", () => {
  it("is not there when the answer came without an inspection", async () => {
    const f = await open();
    await answered(f, false);
    expect(screen.queryByText("Inspect this answer")).toBeNull();
  });

  it("is there, closed, when the answer came with one", async () => {
    const f = await open();
    fireEvent.click(toggle());
    await answered(f, true);
    const summary = screen.getByText("Inspect this answer");
    expect(summary.closest("details")?.open).toBe(false);
  });

  it("lists the chunks retrieval found with their rank, score, pages and snippet", async () => {
    const f = await open();
    await answered(f, true);
    const chunks = within(screen.getByLabelText("Retrieved chunks"));
    expect(chunks.getByText(/4 found, 2 used/)).toBeTruthy();
    expect(chunks.getByText("Embeddings map text to vectors.")).toBeTruthy();
    expect(chunks.getByText("0.033")).toBeTruthy();
    expect(chunks.getByText("pp. 1–2")).toBeTruthy();
    // three of the four chunks are under this section; the other has no section line at all
    expect(chunks.getAllByText("Embeddings › Similarity")).toHaveLength(3);
  });

  it("says which retriever found each chunk, with the rank it gave", async () => {
    const f = await open();
    await answered(f, true);
    const chunks = within(screen.getByLabelText("Retrieved chunks"));
    expect(chunks.getByText("bm25 #1")).toBeTruthy();
    expect(chunks.getByText("dense #2")).toBeTruthy();
    expect(chunks.getByText("dense #1")).toBeTruthy();
    // a chunk no retriever reported falls back to the name of the retriever that handed it on
    expect(chunks.getAllByText("hybrid").length).toBeGreaterThan(0);
  });

  it("shows what the reranker did to each chunk", async () => {
    const f = await open();
    await answered(f, true);
    const chunks = within(screen.getByLabelText("Retrieved chunks"));
    expect(chunks.getByText("Moved up from place 2 to 1")).toBeTruthy();
    expect(chunks.getByText("Moved down from place 1 to 2")).toBeTruthy();
    expect(chunks.getByText("Kept at place 3")).toBeTruthy();
    expect(chunks.getByText("Dropped by the reranker")).toBeTruthy();
  });

  it("says what became of each chunk, and why one was left out", async () => {
    const f = await open();
    await answered(f, true);
    const chunks = within(screen.getByLabelText("Retrieved chunks"));
    expect(chunks.getByText(/In the prompt as \[1\]/)).toBeTruthy();
    expect(chunks.getByText(/In the prompt as \[2\]/)).toBeTruthy();
    expect(chunks.getByText(/Left out: over the token budget/)).toBeTruthy();
    expect(chunks.getByText(/Not used: cut by the reranker/)).toBeTruthy();
    expect(chunks.getByText(/reranked score 7\.00/)).toBeTruthy();
  });

  it("shows the prompt, its token count against the budget, and its parts", async () => {
    const f = await open();
    await answered(f, true);
    const prompt = within(screen.getByLabelText("Prompt"));
    expect(prompt.getByText(/Sources: 80 of 100 tokens/)).toBeTruthy();
    const meter = prompt.getByRole("meter");
    expect(meter.getAttribute("value")).toBe("0.8");
    expect(prompt.getByText("You answer from the sources. [1] ...")).toBeTruthy();
    expect(prompt.getByText("What is an embedding?")).toBeTruthy();
    expect(prompt.getByText(/rag-system@v2/)).toBeTruthy();
    expect(prompt.queryByText(/was not called/)).toBeNull();
  });

  it("says the model was not called when the book refused to answer", async () => {
    const f = await open();
    await ask(f, "Unanswerable?");
    act(() => {
      f.channels[0]?.push(
        inspectionEvent({
          prompt: {
            version: "rag-system@v2",
            system: "s",
            user: "u",
            sourceTokens: 0,
            budget: 100,
            sent: false,
          },
        }),
      );
      f.channels[0]?.push(doneEvent({ answered: false, refusal: "low-score", cited: [] }));
      f.channels[0]?.close();
    });
    expect(await screen.findByText(/The model was not called with this prompt/)).toBeTruthy();
  });

  it("shows each stage with its time and summary, and what the answer cost", async () => {
    const f = await open();
    await answered(f, true);
    const stages = within(screen.getByLabelText("Stages"));
    expect(stages.getByText("rerank")).toBeTruthy();
    expect(stages.getByText("42 ms")).toBeTruthy();
    expect(stages.getByText("reranker llm · kept 2 · reordered true")).toBeTruthy();
    expect(
      stages.getByText(/Total 1\.2 s · 1 call · 900 prompt tokens · 60 answer tokens/),
    ).toBeTruthy();
  });

  it("says so when retrieval found nothing", async () => {
    const f = await open();
    await ask(f, "Nothing here?");
    act(() => {
      f.channels[0]?.push(inspectionEvent({ candidates: [] }));
      f.channels[0]?.push(doneEvent({ answered: false, refusal: "no-sources", cited: [] }));
      f.channels[0]?.close();
    });
    expect(await screen.findByText("Retrieval found nothing.")).toBeTruthy();
  });

  it("keeps an answer's inspection beside it when a second question is asked", async () => {
    const f = await open();
    await answered(f, true);
    await ask(f, "And then?");
    expect(screen.getAllByText("Inspect this answer")).toHaveLength(1);
  });
});
