import { useEffect, useState } from "react";
import type { SyntheticEvent } from "react";

interface PageNavProps {
  readonly page: number;
  readonly pageCount: number;
  readonly onGoTo: (page: number) => void;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  /** Zoom controls, shown only when there is a page image to zoom. */
  readonly zoom?: {
    readonly value: number;
    readonly onChange: (value: number) => void;
  };
}

export const ZOOM_STEP = 0.25;
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3;

/**
 * Previous and next, and a box to type a page number into. What is typed only counts when it is
 * sent (Enter, or leaving the box): "1" on the way to "12" must not jump to page 1.
 */
export function PageNav({ page, pageCount, onGoTo, onPrevious, onNext, zoom }: PageNavProps) {
  const [draft, setDraft] = useState(page.toString());
  // the box follows the page when it changes from elsewhere (a key, the contents, the address)
  useEffect(() => {
    setDraft(page.toString());
  }, [page]);

  const commit = (): void => {
    const typed = Number(draft);
    if (draft.trim() !== "" && Number.isInteger(typed)) onGoTo(typed);
    // a page that was not understood, or was clamped: show the page the reader is really on
    setDraft(page.toString());
  };

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    commit();
  };

  return (
    <div className="page-nav" role="group" aria-label="Page navigation">
      <button type="button" onClick={onPrevious} disabled={page <= 1} aria-label="Previous page">
        ‹
      </button>
      <form onSubmit={submit}>
        <label>
          <span className="visually-hidden">Page number</span>
          <input
            type="text"
            inputMode="numeric"
            value={draft}
            size={String(pageCount).length + 1}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onBlur={commit}
          />
        </label>
        <span className="muted"> of {pageCount}</span>
      </form>
      <button type="button" onClick={onNext} disabled={page >= pageCount} aria-label="Next page">
        ›
      </button>
      {zoom === undefined ? null : (
        <div className="zoom" role="group" aria-label="Zoom">
          <button
            type="button"
            aria-label="Zoom out"
            disabled={zoom.value <= MIN_ZOOM}
            onClick={() => {
              zoom.onChange(Math.max(MIN_ZOOM, zoom.value - ZOOM_STEP));
            }}
          >
            −
          </button>
          <button
            type="button"
            aria-label="Fit to width"
            onClick={() => {
              zoom.onChange(1);
            }}
          >
            {Math.round(zoom.value * 100)}%
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            disabled={zoom.value >= MAX_ZOOM}
            onClick={() => {
              zoom.onChange(Math.min(MAX_ZOOM, zoom.value + ZOOM_STEP));
            }}
          >
            +
          </button>
        </div>
      )}
    </div>
  );
}
