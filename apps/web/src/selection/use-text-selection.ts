import { useCallback, useEffect, useState } from "react";
import type { RefObject } from "react";
import { normalizeSelection } from "./normalize.js";
import type { SelectedPassage } from "./normalize.js";

/** Where the selection is on the screen, in the browser window's coordinates. */
export interface ScreenRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface PageSelection extends SelectedPassage {
  /** Where it is, to put a button beside it. Undefined where the browser cannot say (jsdom). */
  readonly rect: ScreenRect | undefined;
}

export interface TextSelection {
  readonly selection: PageSelection | undefined;
  /** Forgets the selection, and clears it on the page. */
  readonly clear: () => void;
}

/** What the browser has selected inside `area`, or undefined if nothing, or something elsewhere. */
function readSelection(area: HTMLElement): PageSelection | undefined {
  const browser = window.getSelection();
  if (browser === null || browser.isCollapsed || browser.rangeCount === 0) return undefined;
  const range = browser.getRangeAt(0);
  // a selection that starts on the page and runs into the chat is not a passage of the page
  if (!area.contains(range.startContainer) || !area.contains(range.endContainer)) return undefined;

  const passage = normalizeSelection(browser.toString());
  if (passage === undefined) return undefined;

  // `getBoundingClientRect` is not in every environment (jsdom has no layout)
  const box = (range as Partial<Range>).getBoundingClientRect?.();
  const rect =
    box === undefined || (box.width === 0 && box.height === 0)
      ? undefined
      : { left: box.left, top: box.top, width: box.width, height: box.height };
  return { ...passage, rect };
}

/**
 * The passage the reader has selected on the page, once they have finished selecting.
 *
 * It is read when the mouse or finger is released and when a key is (Shift+arrows extends a
 * selection), and not while it is still being dragged: a button that follows the drag would jump
 * about under the pointer. It goes away as soon as the selection does (a click elsewhere). Only a
 * selection that lies wholly inside `area` counts.
 */
export function useTextSelection(area: RefObject<HTMLElement | null>): TextSelection {
  const [selection, setSelection] = useState<PageSelection | undefined>(undefined);

  useEffect(() => {
    const check = (): void => {
      const element = area.current;
      setSelection(element === null ? undefined : readSelection(element));
    };
    // after the event: the browser settles the selection once the button is up
    const checkSoon = (): void => {
      setTimeout(check, 0);
    };
    const onSelectionChange = (): void => {
      const browser = window.getSelection();
      if (browser === null || browser.isCollapsed) setSelection(undefined);
    };
    document.addEventListener("pointerup", checkSoon);
    document.addEventListener("keyup", checkSoon);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("pointerup", checkSoon);
      document.removeEventListener("keyup", checkSoon);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [area]);

  const clear = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setSelection(undefined);
  }, []);

  return { selection, clear };
}
