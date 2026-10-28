import type { PageView } from "../highlight/geometry.js";

/** Where a page is drawn: the picture, and the invisible text over it that makes it selectable. */
export interface PageSurface {
  readonly canvas: HTMLCanvasElement;
  /** Emptied and filled with the page's text each time the page is drawn. */
  readonly textLayer: HTMLElement;
}

/**
 * A PDF opened for reading, as the reader sees it. The components know only this, so they do not
 * import pdf.js (a large library, loaded when a book is opened) and a test can pass a fake.
 */
export interface PdfBook {
  readonly pageCount: number;
  /**
   * Draws page `page` (1-based) onto `surface` so that it is `cssWidth` CSS pixels wide, sharp on a
   * high-density screen, with its text laid over it so that it can be selected, and says how it was
   * drawn (`PageView`), which is what a highlight needs to find its place. Aborting `signal` stops the drawing and resolves with nothing: a page that is no
   * longer wanted is not an error.
   * @throws if the page cannot be drawn
   */
  render(
    page: number,
    surface: PageSurface,
    cssWidth: number,
    signal: AbortSignal,
  ): Promise<PageView | undefined>;
  /** Releases the document and its worker. */
  destroy(): Promise<void>;
}

/** Opens the PDF at `url`. Rejects if it cannot be loaded or is not a PDF. */
export type OpenPdf = (url: string) => Promise<PdfBook>;
