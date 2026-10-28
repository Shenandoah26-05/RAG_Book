import type { WireBox } from "@rag-book/api-contract";

/**
 * How a page was drawn, which is what a box in PDF points needs to become a rectangle on the screen.
 * The viewer knows it and the API does not.
 */
export interface PageView {
  /** CSS pixels per PDF point: the page was drawn this much larger than its size in points. */
  readonly scale: number;
  /** Where the page's lower-left corner is, in PDF points. Usually 0, 0. */
  readonly originX: number;
  readonly originY: number;
  /** The height of the page in PDF points. */
  readonly heightPoints: number;
  /**
   * Whether boxes can be laid over this drawing. A page that is rotated is drawn turned, while the
   * positions of its text are not, so a box would land in the wrong place: better none than wrong.
   */
  readonly overlay: boolean;
}

/** A rectangle in CSS pixels from the top-left corner of the drawn page. */
export interface CssRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A box as the API sends it (PDF points, measured up from the bottom-left corner) as a rectangle on
 * the drawn page (CSS pixels, measured down from the top-left). The vertical axis is flipped: the
 * top of the box is `heightPoints` less the top edge of the box in PDF space.
 */
export function toCssRect(box: WireBox, view: PageView): CssRect {
  const topEdge = box.y - view.originY + box.height;
  return {
    left: (box.x - view.originX) * view.scale,
    top: (view.heightPoints - topEdge) * view.scale,
    width: box.width * view.scale,
    height: box.height * view.scale,
  };
}
