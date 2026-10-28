// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOK,
  DOC,
  citation,
  citationsEvent,
  doneEvent,
  fakes,
  installDomStubs,
  mount,
  pageBox,
  token,
} from "./test-support.js";
import type { Fakes } from "./test-support.js";

beforeEach(installDomStubs);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const box = (): HTMLTextAreaElement => screen.getByLabelText("Your question");

/** Opens the book, types a question and sends it with the button. Resolves once it has been asked. */
async function ask(f: Fakes, question: string, asked = f.channels.length + 1): Promise<void> {
  fireEvent.change(box(), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
  await waitFor(() => {
    expect(f.channels).toHaveLength(asked);
  });
}

async function open(f: Fakes = fakes()): Promise<Fakes> {
  mount(f);
  await screen.findByRole("heading", { name: "Vectors" });
  await screen.findByRole("textbox", { name: "Your question" });
  return f;
}

/** Answers the first question with "The share is 51% [1]." and a source on page 3. */
async function answered(f: Fakes, extra = citation(1)): Promise<void> {
  await ask(f, "What share use RAG?");
  const stream = f.channels[0];
  act(() => {
    stream?.push(token("The share is 51% [1]."));
    stream?.push(citationsEvent(extra));
    stream?.push(doneEvent({ cited: [1] }));
    stream?.close();
  });
  await screen.findByRole("button", { name: /^Source 1/ });
}

describe("asking the book", () => {
  it("says how to start, and keeps Ask disabled until there is a question", async () => {
    await open();
    expect(screen.getByText(/Ask a question about the book/)).toBeTruthy();
    const send = screen.getByRole<HTMLButtonElement>("button", { name: "Ask" });
    expect(send.disabled).toBe(true);
    fireEvent.change(box(), { target: { value: "   " } });
    expect(send.disabled).toBe(true);
    fireEvent.change(box(), { target: { value: "Why?" } });
    expect(send.disabled).toBe(false);
  });

  it("sends the question for this book, and writes the answer as it arrives", async () => {
    const f = await open();
    await ask(f, "What share use RAG?");
    expect(f.requests[0]).toEqual({
      question: "What share use RAG?",
      filter: { documents: [DOC] },
    });
    expect(screen.getByText("What share use RAG?")).toBeTruthy();
    expect(screen.getByText("Reading the book…")).toBeTruthy();

    const stream = f.channels[0];
    act(() => {
      stream?.push(token("The share is "));
    });
    expect(await screen.findByText(/The share is/)).toBeTruthy();
    expect(screen.queryByText("Reading the book…")).toBeNull();

    // the mark is written before the sources arrive: it is shown, but is not yet a button
    act(() => {
      stream?.push(token("51% [1]."));
    });
    await waitFor(() => {
      expect(document.querySelector(".cite-pending")?.textContent).toBe("[1]");
    });
    expect(screen.queryByRole("button", { name: /^Source 1/ })).toBeNull();

    act(() => {
      stream?.push(citationsEvent(citation(1)));
    });
    expect(await screen.findByRole("button", { name: "Source 1, page 3" })).toBeTruthy();
    expect(document.querySelector(".cite-pending")).toBeNull();

    act(() => {
      stream?.push(doneEvent());
      stream?.close();
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    });
  });

  it("sends with Enter, and starts a new line with Shift+Enter", async () => {
    const f = await open();
    fireEvent.change(box(), { target: { value: "First line" } });
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    expect(f.channels).toHaveLength(0);

    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => {
      expect(f.channels).toHaveLength(1);
    });
    expect(f.requests[0]?.question).toBe("First line");
    expect(box().value).toBe("");
  });

  it("sends the earlier answers with the next question, because the server keeps none", async () => {
    const f = await open();
    await answered(f);
    await ask(f, "And a year earlier?");
    expect(f.requests[1]).toEqual({
      question: "And a year earlier?",
      history: [{ question: "What share use RAG?", answer: "The share is 51% [1]." }],
      filter: { documents: [DOC] },
    });
  });

  it("waits for an answer before taking another question", async () => {
    const f = await open();
    await ask(f, "First?");
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
    fireEvent.change(box(), { target: { value: "Second?" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(f.channels).toHaveLength(1);
  });

  it("stops the request and keeps what had arrived", async () => {
    const f = await open();
    await ask(f, "Why?");
    act(() => {
      f.channels[0]?.push(token("Half an ans"));
    });
    await screen.findByText(/Half an ans/);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(f.aborted).toEqual([true]);
    expect(await screen.findByText("Stopped.")).toBeTruthy();
    expect(screen.getByText(/Half an ans/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ask" })).toBeTruthy();
  });

  it("cancels the request when the reader goes away", async () => {
    const f = fakes();
    const view = mount(f);
    await screen.findByRole("textbox", { name: "Your question" });
    await ask(f, "Why?");
    view.unmount();
    expect(f.aborted).toEqual([true]);
  });

  it("shows a request that failed, and asks it again on Try again", async () => {
    const f = await open(
      fakes({ askFails: new Error("Cannot reach the API. Start it with: pnpm api") }),
    );
    await ask(f, "Why?");
    expect((await screen.findByRole("alert")).textContent).toContain("pnpm api");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(f.channels).toHaveLength(2);
    });
    expect(f.requests[1]?.question).toBe("Why?");
    // the failed attempt was replaced, not left beside the new one
    expect(document.querySelectorAll(".question")).toHaveLength(1);
  });

  it("keeps the text that arrived when the answer fails in the middle", async () => {
    const f = await open();
    await ask(f, "Why?");
    act(() => {
      f.channels[0]?.push(token("Because the"));
    });
    await screen.findByText(/Because the/);
    act(() => {
      f.channels[0]?.push({
        event: "error",
        data: { code: "PROVIDER_UNAVAILABLE", message: "The model stopped answering." },
      });
    });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The model stopped answering.",
    );
    expect(screen.getByText(/Because the/)).toBeTruthy();
  });

  it("says when the book had nothing good enough to answer from", async () => {
    const f = await open();
    await ask(f, "What is the capital of Mars?");
    act(() => {
      f.channels[0]?.push(token("I could not find the answer to that in the book."));
      f.channels[0]?.push(citationsEvent());
      f.channels[0]?.push(doneEvent({ answered: false, refusal: "no-sources" }));
      f.channels[0]?.close();
    });
    expect(await screen.findByText(/nothing good enough/)).toBeTruthy();
    // a refusal is not carried into the history of the next question
    await ask(f, "Next?");
    expect(f.requests[1]).not.toHaveProperty("history");
  });

  it("does not make a button of a number that has no source, and marks it", async () => {
    const f = await open();
    await ask(f, "Why?");
    act(() => {
      f.channels[0]?.push(token("A [1] and B [9]."));
      f.channels[0]?.push(citationsEvent(citation(1)));
      f.channels[0]?.push(doneEvent({ unknownCitations: [9] }));
      f.channels[0]?.close();
    });
    await screen.findByRole("button", { name: /^Source 1/ });
    expect(screen.queryByRole("button", { name: /^Source 9/ })).toBeNull();
    const unknown = document.querySelector(".cite-unknown");
    expect(unknown?.textContent).toBe("[9]");
    expect(unknown?.getAttribute("title")).toContain("not given");
  });

  it("starts a new conversation", async () => {
    const f = await open();
    await answered(f);
    fireEvent.click(screen.getByRole("button", { name: "Start a new conversation" }));
    expect(screen.getByText(/Ask a question about the book/)).toBeTruthy();
    await ask(f, "Fresh start?");
    expect(f.requests[1]).not.toHaveProperty("history");
  });
});

describe("following a citation", () => {
  it("goes to the page, shows the passage, and marks it on the page", async () => {
    const f = await open();
    await answered(f);
    expect(pageBox().value).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "Source 1, page 3" }));
    expect(pageBox().value).toBe("3");
    const bar = screen.getByRole("complementary", { name: "Selected source" });
    expect(within(bar).getByText("Source [1] · page 3")).toBeTruthy();
    expect(within(bar).getByText("Cosine similarity compares direction.")).toBeTruthy();

    // asked for by the citation's character range, in this book
    await waitFor(() => {
      expect(f.getHighlights).toHaveBeenCalledWith(1004, 1012, DOC, expect.any(AbortSignal));
    });
    // a box 12 tall at y = 700 on an 800-point page, drawn at scale 1: 88 points from the top
    const mark = await screen.findByTestId("highlight-box");
    expect(mark.style.left).toBe("100px");
    expect(mark.style.top).toBe("88px");
    expect(mark.style.width).toBe("200px");
    expect(mark.style.height).toBe("12px");
    expect(
      screen.getByRole("button", { name: "Source 1, page 3" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("marks only the page the passage is on: it goes away on other pages and comes back", async () => {
    const f = await open();
    await answered(f);
    fireEvent.click(screen.getByRole("button", { name: "Source 1, page 3" }));
    await screen.findByTestId("highlight-box");

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(pageBox().value).toBe("4");
    await waitFor(() => {
      expect(screen.queryByTestId("highlight-box")).toBeNull();
    });
    // away from the page, the source bar offers the way back
    fireEvent.click(screen.getByRole("button", { name: "Go to the passage" }));
    expect(pageBox().value).toBe("3");
    expect(await screen.findByTestId("highlight-box")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Go to the passage" })).toBeNull();
  });

  it("clears the mark with the cross or with Escape", async () => {
    const f = await open();
    await answered(f);
    fireEvent.click(screen.getByRole("button", { name: "Source 1, page 3" }));
    await screen.findByTestId("highlight-box");

    fireEvent.click(screen.getByRole("button", { name: "Clear the selected source" }));
    expect(screen.queryByRole("complementary", { name: "Selected source" })).toBeNull();
    expect(screen.queryByTestId("highlight-box")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Source 1, page 3" }));
    await screen.findByTestId("highlight-box");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("highlight-box")).toBeNull();
    });
    expect(screen.queryByRole("complementary", { name: "Selected source" })).toBeNull();
  });

  it("replaces the mark when another source is chosen, from a chip or from the list", async () => {
    const f = await open(
      fakes({
        highlights: (from) =>
          Promise.resolve({
            docId: DOC,
            pages:
              from === 1004
                ? [{ number: 3, boxes: [{ x: 100, y: 700, width: 200, height: 12 }] }]
                : [{ number: 6, boxes: [{ x: 50, y: 400, width: 80, height: 12 }] }],
          }),
      }),
    );
    await ask(f, "Two things?");
    act(() => {
      f.channels[0]?.push(token("One [1] and two [2]."));
      f.channels[0]?.push(
        citationsEvent(
          citation(1),
          citation(2, { pageStart: 6, pageEnd: 6, charStart: 5000, charEnd: 5040 }),
        ),
      );
      f.channels[0]?.push(doneEvent());
      f.channels[0]?.close();
    });
    await screen.findByRole("button", { name: "Source 2, page 6" });

    fireEvent.click(screen.getByRole("button", { name: "Source 1, page 3" }));
    expect((await screen.findByTestId("highlight-box")).style.top).toBe("88px");

    // the second one, from the list under the answer
    fireEvent.click(screen.getByText("Sources (2)"));
    fireEvent.click(screen.getByRole("button", { name: /\[2\] p\. 6/ }));
    expect(pageBox().value).toBe("6");
    await waitFor(() => {
      expect(screen.getByTestId("highlight-box").style.top).toBe("388px"); // 800 - 412
    });
    expect(screen.getAllByTestId("highlight-box")).toHaveLength(1);
  });

  it("goes to the first page of a source that spans pages", async () => {
    const f = await open();
    await ask(f, "Long?");
    act(() => {
      f.channels[0]?.push(token("See [1]."));
      f.channels[0]?.push(citationsEvent(citation(1, { pageStart: 4, pageEnd: 5 })));
      f.channels[0]?.push(doneEvent());
      f.channels[0]?.close();
    });
    fireEvent.click(await screen.findByRole("button", { name: "Source 1, pages 4 to 5" }));
    expect(pageBox().value).toBe("4");
    expect(screen.getByText("Source [1] · pages 4 to 5")).toBeTruthy();
  });

  it("marks the passage in the text when the book has no PDF", async () => {
    const f = await open(
      fakes({
        book: { ...BOOK, pdf: false },
        pageText: () => ({ text: "The quick brown fox jumps.", start: 1000 }),
      }),
    );
    await answered(f);
    fireEvent.click(screen.getByRole("button", { name: "Source 1, page 3" }));
    // characters 1004 to 1012 of the document are 4 to 12 of this page: "quick br"
    await waitFor(() => {
      expect(document.querySelector("mark")?.textContent).toBe("quick br");
    });
    expect(screen.queryByTestId("highlight-box")).toBeNull();
  });

  it("still goes to the page and shows the quote when the passage cannot be placed", async () => {
    const f = await open(
      fakes({ highlights: () => Promise.reject(new Error("The index holds no document.")) }),
    );
    await answered(f);
    fireEvent.click(screen.getByRole("button", { name: "Source 1, page 3" }));
    expect(pageBox().value).toBe("3");
    expect(await screen.findByText(/could not be marked on the page/)).toBeTruthy();
    expect(
      within(screen.getByRole("complementary", { name: "Selected source" })).getByText(
        "Cosine similarity compares direction.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("highlight-box")).toBeNull();
  });

  it("draws no mark on a page it cannot place, such as a rotated one, rather than a wrong one", async () => {
    const f = await open(fakes({ view: { overlay: false } }));
    await answered(f);
    fireEvent.click(screen.getByRole("button", { name: "Source 1, page 3" }));
    await waitFor(() => {
      expect(f.getHighlights).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(f.rendered).toContain(3);
    });
    expect(screen.queryByTestId("highlight-box")).toBeNull();
    expect(
      within(screen.getByRole("complementary", { name: "Selected source" })).getByText(
        "Cosine similarity compares direction.",
      ),
    ).toBeTruthy();
  });

  it("forgets the source when the conversation is cleared", async () => {
    const f = await open();
    await answered(f);
    fireEvent.click(screen.getByRole("button", { name: "Source 1, page 3" }));
    await screen.findByTestId("highlight-box");
    fireEvent.click(screen.getByRole("button", { name: "Start a new conversation" }));
    await waitFor(() => {
      expect(screen.queryByRole("complementary", { name: "Selected source" })).toBeNull();
    });
    expect(screen.queryByTestId("highlight-box")).toBeNull();
  });
});
