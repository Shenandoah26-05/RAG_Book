import type { PageView } from "../highlight/geometry.js";
import type { OpenPdf, PdfBook } from "./types.js";

/** Read through a function: TypeScript would otherwise believe the flag cannot change across an `await`. */
const stopped = (signal: AbortSignal): boolean => signal.aborted;

/**
 * Opens a PDF with pdf.js. The library and its worker are imported here, when the first book is
 * opened, so they are a separate download and the table of contents does not wait for them.
 *
 * pdf.js loads the file in ranges (the API answers `Range` requests), so the first page appears
 * before the whole file has arrived.
 */
export const openPdf: OpenPdf = async (url) => {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

  const loading = pdfjs.getDocument({ url, withCredentials: false });
  const document = await loading.promise;

  const book: PdfBook = {
    pageCount: document.numPages,

    async render(pageNumber, { canvas, textLayer }, cssWidth, signal) {
      if (stopped(signal)) return undefined;
      const page = await document.getPage(pageNumber);
      if (stopped(signal)) return undefined;

      // fit the page to the width asked for; draw at the screen's pixel density so text stays sharp
      const natural = page.getViewport({ scale: 1 });
      const scale = cssWidth / natural.width;
      const viewport = page.getViewport({ scale });
      // what a highlight needs to turn PDF points into pixels on this drawing
      const [x0 = 0, y0 = 0, , y1 = 0] = page.view;
      const view: PageView = {
        scale,
        originX: x0,
        originY: y0,
        heightPoints: y1 - y0,
        // a rotated page is drawn turned, while the positions of its text are not
        overlay: page.rotate % 360 === 0,
      };
      const density = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * density);
      canvas.height = Math.floor(viewport.height * density);
      canvas.style.width = `${Math.floor(viewport.width).toString()}px`;
      canvas.style.height = `${Math.floor(viewport.height).toString()}px`;

      const task = page.render({
        canvas,
        viewport,
        ...(density === 1 ? {} : { transform: [density, 0, 0, density, 0, 0] }),
      });
      // the text of the page, invisible, over the picture: it is what makes the page selectable. It is
      // placed by the same viewport as the picture, and pdf.js's own styles (see styles.css) size it
      // with these two numbers.
      textLayer.replaceChildren();
      textLayer.style.setProperty("--scale-factor", scale.toString());
      textLayer.style.setProperty("--total-scale-factor", scale.toString());
      textLayer.style.width = canvas.style.width;
      textLayer.style.height = canvas.style.height;
      const text = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent(),
        container: textLayer,
        viewport,
      });

      const stop = (): void => {
        task.cancel();
        text.cancel();
      };
      signal.addEventListener("abort", stop, { once: true });
      try {
        await task.promise;
        await text.render();
        return view;
      } catch (error) {
        // a drawing that was cancelled because the reader moved on is not a failure
        if (error instanceof pdfjs.RenderingCancelledException || stopped(signal)) return undefined;
        throw error;
      } finally {
        signal.removeEventListener("abort", stop);
        page.cleanup();
      }
    },

    async destroy() {
      await loading.destroy();
    },
  };
  return book;
};
