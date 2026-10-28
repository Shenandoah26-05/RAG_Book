import { MAX_FEEDBACK_NOTE_CHARS } from "@rag-book/api-contract";
import type { FeedbackRating } from "@rag-book/api-contract";
import { useState } from "react";
import type { ChatTurn } from "../chat/chat-state.js";

interface FeedbackBarProps {
  readonly turn: ChatTurn;
  readonly onRate: (id: number, rating: FeedbackRating, note?: string) => void;
}

/**
 * Thumbs up or down under a finished answer, and an optional note. The rating is sent as soon as it
 * is chosen, so it is not lost if the note never comes; adding a note sends the rating again with it,
 * and the API keeps the newest. The reader is told when it was saved, and when it could not be.
 */
export function FeedbackBar({ turn, onRate }: FeedbackBarProps) {
  const { feedback } = turn;
  const saving = feedback?.status === "saving";
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const noting = draft !== undefined;

  const rate = (rating: FeedbackRating): void => {
    onRate(turn.id, rating, feedback?.rating === rating ? feedback.note : undefined);
  };

  return (
    <div className="feedback" role="group" aria-label="Rate this answer">
      <button
        type="button"
        className="thumb"
        aria-label="Good answer"
        aria-pressed={feedback?.rating === "up"}
        disabled={saving}
        onClick={() => {
          rate("up");
        }}
      >
        👍
      </button>
      <button
        type="button"
        className="thumb"
        aria-label="Bad answer"
        aria-pressed={feedback?.rating === "down"}
        disabled={saving}
        onClick={() => {
          rate("down");
        }}
      >
        👎
      </button>

      {feedback === undefined ? null : (
        <span className="feedback-status" role="status">
          {feedback.status === "saving" ? "Saving…" : null}
          {feedback.status === "saved" ? "Saved. Thank you." : null}
        </span>
      )}

      {feedback?.status === "failed" ? (
        <span role="alert" className="feedback-error">
          Could not save your rating: {feedback.error}
        </span>
      ) : null}

      {feedback !== undefined && feedback.status !== "saving" && !noting ? (
        <button
          type="button"
          className="link"
          onClick={() => {
            setDraft(feedback.note ?? "");
          }}
        >
          {feedback.note === undefined ? "Add a note" : "Edit note"}
        </button>
      ) : null}

      {feedback !== undefined && noting ? (
        <form
          className="feedback-note"
          onSubmit={(event) => {
            event.preventDefault();
            onRate(turn.id, feedback.rating, draft);
            setDraft(undefined);
          }}
        >
          <label>
            <span className="visually-hidden">Note about this answer</span>
            <textarea
              value={draft}
              rows={2}
              maxLength={MAX_FEEDBACK_NOTE_CHARS}
              placeholder={
                feedback.rating === "down" ? "What was wrong?" : "Anything worth remembering?"
              }
              onChange={(event) => {
                setDraft(event.target.value);
              }}
            />
          </label>
          <button type="submit" disabled={saving}>
            Save note
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(undefined);
            }}
          >
            Cancel
          </button>
        </form>
      ) : null}
    </div>
  );
}
