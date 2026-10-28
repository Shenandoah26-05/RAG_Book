// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOK,
  DOC,
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
  window.getSelection()?.removeAllRanges();
});

const PASSAGE = "Embeddings turn sentences into vectors that can be compared.";

async function open(f: Fakes = fakes({ textLayer: PASSAGE })): Promise<Fakes> {
  mount(f);
  await screen.findByRole("heading", { name: "Vectors" });
  await screen.findByRole("textbox", { name: "Your question" });
  return f;
}

/** Selects everything inside `element`, as a reader's drag would, and lets go of the mouse. */
async function select(element: Element): Promise<void> {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("pointerup"));
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Ask about this" })).toBeTruthy();
  });
}

/** The text layer of the page, once the page has drawn and put its text in it. */
async function drawnLayer(): Promise<HTMLElement> {
  const layer = await screen.findByTestId("text-layer");
  await waitFor(() => {
    expect(layer.textContent.length).toBeGreaterThan(0);
  });
  return layer;
}

/** The chapter named beside the "This chapter" button, or "every chapter". */
const searchedChapter = (): HTMLElement =>
  within(screen.getByRole("group", { name: "Where to search" })).getByText(
    /^(Embeddings|Stores|every chapter)$/,
  );

/** Selects the page's text, and presses "Ask about this". */
async function askAboutThePage(): Promise<void> {
  const layer = await screen.findByTestId("text-layer");
  await waitFor(() => {
    expect(layer.textContent).toBe(PASSAGE);
  });
  await select(layer);
  fireEvent.click(screen.getByRole("button", { name: "Ask about this" }));
}

const box = (): HTMLTextAreaElement => screen.getByLabelText("Your question");
const sendWith = (question: string): void => {
  fireEvent.change(box(), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
};

describe("selecting a passage on the page", () => {
  it("offers to ask about it once the reader lets go, and not before there is a selection", async () => {
    await open();
    expect(screen.queryByRole("button", { name: "Ask about this" })).toBeNull();
    await select(await drawnLayer());
    expect(screen.getByRole("button", { name: "Ask about this" })).toBeTruthy();
  });

  it("takes the passage to the chat, ready to type, and clears the selection on the page", async () => {
    await open();
    await askAboutThePage();

    const card = screen.getByRole("group", { name: "Selected passage" });
    expect(within(card).getByText("Selected passage · page 1")).toBeTruthy();
    expect(within(card).getByText(PASSAGE)).toBeTruthy();
    expect(document.activeElement).toBe(box());
    expect(box().placeholder).toBe("Ask about the selected passage…");
    expect(screen.queryByRole("button", { name: "Ask about this" })).toBeNull();
    expect(window.getSelection()?.toString()).toBe("");
  });

  it("takes the page the reader was on", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(pageBox().value).toBe("3");
    await waitFor(() => {
      expect(screen.getByTestId("text-layer").textContent).toBe(PASSAGE);
    });
    await askAboutThePage();
    expect(screen.getByText("Selected passage · page 3")).toBeTruthy();
  });

  it("goes away when the selection does", async () => {
    await open();
    await select(await drawnLayer());
    act(() => {
      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Ask about this" })).toBeNull();
    });
  });

  it("ignores a selection that is not on the page, such as one in the chat", async () => {
    await open();
    const range = document.createRange();
    range.selectNodeContents(screen.getByText(/Ask a question about the book/));
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    document.dispatchEvent(new Event("pointerup"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("button", { name: "Ask about this" })).toBeNull();
  });

  it("works in the text view too, when the book has no PDF", async () => {
    const f = fakes({
      book: { ...BOOK, pdf: false },
      pageText: () => ({ text: PASSAGE, start: 0 }),
    });
    await open(f);
    const page = await screen.findByLabelText("Page 1");
    await waitFor(() => {
      expect(page.textContent).toContain(PASSAGE);
    });
    await select(page.querySelector("pre") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Ask about this" }));
    expect(screen.getByText("Selected passage · page 1")).toBeTruthy();
  });

  it("joins the lines of the selection into one passage before it is sent", async () => {
    const f = await open(
      fakes({ textLayer: "Embeddings turn sentences into vec-\ntors that\ncan be compared." }),
    );
    await askAboutThePage_noCheck();
    sendWith("Explain this");
    await waitFor(() => {
      expect(f.requests).toHaveLength(1);
    });
    expect(f.requests[0]?.selection?.text).toBe(
      "Embeddings turn sentences into vectors that can be compared.",
    );
  });

  it("says when only the start of a very long selection is sent, and sends only that", async () => {
    const f = await open(fakes({ textLayer: "word ".repeat(700) }));
    await askAboutThePage_noCheck();
    expect(screen.getByText("Only the start of the selection is sent.")).toBeTruthy();
    sendWith("Summarize");
    await waitFor(() => {
      expect(f.requests).toHaveLength(1);
    });
    expect(f.requests[0]?.selection?.text.length).toBeLessThanOrEqual(2000);
  });
});

/** Like `askAboutThePage`, for a layer whose text is not `PASSAGE`. */
async function askAboutThePage_noCheck(): Promise<void> {
  const layer = await screen.findByTestId("text-layer");
  await waitFor(() => {
    expect(layer.textContent.length).toBeGreaterThan(0);
  });
  await select(layer);
  fireEvent.click(screen.getByRole("button", { name: "Ask about this" }));
}

describe("asking about it", () => {
  it("sends the question with the passage and the page, limited to this chapter", async () => {
    const f = await open();
    await askAboutThePage();
    sendWith("Why does this matter?");
    await waitFor(() => {
      expect(f.requests).toHaveLength(1);
    });
    expect(f.requests[0]).toEqual({
      question: "Why does this matter?",
      selection: { text: PASSAGE, page: 1 },
      // page 1 is in the chapter "Embeddings"
      filter: { documents: [DOC], section: ["Embeddings"] },
    });
  });

  it("has quick questions for the passage, which send at once", async () => {
    const f = await open();
    await askAboutThePage();
    fireEvent.click(screen.getByRole("button", { name: "Explain" }));
    await waitFor(() => {
      expect(f.requests).toHaveLength(1);
    });
    expect(f.requests[0]?.question).toBe("Explain this passage in simple terms.");
    expect(f.requests[0]?.selection?.text).toBe(PASSAGE);
  });

  it("shows what a question was about and where it looked, beside the question", async () => {
    const f = await open();
    await askAboutThePage();
    sendWith("Why?");
    await waitFor(() => {
      expect(f.requests).toHaveLength(1);
    });
    expect(await screen.findByText(/About page 1:/)).toBeTruthy();
    expect(screen.getByText(`About page 1: “${PASSAGE}”`)).toBeTruthy();
    expect(screen.getByText("Searched in Embeddings")).toBeTruthy();
  });

  it("uses the passage for one question only: the next one starts without it", async () => {
    const f = await open();
    await askAboutThePage();
    sendWith("Why?");
    await waitFor(() => {
      expect(f.channels).toHaveLength(1);
    });
    expect(screen.queryByRole("group", { name: "Selected passage" })).toBeNull();
    act(() => {
      f.channels[0]?.push(token("Because."));
      f.channels[0]?.push(citationsEvent());
      f.channels[0]?.push(doneEvent());
      f.channels[0]?.close();
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    });
    sendWith("And another thing?");
    await waitFor(() => {
      expect(f.requests).toHaveLength(2);
    });
    expect(f.requests[1]).not.toHaveProperty("selection");
  });

  it("lets the reader drop the passage before asking", async () => {
    const f = await open();
    await askAboutThePage();
    fireEvent.click(screen.getByRole("button", { name: "Remove the selected passage" }));
    expect(screen.queryByRole("group", { name: "Selected passage" })).toBeNull();
    sendWith("Plain question");
    await waitFor(() => {
      expect(f.requests).toHaveLength(1);
    });
    expect(f.requests[0]).not.toHaveProperty("selection");
  });

  it("asks a failed question again with the same passage and the same limits", async () => {
    const f = await open(fakes({ textLayer: PASSAGE, askFails: new Error("model down") }));
    await askAboutThePage();
    sendWith("Why?");
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(f.requests).toHaveLength(2);
    });
    expect(f.requests[1]).toEqual(f.requests[0]);
    expect(f.requests[1]?.selection?.text).toBe(PASSAGE);
    expect(f.requests[1]?.filter?.section).toEqual(["Embeddings"]);
  });
});

describe("where the search looks", () => {
  it("is the whole book by default, because an open question can be about any of it", async () => {
    const f = await open();
    expect(screen.getByRole("button", { name: "Whole book" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.change(box(), { target: { value: "What is the book about?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => {
      expect(f.requests).toHaveLength(1);
    });
    expect(f.requests[0]?.filter).toEqual({ documents: [DOC] });
  });

  it("is this chapter once a passage is chosen, and says which", async () => {
    await open();
    await askAboutThePage();
    expect(screen.getByRole("button", { name: "This chapter" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(searchedChapter().textContent).toBe("Embeddings");
  });

  it("can be changed: the whole book with a passage, or a chapter without one", async () => {
    const f = await open();
    await askAboutThePage();
    fireEvent.click(screen.getByRole("button", { name: "Whole book" }));
    sendWith("Anywhere in the book?");
    await waitFor(() => {
      expect(f.requests).toHaveLength(1);
    });
    expect(f.requests[0]?.filter).toEqual({ documents: [DOC] });
    expect(f.requests[0]?.selection?.text).toBe(PASSAGE);
    expect(screen.queryByText(/Searched in/)).toBeNull();

    // the reader's choice stays: a chapter, with no passage this time
    act(() => {
      f.channels[0]?.push(doneEvent());
      f.channels[0]?.close();
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    });
    fireEvent.click(screen.getByRole("button", { name: "This chapter" }));
    sendWith("Only this chapter?");
    await waitFor(() => {
      expect(f.requests).toHaveLength(2);
    });
    expect(f.requests[1]?.filter).toEqual({ documents: [DOC], section: ["Embeddings"] });
    expect(f.requests[1]).not.toHaveProperty("selection");
  });

  it("follows the reader through the book: the chapter is the one the page is in", async () => {
    await open();
    expect(searchedChapter().textContent).toBe("every chapter");
    fireEvent.click(screen.getByRole("button", { name: "This chapter" }));
    expect(searchedChapter().textContent).toBe("Embeddings");
    fireEvent.change(pageBox(), { target: { value: "8" } });
    fireEvent.submit(pageBox().closest("form") as HTMLFormElement);
    await waitFor(() => {
      expect(searchedChapter().textContent).toBe("Stores");
    });
  });

  it("has no chapter to limit to when the book has no headings, and says nothing about one", async () => {
    const f = await open(fakes({ book: { ...BOOK, outline: [] }, textLayer: PASSAGE }));
    expect(screen.queryByRole("group", { name: "Where to search" })).toBeNull();
    await askAboutThePage();
    sendWith("Why?");
    await waitFor(() => {
      expect(f.requests).toHaveLength(1);
    });
    expect(f.requests[0]?.filter).toEqual({ documents: [DOC] });
    expect(f.requests[0]?.selection?.text).toBe(PASSAGE);
  });

  it("offers the whole book when a chapter had nothing good enough, with the same question and passage", async () => {
    const f = await open();
    await askAboutThePage();
    sendWith("What did the author conclude?");
    await waitFor(() => {
      expect(f.channels).toHaveLength(1);
    });
    act(() => {
      f.channels[0]?.push(token("I could not find the answer to that in the book."));
      f.channels[0]?.push(citationsEvent());
      f.channels[0]?.push(doneEvent({ answered: false, refusal: "no-sources" }));
      f.channels[0]?.close();
    });
    expect(
      await screen.findByText(/nothing good enough to answer this from in this chapter/),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Ask the whole book instead" }));
    await waitFor(() => {
      expect(f.requests).toHaveLength(2);
    });
    expect(f.requests[1]).toEqual({
      question: "What did the author conclude?",
      selection: { text: PASSAGE, page: 1 },
      filter: { documents: [DOC] },
    });
  });

  it("does not offer the whole book to a question that already searched all of it", async () => {
    const f = await open();
    fireEvent.change(box(), { target: { value: "Anything?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => {
      expect(f.channels).toHaveLength(1);
    });
    act(() => {
      f.channels[0]?.push(citationsEvent());
      f.channels[0]?.push(doneEvent({ answered: false, refusal: "no-sources" }));
      f.channels[0]?.close();
    });
    expect(await screen.findByText(/nothing good enough/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ask the whole book instead" })).toBeNull();
  });
});
