import { useEffect, useState } from "react";
import type { ApiClient } from "../api/client.js";
import { centerInView } from "../highlight/scroll.js";
import { markPassage } from "../highlight/text-range.js";

interface TextPageProps {
  readonly client: ApiClient;
  readonly docId: string;
  readonly page: number;
  /** A passage to mark, as `[from, to)` in the text of the whole document (a citation's range). */
  readonly passage?: { readonly from: number; readonly to: number } | undefined;
}

type Loaded =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly text: string; readonly start: number }
  | { readonly status: "failed"; readonly message: string };

/**
 * A page as the text the pipeline extracted from it. It is what the reader shows when the PDF is
 * not available (or will not open): less faithful than the page image, but it is the same text the
 * answers are built from, so a cited passage can be marked in it exactly, with no positions needed.
 */
export function TextPage({ client, docId, page, passage }: TextPageProps) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setLoaded({ status: "loading" });
    client.getPage(page, docId, controller.signal).then(
      (response) => {
        setLoaded({ status: "ready", text: response.text, start: response.span.start });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setLoaded({
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return () => {
      controller.abort();
    };
  }, [client, docId, page]);

  if (loaded.status === "failed") {
    return (
      <p role="alert" className="notice notice-error">
        Page {page} could not be loaded: {loaded.message}
      </p>
    );
  }

  const parts =
    loaded.status === "ready"
      ? passage === undefined
        ? { before: loaded.text, marked: "", after: "" }
        : markPassage(loaded.text, loaded.start, passage.from, passage.to)
      : undefined;

  return (
    <article
      className="text-page"
      aria-busy={loaded.status === "loading"}
      aria-label={`Page ${page.toString()}`}
    >
      {parts === undefined ? (
        <p className="muted">Loading…</p>
      ) : (
        <pre>
          {parts.before}
          {parts.marked === "" ? null : (
            <mark
              ref={(element) => {
                centerInView(element);
              }}
            >
              {parts.marked}
            </mark>
          )}
          {parts.after}
        </pre>
      )}
    </article>
  );
}
