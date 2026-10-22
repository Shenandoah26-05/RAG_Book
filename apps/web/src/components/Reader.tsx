import type { BookResponse } from "@rag-book/api-contract";
import { useMemo, useState } from "react";
import type { ApiClient } from "../api/client.js";
import type { OpenPdf } from "../pdf/types.js";
import { currentSectionTitle, indexOutline } from "../reader/outline.js";
import type { PositionStorage } from "../reader/position.js";
import { usePage } from "../reader/use-page.js";
import { usePdf } from "../reader/use-pdf.js";
import { PageNav } from "./PageNav.js";
import { PdfPage } from "./PdfPage.js";
import { TextPage } from "./TextPage.js";
import { Toc } from "./Toc.js";

interface ReaderProps {
  readonly book: BookResponse;
  readonly client: ApiClient;
  readonly openPdf: OpenPdf;
  readonly storage: PositionStorage | undefined;
}

/**
 * The open book: the table of contents on the left, the page in the middle, the page controls
 * below. The page is the PDF drawn by pdf.js; when the PDF is missing or will not open, it is the
 * extracted text, with a note saying why.
 */
export function Reader({ book, client, openPdf, storage }: ReaderProps) {
  const controls = usePage({ docId: book.docId, pageCount: book.pageCount, storage });
  const outline = useMemo(() => indexOutline(book.outline), [book.outline]);
  const pdf = usePdf(book.pdf ? client.pdfUrl(book.docId) : undefined, openPdf);
  const [zoom, setZoom] = useState(1);

  const section = currentSectionTitle(outline, controls.page);
  const showingImage = pdf.status === "ready";

  return (
    <div className="reader">
      <header className="reader-header">
        <h1>{book.title}</h1>
        {section === undefined ? null : <p className="muted section-name">{section}</p>}
      </header>

      <aside className="reader-toc">
        <Toc outline={outline} page={controls.page} onGoTo={controls.goTo} />
      </aside>

      <main className="reader-page">
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
          <PdfPage book={pdf.book} page={controls.page} zoom={zoom} />
        ) : null}
        {pdf.status === "none" || pdf.status === "failed" ? (
          <TextPage client={client} docId={book.docId} page={controls.page} />
        ) : null}
      </main>

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
