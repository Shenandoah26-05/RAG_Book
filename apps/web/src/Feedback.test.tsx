// @vitest-environment jsdom
import { ANSWER_ID } from "@rag-book/api-contract";
import type { AskEvent, FeedbackRequest, FeedbackResponse } from "@rag-book/api-contract";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOC,
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

const TRACE = { totalMs: 42, stages: [] };
const traceEvent: AskEvent = { event: "trace", data: { trace: TRACE } };

const good = (): HTMLButtonElement => screen.getByRole("button", { name: "Good answer" });
const bad = (): HTMLButtonElement => screen.getByRole("button", { name: "Bad answer" });

async function open(f: Fakes): Promise<Fakes> {
  mount(f);
  await screen.findByRole("heading", { name: "Vectors" });
  await screen.findByRole("textbox", { name: "Your question" });
  return f;
}

/** Asks a question and lets the answer run to its end, `index` being the question's place. */
async function answer(f: Fakes, question: string, events: AskEvent[], index = 0): Promise<void> {
  fireEvent.change(screen.getByLabelText("Your question"), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
  await waitFor(() => {
    expect(f.channels).toHaveLength(index + 1);
  });
  const stream = f.channels[index];
  act(() => {
    for (const event of events) stream?.push(event);
    stream?.close();
  });
}

const standard = (): AskEvent[] => [
  token("The share is 51% [1]."),
  citationsEvent(citation(1)),
  traceEvent,
  doneEvent({ cited: [1] }),
];

describe("rating an answer", () => {
  it("offers a rating only once the answer is finished", async () => {
    const f = await open(fakes());
    fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "Why?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => {
      expect(f.channels).toHaveLength(1);
    });
    act(() => {
      f.channels[0]?.push(token("Because"));
    });
    await screen.findByText(/Because/);
    expect(screen.queryByRole("button", { name: "Good answer" })).toBeNull();

    act(() => {
      f.channels[0]?.push(doneEvent());
      f.channels[0]?.close();
    });
    expect(await screen.findByRole("button", { name: "Good answer" })).toBeTruthy();
  });

  it("offers none for an answer that failed or was stopped", async () => {
    const f = await open(fakes());
    await answer(f, "Why?", [
      token("Half"),
      { event: "error", data: { code: "INTERNAL", message: "boom" } },
    ]);
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Good answer" })).toBeNull();
  });

  it("sends a thumbs up with the question, answer, sources and trace, and says it was kept", async () => {
    const f = await open(fakes());
    await answer(f, "What share use RAG?", standard());
    fireEvent.click(await screen.findByRole("button", { name: "Good answer" }));

    expect(await screen.findByText("Saved. Thank you.")).toBeTruthy();
    expect(f.feedbacks).toEqual([
      {
        answerId: expect.stringMatching(ANSWER_ID) as string,
        rating: "up",
        question: "What share use RAG?",
        answer: "The share is 51% [1].",
        docId: DOC,
        citations: [citation(1)],
        trace: TRACE,
      },
    ]);
    expect(good().getAttribute("aria-pressed")).toBe("true");
    expect(bad().getAttribute("aria-pressed")).toBe("false");
  });

  it("sends the rating at once, and again with the note when one is added: the same answer", async () => {
    const f = await open(fakes());
    await answer(f, "What share use RAG?", standard());
    fireEvent.click(await screen.findByRole("button", { name: "Bad answer" }));
    await screen.findByText("Saved. Thank you.");

    fireEvent.click(screen.getByRole("button", { name: "Add a note" }));
    fireEvent.change(screen.getByLabelText("Note about this answer"), {
      target: { value: "  the share was for 2024  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => {
      expect(f.feedbacks).toHaveLength(2);
    });
    const [first, second] = f.feedbacks as [FeedbackRequest, FeedbackRequest];
    expect(first).not.toHaveProperty("note");
    expect(second).toMatchObject({ rating: "down", note: "the share was for 2024" });
    expect(second.answerId).toBe(first.answerId);
    expect(await screen.findByRole("button", { name: "Edit note" })).toBeTruthy();
    expect(screen.queryByLabelText("Note about this answer")).toBeNull();
  });

  it("changes a mind: the new rating goes with the same answer, and the old note does not follow it", async () => {
    const f = await open(fakes());
    await answer(f, "What share use RAG?", standard());
    fireEvent.click(await screen.findByRole("button", { name: "Bad answer" }));
    await screen.findByText("Saved. Thank you.");
    fireEvent.click(screen.getByRole("button", { name: "Add a note" }));
    fireEvent.change(screen.getByLabelText("Note about this answer"), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => {
      expect(f.feedbacks).toHaveLength(2);
    });

    fireEvent.click(good());
    await waitFor(() => {
      expect(f.feedbacks).toHaveLength(3);
    });
    const last = f.feedbacks[2];
    expect(last).toMatchObject({ rating: "up", answerId: f.feedbacks[0]?.answerId });
    expect(last).not.toHaveProperty("note");
    expect(screen.getByRole("button", { name: "Add a note" })).toBeTruthy();
  });

  it("cancels a note without sending anything", async () => {
    const f = await open(fakes());
    await answer(f, "What share use RAG?", standard());
    fireEvent.click(await screen.findByRole("button", { name: "Good answer" }));
    await screen.findByText("Saved. Thank you.");
    fireEvent.click(screen.getByRole("button", { name: "Add a note" }));
    fireEvent.change(screen.getByLabelText("Note about this answer"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Note about this answer")).toBeNull();
    expect(f.feedbacks).toHaveLength(1);
  });

  it("holds the buttons while the rating is on its way", async () => {
    let finish: ((r: FeedbackResponse) => void) | undefined;
    const f = await open(
      fakes({
        feedback: (request) =>
          new Promise<FeedbackResponse>((resolve) => {
            finish = () => {
              resolve({ answerId: request.answerId, saved: true });
            };
          }),
      }),
    );
    await answer(f, "What share use RAG?", standard());
    fireEvent.click(await screen.findByRole("button", { name: "Good answer" }));

    expect(await screen.findByText("Saving…")).toBeTruthy();
    expect(good().disabled).toBe(true);
    expect(bad().disabled).toBe(true);
    fireEvent.click(bad());
    expect(f.feedbacks).toHaveLength(1);

    act(() => {
      finish?.({ answerId: "x", saved: true });
    });
    expect(await screen.findByText("Saved. Thank you.")).toBeTruthy();
    expect(bad().disabled).toBe(false);
  });

  it("says when the rating could not be kept, and lets the reader try again", async () => {
    let fail = true;
    const f = await open(
      fakes({
        feedback: (request) =>
          fail
            ? Promise.reject(new Error("Cannot reach the API. Start it with: pnpm api"))
            : Promise.resolve({ answerId: request.answerId, saved: true }),
      }),
    );
    await answer(f, "What share use RAG?", standard());
    fireEvent.click(await screen.findByRole("button", { name: "Good answer" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not save your rating");
    expect(alert.textContent).toContain("Cannot reach the API");
    expect(screen.queryByText("Saved. Thank you.")).toBeNull();

    fail = false;
    fireEvent.click(good());
    expect(await screen.findByText("Saved. Thank you.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(f.feedbacks.map((r) => r.answerId)).toEqual([
      f.feedbacks[0]?.answerId,
      f.feedbacks[0]?.answerId,
    ]);
  });

  it("rates an answer the book declined, with the reason", async () => {
    const f = await open(fakes());
    await answer(f, "Who wrote the cabin rules?", [
      doneEvent({ answered: false, refusal: "no-sources" }),
    ]);
    fireEvent.click(await screen.findByRole("button", { name: "Good answer" }));
    await screen.findByText("Saved. Thank you.");
    expect(f.feedbacks[0]).toMatchObject({
      rating: "up",
      answer: "",
      refusal: "no-sources",
      citations: [],
    });
  });

  it("gives each answer its own id, so ratings of two answers are not one", async () => {
    const f = await open(fakes());
    await answer(f, "First question?", standard(), 0);
    fireEvent.click(await screen.findByRole("button", { name: "Good answer" }));
    await screen.findByText("Saved. Thank you.");

    await answer(f, "Second question?", standard(), 1);
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Bad answer" })).toHaveLength(2);
    });
    const [, secondBad] = screen.getAllByRole("button", { name: "Bad answer" });
    if (secondBad === undefined) throw new Error("no second answer");
    fireEvent.click(secondBad);
    await waitFor(() => {
      expect(f.feedbacks).toHaveLength(2);
    });
    expect(f.feedbacks[0]?.answerId).not.toBe(f.feedbacks[1]?.answerId);
    expect(f.feedbacks.map((r) => r.question)).toEqual(["First question?", "Second question?"]);
  });

  it("is gone with the conversation", async () => {
    const f = await open(fakes());
    await answer(f, "What share use RAG?", standard());
    await screen.findByRole("button", { name: "Good answer" });
    fireEvent.click(screen.getByRole("button", { name: "Start a new conversation" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Good answer" })).toBeNull();
    });
  });
});
