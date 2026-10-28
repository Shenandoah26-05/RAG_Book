import { MAX_HISTORY_TURNS, MAX_TURN_CHARS } from "@rag-book/api-contract";
import type { AskEvent, Turn, WireCitation, WireTrace } from "@rag-book/api-contract";

/** How one question is going. */
export type TurnStatus =
  /** The answer is arriving. */
  | "streaming"
  /** The answer is complete. */
  | "done"
  /** The reader stopped it; what had arrived is kept. */
  | "stopped"
  /** It failed; `error` says why. */
  | "failed";

/** A passage the reader selected on the page and asked about. */
export interface AskedPassage {
  readonly text: string;
  readonly page?: number;
}

/** One question and what has come back for it. */
export interface ChatTurn {
  /** Unique in the conversation; a citation chip is addressed by it. */
  readonly id: number;
  readonly question: string;
  /** The passage the reader selected when they asked, if they did. */
  readonly selection?: AskedPassage;
  /**
   * The part of the book the search was limited to, as the titles from the chapter down. Absent when
   * the whole book was searched. Kept so that a refusal can be asked again more widely.
   */
  readonly scope?: readonly string[];
  /** The answer so far: the `token` events joined. */
  readonly answer: string;
  readonly status: TurnStatus;
  /** The sources of the answer; `[n]` in the text is `citations[n - 1]`. Empty until they arrive. */
  readonly citations: readonly WireCitation[];
  /** Cited numbers that are not among the sources: the model cited something it was not given. */
  readonly unknownCitations: readonly number[];
  /** Why the book declined to answer, when it did (nothing found, or nothing good enough). */
  readonly refusal?: string;
  /** False when the stream was cut short, so the text may be partial. */
  readonly complete: boolean;
  readonly error?: string;
  readonly trace?: WireTrace;
}

export interface ChatState {
  readonly turns: readonly ChatTurn[];
}

export const initialChat: ChatState = { turns: [] };

export type ChatAction =
  | {
      readonly type: "ask";
      readonly id: number;
      readonly question: string;
      readonly selection?: AskedPassage;
      readonly scope?: readonly string[];
    }
  | { readonly type: "event"; readonly id: number; readonly event: AskEvent }
  | { readonly type: "failed"; readonly id: number; readonly message: string }
  | { readonly type: "stopped"; readonly id: number }
  | { readonly type: "remove"; readonly id: number }
  | { readonly type: "clear" };

function update(state: ChatState, id: number, change: (turn: ChatTurn) => ChatTurn): ChatState {
  return { turns: state.turns.map((turn) => (turn.id === id ? change(turn) : turn)) };
}

/** What an event of the stream does to the turn it belongs to. */
function applyEvent(turn: ChatTurn, event: AskEvent): ChatTurn {
  switch (event.event) {
    case "token":
      return { ...turn, answer: turn.answer + event.data.text };
    case "citations":
      return { ...turn, citations: event.data.citations };
    case "trace":
      return { ...turn, trace: event.data.trace };
    case "done": {
      const { answered, refusal, unknownCitations, complete } = event.data;
      return {
        ...turn,
        status: complete ? "done" : "stopped",
        complete,
        unknownCitations,
        ...(answered || refusal === undefined ? {} : { refusal }),
      };
    }
    case "error":
      return { ...turn, status: "failed", error: event.data.message };
  }
}

/**
 * The conversation as a function of what happens: a question is asked, events arrive, the reader
 * stops it, it fails, the conversation is cleared. Pure, so every order of events can be tested
 * without a screen or a server.
 *
 * Events that arrive for a turn that is no longer streaming are ignored (a late event after the
 * reader pressed Stop must not bring a stopped answer back to life).
 */
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "ask":
      return {
        turns: [
          ...state.turns,
          {
            id: action.id,
            question: action.question,
            ...(action.selection === undefined ? {} : { selection: action.selection }),
            ...(action.scope === undefined ? {} : { scope: action.scope }),
            answer: "",
            status: "streaming",
            citations: [],
            unknownCitations: [],
            complete: true,
          },
        ],
      };
    case "event":
      return update(state, action.id, (turn) =>
        turn.status === "streaming" ? applyEvent(turn, action.event) : turn,
      );
    case "failed":
      return update(state, action.id, (turn) =>
        turn.status === "streaming" ? { ...turn, status: "failed", error: action.message } : turn,
      );
    case "stopped":
      return update(state, action.id, (turn) =>
        turn.status === "streaming" ? { ...turn, status: "stopped", complete: false } : turn,
      );
    case "remove":
      return { turns: state.turns.filter((turn) => turn.id !== action.id) };
    case "clear":
      return initialChat;
  }
}

/**
 * The earlier turns to send with a new question, so a follow-up ("and the second one?") can be
 * understood: the last few that finished with an answer, oldest first, cut to the API's limits. The
 * server keeps no conversation; this is the whole of its memory.
 */
export function historyOf(turns: readonly ChatTurn[], limit = 6): readonly Turn[] {
  return turns
    .filter((turn) => turn.status === "done" && turn.refusal === undefined && turn.answer !== "")
    .slice(-Math.min(limit, MAX_HISTORY_TURNS))
    .map((turn) => ({
      question: turn.question.slice(0, MAX_TURN_CHARS),
      answer: turn.answer.slice(0, MAX_TURN_CHARS),
    }));
}
