// @vitest-environment jsdom
import type { BookResponse, PageResponse } from "@rag-book/api-contract";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { ApiError } from "./api/client.js";
import type { ApiClient } from "./api/client.js";
import type { OpenPdf, PdfBook } from "./pdf/types.js";
import type { PositionStorage } from "./reader/position.js";

const DOC = "a1b2c3d4-e5f6-5a7b-8c9d-0e1f2a3b4c5d";

const entry = (
  title: string,
  level: number,
  pageStart: number,
  pageEnd: number,
  children: BookResponse["outline"] = [],
) => ({ title, level, pageStart, pageEnd, children });

const BOOK: BookResponse = {
  docId: DOC,
  title: "Vectors",
  pageCount: 12,
  pdf: true,
  outline: [
    entry("Embeddings", 1, 1, 5, [entry("Similarity", 2, 3, 5)]),
    entry("Stores", 1, 6, 12),
  ],
};

interface Fakes {
  client: ApiClient;
  /** The mock behind `client.getBook`, to see how it was called and to make it fail. */
  getBook: ReturnType<typeof vi.fn>;
  rendered: number[];
  opened: string[];
  destroyed: () => number;
  openPdf: OpenPdf;
  storage: PositionStorage & { data: Map<string, string> };
}

function fakes(options: { book?: BookResponse; openFails?: boolean } = {}): Fakes {
  const rendered: number[] = [];
  const opened: string[] = [];
  let destroyed = 0;
  const pdf: PdfBook = {
    pageCount: 12,
    render: (page) => {
      rendered.push(page);
      return Promise.resolve();
    },
    destroy: () => {
      destroyed++;
      return Promise.resolve();
    },
  };
  const getBook = vi.fn(() => Promise.resolve(options.book ?? BOOK));
  const client = {
    getBook,
    getPage: vi.fn((number: number) =>
      Promise.resolve<PageResponse>({
        docId: DOC,
        title: "Vectors",
        number,
        pageCount: 12,
        text: `Text of page ${number.toString()}.`,
        span: { start: 0, end: 10 },
      }),
    ),
    pdfUrl: (doc?: string) => `/api/book/pdf${doc === undefined ? "" : `?doc=${doc}`}`,
  };
  const data = new Map<string, string>();
  return {
    client,
    getBook,
    rendered,
    opened,
    destroyed: () => destroyed,
    openPdf: (url) => {
      opened.push(url);
      return options.openFails === true
        ? Promise.reject(new Error("Missing PDF"))
        : Promise.resolve(pdf);
    },
    storage: {
      data,
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
    },
  };
}

function mount(f: Fakes, doc?: string) {
  return render(
    <App
      client={f.client}
      openPdf={f.openPdf}
      storage={f.storage}
      {...(doc === undefined ? {} : { doc })}
    />,
  );
}

/** The page the reader says it is on, from the page box. */
const pageBox = (): HTMLInputElement => screen.getByLabelText("Page number");

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  // jsdom has no layout: give the reading area a width, and a ResizeObserver that never fires
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 800 });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("opening the book", () => {
  it("shows the title, the contents and the first page", async () => {
    const f = fakes();
    mount(f);
    expect(await screen.findByRole("heading", { name: "Vectors" })).toBeTruthy();
    const toc = screen.getByRole("navigation", { name: "Table of contents" });
    expect(within(toc).getByText("Embeddings")).toBeTruthy();
    expect(within(toc).getByText("Stores")).toBeTruthy();
    expect(pageBox().value).toBe("1");
    await waitFor(() => {
      expect(f.rendered).toEqual([1]);
    });
    expect(f.opened).toEqual([`/api/book/pdf?doc=${DOC}`]);
    expect(document.title).toBe("Vectors · RAG Book");
  });

  it("asks for the book named in the address when the index holds several", async () => {
    const f = fakes();
    mount(f, DOC);
    await screen.findByRole("heading", { name: "Vectors" });
    expect(f.getBook).toHaveBeenCalledWith(DOC, expect.any(AbortSignal));
    expect(f.opened).toEqual([`/api/book/pdf?doc=${DOC}`]);
  });
});

describe("page navigation", () => {
  it("turns pages with the buttons, and stops at the ends", async () => {
    const f = fakes();
    mount(f);
    await screen.findByRole("heading", { name: "Vectors" });
    const previous = screen.getByRole("button", { name: "Previous page" });
    const next = screen.getByRole("button", { name: "Next page" });
    expect((previous as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(next);
    expect(pageBox().value).toBe("2");
    await waitFor(() => {
      expect(f.rendered).toContain(2);
    });
    fireEvent.click(previous);
    expect(pageBox().value).toBe("1");
  });

  it("goes to a typed page on Enter, and clamps one outside the book", async () => {
    const f = fakes();
    mount(f);
    await screen.findByRole("heading", { name: "Vectors" });
    fireEvent.change(pageBox(), { target: { value: "9" } });
    // typing alone does not move the reader: "1" on the way to "12" must not jump to page 1
    expect(f.rendered).not.toContain(9);
    fireEvent.submit(pageBox().closest("form") as HTMLFormElement);
    expect(pageBox().value).toBe("9");

    fireEvent.change(pageBox(), { target: { value: "400" } });
    fireEvent.submit(pageBox().closest("form") as HTMLFormElement);
    expect(pageBox().value).toBe("12");
  });

  it("puts the page back when what was typed is not a page", async () => {
    mount(fakes());
    await screen.findByRole("heading", { name: "Vectors" });
    fireEvent.change(pageBox(), { target: { value: "abc" } });
    fireEvent.blur(pageBox());
    expect(pageBox().value).toBe("1");
  });

  it("moves with the arrow keys and Home and End, but not while typing in the box", async () => {
    mount(fakes());
    await screen.findByRole("heading", { name: "Vectors" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(pageBox().value).toBe("3");
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(pageBox().value).toBe("2");
    fireEvent.keyDown(window, { key: "End" });
    expect(pageBox().value).toBe("12");
    fireEvent.keyDown(window, { key: "Home" });
    expect(pageBox().value).toBe("1");

    pageBox().focus();
    fireEvent.keyDown(pageBox(), { key: "ArrowRight" });
    expect(pageBox().value).toBe("1");
  });
});

describe("the table of contents", () => {
  it("goes to the page a heading starts on", async () => {
    const f = fakes();
    mount(f);
    await screen.findByRole("heading", { name: "Vectors" });
    fireEvent.click(screen.getByRole("button", { name: /Stores/ }));
    expect(pageBox().value).toBe("6");
    await waitFor(() => {
      expect(f.rendered).toContain(6);
    });
  });

  it("marks where the reader is, and opens the chapter they are in", async () => {
    mount(fakes());
    await screen.findByRole("heading", { name: "Vectors" });
    // page 1: in "Embeddings", whose subsection is not yet shown as current
    const chapter = screen.getByRole("button", { name: /^Embeddings/ });
    expect(chapter.getAttribute("aria-current")).toBe("location");
    expect(
      screen.getByRole("button", { name: "Collapse Embeddings" }).getAttribute("aria-expanded"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: /Similarity/ }));
    expect(pageBox().value).toBe("3");
    expect(screen.getByRole("button", { name: /^Similarity/ }).getAttribute("aria-current")).toBe(
      "location",
    );
    // the section name is also shown above the page
    expect(document.querySelector(".section-name")?.textContent).toBe("Similarity");
  });

  it("says so when the book has no headings", async () => {
    mount(fakes({ book: { ...BOOK, outline: [] } }));
    expect(await screen.findByText("No headings were found in this book.")).toBeTruthy();
  });
});

describe("remembering where the reader was", () => {
  it("saves the page, and opens there next time", async () => {
    const f = fakes();
    const first = mount(f);
    await screen.findByRole("heading", { name: "Vectors" });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(pageBox().value).toBe("3");
    first.unmount();

    // a new visit: no address, the same storage
    window.history.replaceState(null, "", "/");
    mount(f);
    await screen.findByRole("heading", { name: "Vectors" });
    expect(pageBox().value).toBe("3");
  });

  it("prefers the page named in the address", async () => {
    const f = fakes();
    f.storage.setItem(`rag-book:position:v1:${DOC}`, JSON.stringify({ page: 3 }));
    window.history.replaceState(null, "", "/#page=8");
    mount(f);
    await screen.findByRole("heading", { name: "Vectors" });
    expect(pageBox().value).toBe("8");
  });

  it("keeps the address in step with the page, so a reload lands there", async () => {
    mount(fakes());
    await screen.findByRole("heading", { name: "Vectors" });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(window.location.hash).toBe("#page=2");
  });

  it("follows the address when it is changed by hand", async () => {
    mount(fakes());
    await screen.findByRole("heading", { name: "Vectors" });
    window.location.hash = "#page=7";
    await waitFor(() => {
      expect(pageBox().value).toBe("7");
    });
  });

  it("works without storage", async () => {
    const f = fakes();
    render(<App client={f.client} openPdf={f.openPdf} storage={undefined} />);
    await screen.findByRole("heading", { name: "Vectors" });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(pageBox().value).toBe("2");
  });
});

describe("zoom", () => {
  it("zooms in and out, and goes back to fit-to-width", async () => {
    const f = fakes();
    mount(f);
    await screen.findByRole("heading", { name: "Vectors" });
    await screen.findByRole("button", { name: "Fit to width" });
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByRole("button", { name: "Fit to width" }).textContent).toBe("125%");
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByRole("button", { name: "Fit to width" }).textContent).toBe("75%");
    fireEvent.click(screen.getByRole("button", { name: "Fit to width" }));
    expect(screen.getByRole("button", { name: "Fit to width" }).textContent).toBe("100%");
  });
});

describe("when something is missing or fails", () => {
  it("shows the extracted text, with a note, when the book has no PDF", async () => {
    const f = fakes({ book: { ...BOOK, pdf: false } });
    mount(f);
    expect(await screen.findByText("Text of page 1.")).toBeTruthy();
    expect(screen.getByText(/PDF of this book was not found/)).toBeTruthy();
    expect(f.opened).toEqual([]);
    // no page image, so no zoom
    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Text of page 2.")).toBeTruthy();
  });

  it("falls back to the text, and says why, when the PDF will not open", async () => {
    mount(fakes({ openFails: true }));
    expect(await screen.findByText("Text of page 1.")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Missing PDF");
  });

  it("says what went wrong when the book cannot be loaded, and tries again", async () => {
    const f = fakes();
    f.getBook
      .mockRejectedValueOnce(
        new ApiError("Cannot reach the API. Start it with: pnpm api", "unreachable"),
      )
      .mockResolvedValue(BOOK);
    mount(f);
    expect((await screen.findByRole("alert")).textContent).toContain("pnpm api");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Vectors" })).toBeTruthy();
  });

  it("closes the PDF when the reader goes away", async () => {
    const f = fakes();
    const view = mount(f);
    await screen.findByRole("heading", { name: "Vectors" });
    await waitFor(() => {
      expect(f.opened).toHaveLength(1);
    });
    view.unmount();
    await waitFor(() => {
      expect(f.destroyed()).toBeGreaterThan(0);
    });
  });
});
