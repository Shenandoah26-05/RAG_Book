import { MAX_QUESTION_CHARS } from "@rag-book/api-contract";
import type { WireCitation } from "@rag-book/api-contract";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ChatTurn } from "../chat/chat-state.js";
import type { ChatControls } from "../chat/use-chat.js";
import { AnswerText } from "./AnswerText.js";
import { FeedbackBar } from "./FeedbackBar.js";

/** The source the reader is looking at: which answer, and which of its sources. */
export interface ActiveSource {
  readonly turnId: number;
  readonly index: number;
}

interface ChatPanelProps {
  readonly chat: ChatControls;
  readonly onCite: (turnId: number, citation: WireCitation) => void;
  readonly active: ActiveSource | undefined;
}

const pagesOf = (c: WireCitation): string =>
  c.pageStart === c.pageEnd
    ? `p. ${c.pageStart.toString()}`
    : `pp. ${c.pageStart.toString()}–${c.pageEnd.toString()}`;

function Sources({
  turn,
  onCite,
  activeIndex,
}: {
  turn: ChatTurn;
  onCite: ChatPanelProps["onCite"];
  activeIndex: number | undefined;
}) {
  if (turn.citations.length === 0) return null;
  return (
    <details className="sources">
      <summary>Sources ({turn.citations.length})</summary>
      <ol>
        {turn.citations.map((citation) => (
          <li key={citation.index}>
            <button
              type="button"
              aria-pressed={activeIndex === citation.index}
              onClick={() => {
                onCite(turn.id, citation);
              }}
            >
              <span className="source-where">
                [{citation.index}] {pagesOf(citation)}
              </span>
              <span className="source-quote">{citation.quote}</span>
            </button>
          </li>
        ))}
      </ol>
    </details>
  );
}

function TurnView({
  turn,
  chat,
  onCite,
  active,
}: {
  turn: ChatTurn;
  chat: ChatControls;
  onCite: ChatPanelProps["onCite"];
  active: ActiveSource | undefined;
}) {
  const activeIndex = active?.turnId === turn.id ? active.index : undefined;
  return (
    <li className="turn">
      <p className="question">{turn.question}</p>
      <div className="answer" aria-busy={turn.status === "streaming"}>
        {turn.answer === "" && turn.status === "streaming" ? (
          <p className="muted">Reading the book…</p>
        ) : (
          <AnswerText turn={turn} onCite={onCite} activeIndex={activeIndex} />
        )}
        {turn.status === "stopped" ? <p className="muted">Stopped.</p> : null}
        {turn.refusal === undefined ? null : (
          <p className="muted">The book had nothing good enough to answer this from.</p>
        )}
        {turn.status === "done" && !turn.complete ? (
          <p className="muted">The answer may be incomplete.</p>
        ) : null}
        {turn.status === "failed" ? (
          <p role="alert" className="notice notice-error">
            {turn.error}{" "}
            <button
              type="button"
              onClick={() => {
                chat.retry(turn.id);
              }}
            >
              Try again
            </button>
          </p>
        ) : null}
        <Sources turn={turn} onCite={onCite} activeIndex={activeIndex} />
        {turn.status === "done" ? <FeedbackBar turn={turn} onRate={chat.rate} /> : null}
      </div>
    </li>
  );
}

/**
 * Asking the book. The answer is written as it arrives; its `[n]` marks become buttons once the
 * sources are known; a source can also be opened from the list under the answer. Enter sends,
 * Shift+Enter starts a new line.
 */
export function ChatPanel({ chat, onCite, active }: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const transcript = useRef<HTMLOListElement>(null);

  // follow the answer as it grows
  useEffect(() => {
    const element = transcript.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [chat.turns]);

  const submit = (): void => {
    if (draft.trim() === "" || chat.busy) return;
    chat.send(draft);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <section className="chat" aria-label="Ask the book">
      <header className="chat-header">
        <h2>Ask the book</h2>
        <button
          type="button"
          onClick={chat.clear}
          disabled={chat.turns.length === 0}
          aria-label="Start a new conversation"
        >
          New
        </button>
      </header>

      {chat.turns.length === 0 ? (
        <p className="muted chat-empty">
          Ask a question about the book. Answers cite their sources: click a numbered mark to see
          the passage on its page.
        </p>
      ) : (
        <ol className="transcript" ref={transcript} role="log" aria-live="polite">
          {chat.turns.map((turn) => (
            <TurnView key={turn.id} turn={turn} chat={chat} onCite={onCite} active={active} />
          ))}
        </ol>
      )}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label>
          <span className="visually-hidden">Your question</span>
          <textarea
            value={draft}
            rows={2}
            maxLength={MAX_QUESTION_CHARS}
            placeholder="Ask about the book…"
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onKeyDown={onKeyDown}
          />
        </label>
        {chat.busy ? (
          <button type="button" onClick={chat.stop}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={draft.trim() === ""}>
            Ask
          </button>
        )}
      </form>
    </section>
  );
}
