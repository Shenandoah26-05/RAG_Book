import { MAX_QUESTION_CHARS } from "@rag-book/api-contract";
import type { WireCitation } from "@rag-book/api-contract";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ChatTurn } from "../chat/chat-state.js";
import type { ChatControls } from "../chat/use-chat.js";
import { AnswerText } from "./AnswerText.js";
import { InspectorPanel } from "./InspectorPanel.js";

/** The source the reader is looking at: which answer, and which of its sources. */
export interface ActiveSource {
  readonly turnId: number;
  readonly index: number;
}

/** The passage the reader selected and is about to ask about. */
export interface ContextPassage {
  readonly text: string;
  readonly page: number;
  /** Only the start of what was selected is sent. */
  readonly truncated: boolean;
}

/** Where the next question will look. */
export interface ScopeControl {
  /** The chapter the reader is in, when the book has chapters and the page is in one. */
  readonly chapter: string | undefined;
  readonly mode: "chapter" | "book";
  readonly onChange: (mode: "chapter" | "book") => void;
}

interface ChatPanelProps {
  readonly chat: ChatControls;
  readonly onCite: (turnId: number, citation: WireCitation) => void;
  readonly active: ActiveSource | undefined;
  /** A question was typed or chosen; the reader sends it with the passage and the limits in force. */
  readonly onSend: (question: string) => void;
  readonly context: ContextPassage | undefined;
  readonly onClearContext: () => void;
  readonly scope: ScopeControl;
  /** Changes when the reader asks about a selection: the box takes the focus, ready to type. */
  readonly focusToken: number;
}

/** What most people want to know about a passage they have just selected. */
export const QUICK_QUESTIONS = [
  { label: "Explain", question: "Explain this passage in simple terms." },
  { label: "Summarize", question: "Summarize this passage in two sentences." },
] as const;

const pagesOf = (c: WireCitation): string =>
  c.pageStart === c.pageEnd
    ? `p. ${c.pageStart.toString()}`
    : `pp. ${c.pageStart.toString()}–${c.pageEnd.toString()}`;

/** The start of a passage, for a line that names it. */
const excerpt = (text: string, length = 140): string =>
  text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;

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
      {turn.selection === undefined ? null : (
        <p className="asked-about muted">
          About{" "}
          {turn.selection.page === undefined
            ? "a passage"
            : `page ${turn.selection.page.toString()}`}
          : “{excerpt(turn.selection.text)}”
        </p>
      )}
      {turn.scope === undefined ? null : (
        <p className="scope-note muted">Searched in {turn.scope.join(" › ")}</p>
      )}
      <div className="answer" aria-busy={turn.status === "streaming"}>
        {turn.answer === "" && turn.status === "streaming" ? (
          <p className="muted">Reading the book…</p>
        ) : (
          <AnswerText turn={turn} onCite={onCite} activeIndex={activeIndex} />
        )}
        {turn.status === "stopped" ? <p className="muted">Stopped.</p> : null}
        {turn.refusal === undefined ? null : (
          <p className="muted">
            The book had nothing good enough to answer this from
            {turn.scope === undefined ? "." : " in this chapter."}{" "}
            {turn.scope === undefined ? null : (
              <button
                type="button"
                disabled={chat.busy}
                onClick={() => {
                  chat.widen(turn.id);
                }}
              >
                Ask the whole book instead
              </button>
            )}
          </p>
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
        {turn.inspection === undefined ? null : (
          <InspectorPanel inspection={turn.inspection} trace={turn.trace} />
        )}
      </div>
    </li>
  );
}

/**
 * Asking the book. The answer is written as it arrives; its `[n]` marks become buttons once the
 * sources are known; a source can also be opened from the list under the answer. Enter sends,
 * Shift+Enter starts a new line.
 *
 * Above the box sit the two things that shape the next question, so the reader can see them before
 * they ask: the passage they selected on the page (with quick questions about it), and where the
 * search will look (this chapter, or the whole book).
 */
export function ChatPanel({
  chat,
  onCite,
  active,
  onSend,
  context,
  onClearContext,
  scope,
  focusToken,
}: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const transcript = useRef<HTMLOListElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  // follow the answer as it grows
  useEffect(() => {
    const element = transcript.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [chat.turns]);

  // the reader chose a passage to ask about: ready to type
  useEffect(() => {
    if (focusToken > 0) box.current?.focus();
  }, [focusToken]);

  const submit = (): void => {
    if (draft.trim() === "" || chat.busy) return;
    onSend(draft);
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
        <label
          className="inspect-toggle"
          title="Show the chunks, scores and prompt behind each new answer"
        >
          <input
            type="checkbox"
            checked={chat.inspect}
            onChange={(event) => {
              chat.setInspect(event.target.checked);
            }}
          />
          Inspect
        </label>
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
          the passage on its page. Select a passage on the page to ask about it.
        </p>
      ) : (
        <ol className="transcript" ref={transcript} role="log" aria-live="polite">
          {chat.turns.map((turn) => (
            <TurnView key={turn.id} turn={turn} chat={chat} onCite={onCite} active={active} />
          ))}
        </ol>
      )}

      {context === undefined ? null : (
        <div className="context-card" role="group" aria-label="Selected passage">
          <div className="context-head">
            <strong>Selected passage · page {context.page}</strong>
            <button type="button" onClick={onClearContext} aria-label="Remove the selected passage">
              ✕
            </button>
          </div>
          <blockquote>{excerpt(context.text, 220)}</blockquote>
          {context.truncated ? (
            <p className="muted">Only the start of the selection is sent.</p>
          ) : null}
          <div className="quick">
            {QUICK_QUESTIONS.map((quick) => (
              <button
                key={quick.label}
                type="button"
                disabled={chat.busy}
                onClick={() => {
                  onSend(quick.question);
                }}
              >
                {quick.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {scope.chapter === undefined ? null : (
        <div className="scope" role="group" aria-label="Where to search">
          <button
            type="button"
            aria-pressed={scope.mode === "chapter"}
            onClick={() => {
              scope.onChange("chapter");
            }}
          >
            This chapter
          </button>
          <button
            type="button"
            aria-pressed={scope.mode === "book"}
            onClick={() => {
              scope.onChange("book");
            }}
          >
            Whole book
          </button>
          <span className="muted scope-label">
            {scope.mode === "chapter" ? scope.chapter : "every chapter"}
          </span>
        </div>
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
            ref={box}
            value={draft}
            rows={2}
            maxLength={MAX_QUESTION_CHARS}
            placeholder={
              context === undefined ? "Ask about the book…" : "Ask about the selected passage…"
            }
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
