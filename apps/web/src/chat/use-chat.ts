import { useCallback, useEffect, useReducer, useRef } from "react";
import type { AskRequest } from "@rag-book/api-contract";
import type { ApiClient } from "../api/client.js";
import { chatReducer, historyOf, initialChat } from "./chat-state.js";
import type { AskedPassage, ChatTurn } from "./chat-state.js";

/** What a question may carry besides its words. */
export interface SendOptions {
  /** A passage the reader selected on the page, to ask about. */
  readonly selection?: AskedPassage | undefined;
  /**
   * Limits the search to one part of the book: the titles from the chapter down. Absent: the whole
   * book.
   */
  readonly scope?: readonly string[] | undefined;
}

export interface ChatControls {
  readonly turns: readonly ChatTurn[];
  /** An answer is arriving: a new question waits for it. */
  readonly busy: boolean;
  /** Asks a question. Ignored when it is blank or an answer is still arriving. */
  readonly send: (question: string, options?: SendOptions) => void;
  /** Stops the answer that is arriving; what has arrived stays. */
  readonly stop: () => void;
  /** Asks a failed question again, with the same passage and the same limits. */
  readonly retry: (id: number) => void;
  /** Asks a question again over the whole book, when a search limited to a chapter found nothing. */
  readonly widen: (id: number) => void;
  /** Starts a new conversation. */
  readonly clear: () => void;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The conversation with the book. A question goes to `POST /ask`, and the answer is read as it is
 * written: each event of the stream becomes an action on the conversation, so the screen shows the
 * answer growing, then its sources.
 *
 * One answer at a time. The earlier answers that finished are sent with each new question as its
 * history, because the server keeps none. Leaving the page, stopping, or clearing cancels the request,
 * which stops the model on the server too.
 *
 * @param docId limits the answer to this book, so a second book in the index cannot be cited
 */
export function useChat(client: ApiClient, docId: string | undefined): ChatControls {
  const [state, dispatch] = useReducer(chatReducer, initialChat);
  const nextId = useRef(1);
  const current = useRef<{ id: number; controller: AbortController } | undefined>(undefined);
  // the latest turns, for the history of a question asked from a callback
  const turnsRef = useRef(state.turns);
  turnsRef.current = state.turns;

  useEffect(
    () => () => {
      current.current?.controller.abort();
    },
    [],
  );

  const busy = state.turns.at(-1)?.status === "streaming";

  const send = useCallback(
    (raw: string, options: SendOptions = {}) => {
      const question = raw.trim();
      const { selection, scope } = options;
      if (question === "" || current.current !== undefined) return;

      const id = nextId.current++;
      const controller = new AbortController();
      current.current = { id, controller };
      const history = historyOf(turnsRef.current);
      const request: AskRequest = {
        question,
        ...(history.length === 0 ? {} : { history: [...history] }),
        ...(docId === undefined && scope === undefined
          ? {}
          : {
              filter: {
                ...(docId === undefined ? {} : { documents: [docId] }),
                ...(scope === undefined ? {} : { section: [...scope] }),
              },
            }),
        ...(selection === undefined ? {} : { selection }),
      };
      dispatch({
        type: "ask",
        id,
        question,
        ...(selection === undefined ? {} : { selection }),
        ...(scope === undefined ? {} : { scope }),
      });

      void (async () => {
        try {
          for await (const event of client.ask(request, controller.signal)) {
            dispatch({ type: "event", id, event });
          }
          // the stream closed without `done` or `error`: the answer was cut short
          dispatch({ type: "stopped", id });
        } catch (error) {
          if (!controller.signal.aborted)
            dispatch({ type: "failed", id, message: describe(error) });
        } finally {
          if (current.current?.id === id) current.current = undefined;
        }
      })();
    },
    [client, docId],
  );

  const stop = useCallback(() => {
    const running = current.current;
    if (running === undefined) return;
    running.controller.abort();
    current.current = undefined;
    dispatch({ type: "stopped", id: running.id });
  }, []);

  const clear = useCallback(() => {
    current.current?.controller.abort();
    current.current = undefined;
    dispatch({ type: "clear" });
  }, []);

  const retry = useCallback(
    (id: number) => {
      const turn = turnsRef.current.find((candidate) => candidate.id === id);
      if (turn === undefined || turn.status !== "failed") return;
      dispatch({ type: "remove", id });
      send(turn.question, {
        ...(turn.selection === undefined ? {} : { selection: turn.selection }),
        ...(turn.scope === undefined ? {} : { scope: turn.scope }),
      });
    },
    [send],
  );

  const widen = useCallback(
    (id: number) => {
      const turn = turnsRef.current.find((candidate) => candidate.id === id);
      if (turn === undefined) return;
      send(turn.question, turn.selection === undefined ? {} : { selection: turn.selection });
    },
    [send],
  );

  return { turns: state.turns, busy, send, stop, retry, widen, clear };
}
