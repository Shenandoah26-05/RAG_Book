import { useCallback, useEffect, useState } from "react";
import { clampPage, formatPageHash, parsePageHash, startPage } from "./location.js";
import { loadPosition, savePosition } from "./position.js";
import type { PositionStorage } from "./position.js";

export interface PageControls {
  readonly page: number;
  readonly pageCount: number;
  /** Goes to the nearest page that exists. */
  readonly goTo: (page: number) => void;
  readonly next: () => void;
  readonly previous: () => void;
}

/** A key press meant for a text field, not for the reader. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Which page of the book is open, and how it changes. The place is kept in three: React state (what
 * is drawn), the address (`#page=12`, so a reload, a bookmark or a pasted link lands there) and local
 * storage (so coming back tomorrow does too).
 *
 * Opening picks the page from the address, then from storage, then the first page. Afterwards the
 * state is the source: every change is written to the address and to storage. Editing the address by
 * hand moves the reader. ←, → move a page and Home, End jump to the ends, unless a text field has
 * the focus.
 */
export function usePage(options: {
  readonly docId: string;
  readonly pageCount: number;
  readonly storage: PositionStorage | undefined;
}): PageControls {
  const { docId, pageCount, storage } = options;
  const [page, setPage] = useState(() =>
    startPage({
      hash: window.location.hash,
      saved: loadPosition(storage, docId),
      pageCount,
    }),
  );

  const goTo = useCallback(
    (target: number) => {
      setPage(clampPage(target, pageCount));
    },
    [pageCount],
  );

  useEffect(() => {
    savePosition(storage, docId, page);
    const hash = formatPageHash(page);
    // replace, not push: turning pages should not fill the back button with one entry per page
    if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
  }, [page, docId, storage]);

  useEffect(() => {
    const onHashChange = (): void => {
      const fromAddress = parsePageHash(window.location.hash);
      if (fromAddress !== undefined && fromAddress >= 1 && fromAddress <= pageCount) {
        setPage(fromAddress);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [pageCount]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return;
      const moves: Record<string, (current: number) => number> = {
        ArrowLeft: (current) => current - 1,
        ArrowRight: (current) => current + 1,
        Home: () => 1,
        End: () => pageCount,
      };
      const move = moves[event.key];
      if (move === undefined) return;
      event.preventDefault();
      setPage((current) => clampPage(move(current), pageCount));
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [pageCount]);

  const next = useCallback(() => {
    setPage((current) => clampPage(current + 1, pageCount));
  }, [pageCount]);
  const previous = useCallback(() => {
    setPage((current) => clampPage(current - 1, pageCount));
  }, [pageCount]);

  return { page, pageCount, goTo, next, previous };
}
