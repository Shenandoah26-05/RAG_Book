import { useEffect, useState } from "react";
import type { ApiClient } from "../api/client.js";

interface TextPageProps {
  readonly client: ApiClient;
  readonly docId: string;
  readonly page: number;
}

type Loaded =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly text: string }
  | { readonly status: "failed"; readonly message: string };

/**
 * A page as the text the pipeline extracted from it. It is what the reader shows when the PDF is
 * not available (or will not open): less faithful than the page image, but it is the same text the
 * answers are built from, and it keeps the book readable.
 */
export function TextPage({ client, docId, page }: TextPageProps) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setLoaded({ status: "loading" });
    client.getPage(page, docId, controller.signal).then(
      (response) => {
        setLoaded({ status: "ready", text: response.text });
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
  return (
    <article
      className="text-page"
      aria-busy={loaded.status === "loading"}
      aria-label={`Page ${page.toString()}`}
    >
      {loaded.status === "ready" ? <pre>{loaded.text}</pre> : <p className="muted">Loading…</p>}
    </article>
  );
}
