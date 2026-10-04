/**
 * The tool's status line (output header). `status(text)` is for state changes and is announced; `progress(text)`
 * is for ticking counters ("Composing… 12 s", "18 of 75 parts", "40%"): it updates the visible text and is
 * announced at most once every `PROGRESS_ANNOUNCE_MS`, so a screen reader hears that work goes on without hearing
 * every tick. The line itself is not a live region; announcements go through `announce()`.
 */
import { h } from '../dom';
import { announce } from '../feedback/announce';

/** Least time between two announcements caused by progress updates (a status always announces). */
export const PROGRESS_ANNOUNCE_MS = 10_000;

export interface StatusLine {
  readonly element: HTMLElement;
  status(text: string): void;
  progress(text: string): void;
}

export function createStatusLine(now: () => number = () => Date.now()): StatusLine {
  const element = h('span', {
    class: 'small text-body-secondary ms-auto text-truncate',
    'data-testid': 'tool-status',
  });
  let lastAnnounced = -Infinity;
  const say = (text: string): void => {
    announce(text);
    lastAnnounced = now();
  };
  return {
    element,
    status(text) {
      element.textContent = text;
      if (text) say(text);
    },
    progress(text) {
      element.textContent = text;
      if (text && now() - lastAnnounced >= PROGRESS_ANNOUNCE_MS) say(text);
    },
  };
}
