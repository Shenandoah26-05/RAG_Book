import { useEffect, useRef, useState } from "react";
import type { PdfBook } from "../pdf/types.js";

interface PdfPageProps {
  readonly book: PdfBook;
  readonly page: number;
  /** 1 fits the page to the width of the reading area; 2 is twice that. */
  readonly zoom: number;
}

/** The width of an element, kept up to date as the window or the panels around it change. */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => {
      setWidth(element.clientWidth);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return width;
}

/**
 * One page of the PDF drawn on a canvas. Turning the page, zooming or resizing starts a new drawing
 * and cancels the one in progress, so a fast reader never waits behind pages they have left.
 */
export function PdfPage({ book, page, zoom }: PdfPageProps) {
  const area = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const available = useWidth(area);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  useEffect(() => {
    const target = canvas.current;
    // padding of the reading area is subtracted by the layout; the canvas gets the rest
    if (target === null || available === 0) return;
    const controller = new AbortController();
    setFailure(undefined);
    book
      .render(page, target, Math.floor(available * zoom), controller.signal)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setFailure(error instanceof Error ? error.message : String(error));
      });
    return () => {
      controller.abort();
    };
  }, [book, page, zoom, available]);

  return (
    <div ref={area} className="pdf-area">
      <canvas
        ref={canvas}
        className="pdf-canvas"
        role="img"
        aria-label={`Page ${page.toString()}`}
      />
      {failure === undefined ? null : (
        <p role="alert" className="notice notice-error">
          Page {page} could not be drawn: {failure}
        </p>
      )}
    </div>
  );
}
