/** What `centerInView` needs of an element. Stated as optional because not every environment has it. */
interface Scrollable {
  readonly scrollIntoView?: Element["scrollIntoView"];
}

/**
 * Scrolls an element to the middle of its scrolling area, gently, so a passage far down a page is not
 * off screen when the reader arrives. Does nothing where there is no scrolling to do (jsdom, which has
 * no layout and no `scrollIntoView`), so it is safe to call anywhere.
 */
export function centerInView(element: Scrollable | null): void {
  element?.scrollIntoView?.({ block: "center", behavior: "smooth" });
}
