import type { WireCitation } from "@rag-book/api-contract";
import type { HighlightState } from "../highlight/use-highlight.js";

interface SourceBarProps {
  readonly citation: WireCitation;
  readonly highlight: HighlightState;
  /** The page being shown, to say whether the passage is on it. */
  readonly page: number;
  readonly onShow: () => void;
  readonly onClear: () => void;
}

/**
 * What the reader is looking at when they follow a citation: which source it is, where, and the
 * passage itself. The quote is shown here as well as marked on the page, so it can be read even when
 * the mark cannot be placed (a page with no recorded positions, a rotated page, a failed request), and
 * it says so when that is the case.
 */
export function SourceBar({ citation, highlight, page, onShow, onClear }: SourceBarProps) {
  const onPage = page >= citation.pageStart && page <= citation.pageEnd;
  const where =
    citation.pageStart === citation.pageEnd
      ? `page ${citation.pageStart.toString()}`
      : `pages ${citation.pageStart.toString()} to ${citation.pageEnd.toString()}`;

  return (
    <aside className="source-bar" aria-label="Selected source">
      <div className="source-bar-head">
        <strong>
          Source [{citation.index}] · {where}
        </strong>
        {onPage ? null : (
          <button type="button" onClick={onShow}>
            Go to the passage
          </button>
        )}
        <button type="button" onClick={onClear} aria-label="Clear the selected source">
          ✕
        </button>
      </div>
      <blockquote>{citation.quote}</blockquote>
      {highlight.status === "failed" ? (
        <p className="muted">The passage could not be marked on the page: {highlight.message}</p>
      ) : null}
    </aside>
  );
}
