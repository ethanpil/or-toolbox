/**
 * `ui.addResult()` handles: a registered in-memory result plus a Download button that shows its state.
 *
 * The button is one element per result, made on first use: a tool that redraws its card puts the same button
 * into the new markup, so redraws never add a subscription to the results service. Its one subscription ends
 * when the result is removed (the service holds the result's Blob until then anyway).
 */
import type { CoreServices, SessionResult } from '../../core/types';
import { h } from '../dom';
import { presentError } from '../feedback/errors';
import { icon } from '../icon';
import type { ResultHandle } from './types';

/** Focus fell to the page (its element was removed, or nothing has it). */
function focusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

export function resultHandle(
  core: Pick<CoreServices, 'results'>,
  result: SessionResult,
): ResultHandle {
  let removed = false;
  /** The Download button once asked for: its current label, how to redraw it, how to stop it listening. */
  let made: { button: HTMLButtonElement; label: string; sync: () => void; off: () => void } | null =
    null;

  const download = (): void => {
    if (removed) return;
    try {
      core.results.download(result.id);
    } catch (error) {
      void presentError(error);
    }
  };

  const makeButton = (label: string): NonNullable<typeof made> => {
    const text = h('span');
    const glyph = icon('download');
    const button = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm btn-outline-primary d-inline-flex align-items-center gap-1',
        'data-focus-key': `download:${result.id}`,
        'data-testid': 'result-download',
        onclick: download,
      },
      glyph,
      text,
    );
    const entry = {
      button,
      label,
      sync: (): void => {
        const done = result.downloaded;
        button.classList.toggle('btn-outline-primary', !done);
        button.classList.toggle('btn-outline-success', done);
        glyph.className = done ? 'bi bi-check2' : 'bi bi-download';
        text.textContent = done ? 'Downloaded' : entry.label;
        button.disabled = removed;
        button.setAttribute(
          'aria-label',
          done ? `${result.name}, downloaded. Download again` : `Download ${result.name}`,
        );
      },
      off: (): void => undefined,
    };
    if (!removed) entry.off = core.results.subscribe(entry.sync);
    return entry;
  };

  return {
    result,
    download,
    remove() {
      if (removed) return;
      removed = true;
      made?.off();
      made?.sync(); // disabled from now on
      core.results.remove(result.id);
    },
    button(label = 'Download') {
      made ??= makeButton(label);
      const { button } = made;
      // A redraw that takes the focused button into markup not yet on the page drops focus before `replace()`
      // can see it; once the redraw is done, give it back.
      if (document.activeElement === button) {
        queueMicrotask(() => {
          if (button.isConnected && focusLost()) button.focus();
        });
      }
      made.label = label;
      made.sync();
      return button;
    },
  };
}
