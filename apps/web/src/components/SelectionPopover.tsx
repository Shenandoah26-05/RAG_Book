import type { PageSelection } from "../selection/use-text-selection.js";

interface SelectionPopoverProps {
  readonly selection: PageSelection;
  readonly onAsk: () => void;
}

/** Room kept between the button and the edge of the window. */
const MARGIN = 8;
const BUTTON_WIDTH = 150;
const BUTTON_HEIGHT = 34;

/**
 * "Ask about this", beside the passage the reader has just selected: above it when there is room,
 * below it when the selection is at the top of the window, and kept inside the window sideways.
 * Where the browser cannot say where the selection is, it sits at the bottom of the window.
 *
 * Pressing it must not take the selection away from the page before the click is seen, so the press
 * itself is not allowed to move the focus.
 */
export function SelectionPopover({ selection, onAsk }: SelectionPopoverProps) {
  const { rect } = selection;
  const left =
    rect === undefined
      ? MARGIN
      : Math.min(
          Math.max(rect.left + rect.width / 2 - BUTTON_WIDTH / 2, MARGIN),
          window.innerWidth - BUTTON_WIDTH - MARGIN,
        );
  const top =
    rect === undefined
      ? window.innerHeight - BUTTON_HEIGHT - MARGIN
      : rect.top - BUTTON_HEIGHT - MARGIN >= MARGIN
        ? rect.top - BUTTON_HEIGHT - MARGIN
        : rect.top + rect.height + MARGIN;

  return (
    <button
      type="button"
      className="selection-popover"
      style={{ left: `${left.toString()}px`, top: `${top.toString()}px` }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={onAsk}
    >
      Ask about this
    </button>
  );
}
