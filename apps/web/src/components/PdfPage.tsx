import type { WireBox } from "@rag-book/api-contract";
import { useEffect, useRef, useState } from "react";
import { toCssRect } from "../highlight/geometry.js";
import { centerInView } from "../highlight/scroll.js";
import type { PageView } from "../highlight/geometry.js";
import type { PdfBook } from "../pdf/types.js";

interface PdfPageProps {
  readonly book: PdfBook;
  readonly page: number;
  /** 1 fits the page to the width of the reading area; 2 is twice that. */
  readonly zoom: number;
  /** The passage to mark on this page, in PDF points (see `toCssRect`). Absent: nothing is marked. */
  readonly boxes?: readonly WireBox[] | undefined;
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
 * One page of the PDF drawn on a canvas, with the passage of a chosen source marked over it. Turning
 * the page, zooming or resizing starts a new drawing and cancels the one in progress, so a fast
 * reader never waits behind pages they have left.
 *
 * The marks are `div`s laid over the canvas, placed from how the page was drawn (`PageView`) and where
 * the API says the passage is. Over them lies the page's text layer: invisible text, in the places the
 * words are, so that the reader can select a passage and ask about it. The first one is scrolled into view, because a passage far down a tall
 * page is otherwise off screen when the reader arrives.
 */
export function PdfPage({ book, page, zoom, boxes }: PdfPageProps) {
  const area = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLDivElement>(null);
  const available = useWidth(area);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  // how the page on the canvas was drawn; cleared when another drawing starts, so a mark is never
  // placed with the measurements of the previous page
  const [view, setView] = useState<PageView | undefined>(undefined);

  useEffect(() => {
    const target = canvas.current;
    const text = textLayer.current;
    if (target === null || text === null || available === 0) return;
    const controller = new AbortController();
    setFailure(undefined);
    setView(undefined);
    book
      .render(
        page,
        { canvas: target, textLayer: text },
        Math.floor(available * zoom),
        controller.signal,
      )
      .then((drawn) => {
        if (!controller.signal.aborted) setView(drawn);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setFailure(error instanceof Error ? error.message : String(error));
      });
    return () => {
      controller.abort();
    };
  }, [book, page, zoom, available]);

  const marks =
    view?.overlay === true && boxes !== undefined ? boxes.map((box) => toCssRect(box, view)) : [];

  useEffect(() => {
    centerInView(first.current);
  }, [view, boxes]);

  return (
    <div ref={area} className="pdf-area">
      <div className="pdf-sheet">
        <canvas
          ref={canvas}
          className="pdf-canvas"
          role="img"
          aria-label={`Page ${page.toString()}`}
        />
        {marks.map((rect, i) => (
          <div
            key={i}
            ref={i === 0 ? first : undefined}
            className="highlight-box"
            data-testid="highlight-box"
            style={{
              left: `${rect.left.toString()}px`,
              top: `${rect.top.toString()}px`,
              width: `${rect.width.toString()}px`,
              height: `${rect.height.toString()}px`,
            }}
          />
        ))}
        {/* the page's text, invisible, over the picture: what makes it selectable */}
        <div ref={textLayer} className="textLayer" data-testid="text-layer" />
      </div>
      {failure === undefined ? null : (
        <p role="alert" className="notice notice-error">
          Page {page} could not be drawn: {failure}
        </p>
      )}
    </div>
  );
}
