/**
 * The sticky bars (the navbar at the top, the primary Run bar at the bottom) must never hide the control that has
 * focus (WCAG 2.4.11). Chromium ignores scroll padding when Tab moves focus, so tool pages check each focused
 * control against both bars and scroll it clear (src/ui/tool/index.ts).
 */

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Air left between a control and the bar that covered it. */
const AIR = 8;

/**
 * How far to scroll the window (`scrollBy({ top })`) so `control` is clear of `cover`, a bar stuck to the `edge`
 * of a window `viewport` pixels high: positive scrolls down (the control moves up from a bottom bar), negative
 * scrolls up (it moves down from under the navbar), 0 when the bar does not cover it. A control merely beside
 * the bar (the Run bar sits in the left column on wide screens) is not covered. The scroll never pushes the
 * control's other edge out of the window.
 */
export function uncoverBy(
  control: Box,
  cover: Box,
  edge: 'top' | 'bottom',
  viewport: number,
): number {
  const across = control.right > cover.left && control.left < cover.right;
  const down = control.bottom > cover.top && control.top < cover.bottom;
  if (!across || !down) return 0;
  if (edge === 'bottom') {
    return Math.min(control.bottom - cover.top + AIR, Math.max(0, control.top - AIR));
  }
  return -Math.min(cover.bottom - control.top + AIR, Math.max(0, viewport - control.bottom - AIR));
}
