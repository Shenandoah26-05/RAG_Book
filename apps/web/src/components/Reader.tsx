import type { BookResponse, WireCitation } from "@rag-book/api-contract";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "../api/client.js";
import { useChat } from "../chat/use-chat.js";
import { useHighlight } from "../highlight/use-highlight.js";
import type { OpenPdf } from "../pdf/types.js";
import { activeTrail, currentSectionTitle, indexOutline } from "../reader/outline.js";
import type { PositionStorage } from "../reader/position.js";
import { usePage } from "../reader/use-page.js";
import { usePdf } from "../reader/use-pdf.js";
import { useTextSelection } from "../selection/use-text-selection.js";
import { ChatPanel } from "./ChatPanel.js";
import type { ContextPassage } from "./ChatPanel.js";
import { SelectionPopover } from "./SelectionPopover.js";
import { PageNav } from "./PageNav.js";
import { PdfPage } from "./PdfPage.js";
import { SourceBar } from "./SourceBar.js";
import { TextPage } from "./TextPage.js";
import { Toc } from "./Toc.js";

interface ReaderProps {
  readonly book: BookResponse;
  readonly client: ApiClient;
  readonly openPdf: OpenPdf;
  readonly storage: PositionStorage | undefined;
}

/** The source chosen by clicking a citation: which answer it came from, and which source it is. */
interface Selected {
  readonly turnId: number;
  readonly citation: WireCitation;
}

/**
 * The open book: the table of contents on the left, the page in the middle, the chat on the right,
 * the page controls below. The page is the PDF drawn by pdf.js; when the PDF is missing or will not
 * open, it is the extracted text, with a note saying why.
 *
 * Following a citation is the one thing that joins the chat and the page: the reader goes to the
 * cited page and the passage is marked there, on the image when it can be placed and in the text
 * otherwise. The mark stays until another source is chosen, it is cleared, or Escape is pressed.
 */
export function Reader({ book, client, openPdf, storage }: ReaderProps) {
  const controls = usePage({ docId: book.docId, pageCount: book.pageCount, storage });
  const outline = useMemo(() => indexOutline(book.outline), [book.outline]);
  const pdf = usePdf(book.pdf ? client.pdfUrl(book.docId) : undefined, openPdf);
  const chat = useChat(client, book.docId);
  const [zoom, setZoom] = useState(1);
  const [selected, setSelected] = useState<Selected | undefined>(undefined);
  const highlight = useHighlight(selected?.citation, client, book.docId);

  // what the reader has selected on the page, the passage they have chosen to ask about, and where
  // the next question will look
  const pageArea = useRef<HTMLElement>(null);
  const onPage = useTextSelection(pageArea);
  const [context, setContext] = useState<ContextPassage | undefined>(undefined);
  const [focusToken, setFocusToken] = useState(0);
  const [scopeChoice, setScopeChoice] = useState<"chapter" | "book" | undefined>(undefined);

  const { goTo } = controls;
  const follow = useCallback(
    (turnId: number, citation: WireCitation) => {
      setSelected({ turnId, citation });
      goTo(citation.pageStart);
    },
    [goTo],
  );
  const clearSource = useCallback(() => {
    setSelected(undefined);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setSelected(undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // a new conversation has no sources to keep marked
  const cleared = chat.turns.length === 0;
  useEffect(() => {
    if (cleared) setSelected(undefined);
  }, [cleared]);

  const section = currentSectionTitle(outline, controls.page);
  // the chapter the reader is in (the outermost heading that holds the page), if the book has them
  const chapter = activeTrail(outline, controls.page)[0]?.entry.title;
  // Limited to the chapter when a passage is attached, because a passage points at where to look; the
  // whole book otherwise, because an open question may be about any of it. The reader can change it.
  const scopeMode: "chapter" | "book" =
    chapter === undefined ? "book" : (scopeChoice ?? (context === undefined ? "book" : "chapter"));

  const { selection: pageSelection, clear: clearPageSelection } = onPage;
  const askAboutSelection = useCallback(() => {
    if (pageSelection === undefined) return;
    setContext({
      text: pageSelection.text,
      page: controls.page,
      truncated: pageSelection.truncated,
    });
    clearPageSelection();
    setFocusToken((n) => n + 1);
  }, [pageSelection, clearPageSelection, controls.page]);

  const { send } = chat;
  const sendQuestion = useCallback(
    (question: string) => {
      send(question, {
        selection: context === undefined ? undefined : { text: context.text, page: context.page },
        scope: scopeMode === "chapter" && chapter !== undefined ? [chapter] : undefined,
      });
      // the passage belongs to this question; the next one starts without it
      setContext(undefined);
    },
    [send, context, scopeMode, chapter],
  );
  const showingImage = pdf.status === "ready";
  const boxes = highlight.status === "ready" ? highlight.pages.get(controls.page) : undefined;
  const passage =
    selected === undefined
      ? undefined
      : { from: selected.citation.charStart, to: selected.citation.charEnd };

  return (
    <div className="reader">
      <header className="reader-header">
        <h1>{book.title}</h1>
        {section === undefined ? null : <p className="muted section-name">{section}</p>}
      </header>

      <aside className="reader-toc">
        <Toc outline={outline} page={controls.page} onGoTo={controls.goTo} />
      </aside>

      <main className="reader-page" ref={pageArea}>
        {selected === undefined ? null : (
          <SourceBar
            citation={selected.citation}
            highlight={highlight}
            page={controls.page}
            onShow={() => {
              goTo(selected.citation.pageStart);
            }}
            onClear={clearSource}
          />
        )}
        {pdf.status === "none" ? (
          <p className="notice">
            The PDF of this book was not found, so this is the extracted text. Put the file in{" "}
            <code>data/raw</code> to see the pages as they are.
          </p>
        ) : null}
        {pdf.status === "failed" ? (
          <p role="alert" className="notice notice-error">
            The PDF could not be opened ({pdf.message}), so this is the extracted text.
          </p>
        ) : null}
        {pdf.status === "loading" ? <p className="muted">Opening the book…</p> : null}
        {pdf.status === "ready" ? (
          <PdfPage book={pdf.book} page={controls.page} zoom={zoom} boxes={boxes} />
        ) : null}
        {pdf.status === "none" || pdf.status === "failed" ? (
          <TextPage client={client} docId={book.docId} page={controls.page} passage={passage} />
        ) : null}
      </main>

      <aside className="reader-chat">
        <ChatPanel
          chat={chat}
          onCite={follow}
          onSend={sendQuestion}
          context={context}
          onClearContext={() => {
            setContext(undefined);
          }}
          scope={{ chapter, mode: scopeMode, onChange: setScopeChoice }}
          focusToken={focusToken}
          active={
            selected === undefined
              ? undefined
              : { turnId: selected.turnId, index: selected.citation.index }
          }
        />
      </aside>

      {pageSelection === undefined ? null : (
        <SelectionPopover selection={pageSelection} onAsk={askAboutSelection} />
      )}

      <footer className="reader-controls">
        <PageNav
          page={controls.page}
          pageCount={controls.pageCount}
          onGoTo={controls.goTo}
          onPrevious={controls.previous}
          onNext={controls.next}
          {...(showingImage ? { zoom: { value: zoom, onChange: setZoom } } : {})}
        />
      </footer>
    </div>
  );
}
