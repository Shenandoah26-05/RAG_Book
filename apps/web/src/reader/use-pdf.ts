import { useEffect, useState } from "react";
import type { OpenPdf, PdfBook } from "../pdf/types.js";

export type PdfState =
  /** The book has no PDF to draw (the API has none): the reader shows the extracted text. */
  | { readonly status: "none" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly book: PdfBook }
  | { readonly status: "failed"; readonly message: string };

/**
 * Opens the PDF at `url` (or none, when `url` is undefined) and closes it when the url changes or
 * the reader goes away. A PDF that fails to open is a state, not a crash: the reader falls back to
 * the text of the pages.
 */
export function usePdf(url: string | undefined, open: OpenPdf): PdfState {
  const [state, setState] = useState<PdfState>(
    url === undefined ? { status: "none" } : { status: "loading" },
  );

  useEffect(() => {
    if (url === undefined) {
      setState({ status: "none" });
      return;
    }
    setState({ status: "loading" });
    let cancelled = false;
    let opened: PdfBook | undefined;
    open(url).then(
      (book) => {
        if (cancelled) {
          void book.destroy();
          return;
        }
        opened = book;
        setState({ status: "ready", book });
      },
      (error: unknown) => {
        if (cancelled) return;
        setState({
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return () => {
      cancelled = true;
      if (opened !== undefined) void opened.destroy();
    };
  }, [url, open]);

  return state;
}
