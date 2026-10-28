import type { WireBox, WireCitation } from "@rag-book/api-contract";
import { useEffect, useState } from "react";
import type { ApiClient } from "../api/client.js";

export type HighlightState =
  /** No source is selected. */
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  /** The boxes of the passage, by page number. A page with no boxes is one with no recorded positions. */
  | { readonly status: "ready"; readonly pages: ReadonlyMap<number, readonly WireBox[]> }
  | { readonly status: "failed"; readonly message: string };

/**
 * Where the selected source is on its pages. A new selection cancels the request for the old one, so
 * a quick second click is never answered with the first one's boxes. A failure is a state, not a
 * crash: the reader still goes to the page and shows the quote, it just cannot mark the passage.
 */
export function useHighlight(
  citation: WireCitation | undefined,
  client: ApiClient,
  docId: string,
): HighlightState {
  const [state, setState] = useState<HighlightState>({ status: "idle" });

  useEffect(() => {
    if (citation === undefined) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    client.getHighlights(citation.charStart, citation.charEnd, docId, controller.signal).then(
      (response) => {
        setState({
          status: "ready",
          pages: new Map(response.pages.map((page) => [page.number, page.boxes])),
        });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return () => {
      controller.abort();
    };
  }, [citation, client, docId]);

  return state;
}
