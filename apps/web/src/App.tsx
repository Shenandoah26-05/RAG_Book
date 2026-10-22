import type { BookResponse } from "@rag-book/api-contract";
import { useEffect, useState } from "react";
import { ApiError } from "./api/client.js";
import type { ApiClient } from "./api/client.js";
import { Reader } from "./components/Reader.js";
import type { OpenPdf } from "./pdf/types.js";
import type { PositionStorage } from "./reader/position.js";

export interface AppProps {
  readonly client: ApiClient;
  readonly openPdf: OpenPdf;
  readonly storage: PositionStorage | undefined;
  /** Which book, when the index holds several (`?doc=<id>` in the address). */
  readonly doc?: string | undefined;
}

type Loaded =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly book: BookResponse }
  | { readonly status: "failed"; readonly message: string };

const describe = (error: unknown): string =>
  error instanceof ApiError || error instanceof Error ? error.message : String(error);

/** Loads the book from the API and opens the reader on it, or says what went wrong and offers a retry. */
export function App({ client, openPdf, storage, doc }: AppProps) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  // bumped by "Try again" so the effect runs once more
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoaded({ status: "loading" });
    client.getBook(doc, controller.signal).then(
      (book) => {
        document.title = `${book.title} · RAG Book`;
        setLoaded({ status: "ready", book });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setLoaded({ status: "failed", message: describe(error) });
      },
    );
    return () => {
      controller.abort();
    };
  }, [client, doc, attempt]);

  if (loaded.status === "loading") {
    return (
      <p className="centered muted" aria-busy="true">
        Opening the book…
      </p>
    );
  }
  if (loaded.status === "failed") {
    return (
      <div className="centered" role="alert">
        <h1>The book could not be opened</h1>
        <p>{loaded.message}</p>
        <button
          type="button"
          onClick={() => {
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  }
  return <Reader book={loaded.book} client={client} openPdf={openPdf} storage={storage} />;
}
