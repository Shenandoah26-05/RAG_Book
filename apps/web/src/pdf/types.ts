import type { PageView } from "../highlight/geometry.js";

/**
 * A PDF opened for reading, as the reader sees it. The components know only this, so they do not
 * import pdf.js (a large library, loaded when a book is opened) and a test can pass a fake.
 */
export interface PdfBook {
  readonly pageCount: number;
  /**
   * Draws page `page` (1-based) into `canvas` so that it is `cssWidth` CSS pixels wide, sharp on a
   * high-density screen, and says how it was drawn (`PageView`), which is what a highlight needs to
   * find its place. Aborting `signal` stops the drawing and resolves with nothing: a page that is no
   * longer wanted is not an error.
   * @throws if the page cannot be drawn
   */
  render(
    page: number,
    canvas: HTMLCanvasElement,
    cssWidth: number,
    signal: AbortSignal,
  ): Promise<PageView | undefined>;
  /** Releases the document and its worker. */
  destroy(): Promise<void>;
}

/** Opens the PDF at `url`. Rejects if it cannot be loaded or is not a PDF. */
export type OpenPdf = (url: string) => Promise<PdfBook>;
