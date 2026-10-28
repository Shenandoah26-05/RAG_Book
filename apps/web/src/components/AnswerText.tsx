import type { WireCitation } from "@rag-book/api-contract";
import { splitAnswer } from "../chat/answer-text.js";
import type { ChatTurn } from "../chat/chat-state.js";

interface AnswerTextProps {
  readonly turn: ChatTurn;
  readonly onCite: (turnId: number, citation: WireCitation) => void;
  /** The source the reader is looking at, to mark its chip. */
  readonly activeIndex: number | undefined;
}

/** A passage as a short preview for a tooltip. */
const preview = (quote: string): string =>
  quote.length > 160 ? `${quote.slice(0, 157).trimEnd()}…` : quote;

/**
 * An answer with its `[n]` marks drawn as buttons. A chip jumps the reader to the source's page and
 * marks the passage there. Three cases are not chips, and are shown as written:
 * - while the answer is still arriving, the sources have not come yet (they follow the text);
 * - a number with no source behind it, which means the model cited something it was not given. It is
 *   marked, not hidden, because a reader should know that a claim has no source.
 */
export function AnswerText({ turn, onCite, activeIndex }: AnswerTextProps) {
  const sourcesPending = turn.status === "streaming" && turn.citations.length === 0;

  return (
    <p className="answer-text">
      {splitAnswer(turn.answer).map((segment, i) => {
        if (segment.kind === "text") return <span key={i}>{segment.text}</span>;
        return (
          <span key={i} className="cite-group">
            {segment.numbers.map((number, j) => {
              const citation = turn.citations[number - 1];
              if (citation === undefined) {
                return sourcesPending ? (
                  <span key={j} className="cite cite-pending">
                    [{number}]
                  </span>
                ) : (
                  <span
                    key={j}
                    className="cite cite-unknown"
                    title="The answer cites a source it was not given"
                  >
                    [{number}]
                  </span>
                );
              }
              const pages =
                citation.pageStart === citation.pageEnd
                  ? `page ${citation.pageStart.toString()}`
                  : `pages ${citation.pageStart.toString()} to ${citation.pageEnd.toString()}`;
              return (
                <button
                  key={j}
                  type="button"
                  className="cite"
                  aria-label={`Source ${number.toString()}, ${pages}`}
                  aria-pressed={activeIndex === citation.index}
                  title={preview(citation.quote)}
                  onClick={() => {
                    onCite(turn.id, citation);
                  }}
                >
                  {number}
                </button>
              );
            })}
          </span>
        );
      })}
    </p>
  );
}
