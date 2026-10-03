/**
 * `ui.addResult()` handles: a registered in-memory result plus a Download button that shows its state.
 *
 * Every button subscribes to the results service, and a subscription keeps the button, and through it the
 * result's Blob, alive. So each one unsubscribes as soon as its button leaves the page (checked on every change)
 * and all of them when the result is removed, whether or not it was downloaded.
 */
import type { CoreServices, SessionResult } from '../../core/types';
import { h } from '../dom';
import { presentError } from '../feedback/errors';
import { icon } from '../icon';
import type { ResultHandle } from './types';

export function resultHandle(
  core: Pick<CoreServices, 'results'>,
  result: SessionResult,
): ResultHandle {
  /** The buttons still listening: how to redraw each, and how to stop it listening. */
  const buttons = new Set<{ sync: () => void; dispose: () => void }>();
  let removed = false;

  const download = (): void => {
    if (removed) return;
    try {
      core.results.download(result.id);
    } catch (error) {
      void presentError(error);
    }
  };

  return {
    result,
    download,
    remove() {
      if (removed) return;
      removed = true;
      for (const entry of [...buttons]) {
        entry.sync(); // disabled from now on
        entry.dispose();
      }
      core.results.remove(result.id);
    },
    button(label = 'Download') {
      const text = h('span', null, label);
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
      const sync = (): void => {
        const done = result.downloaded;
        button.classList.toggle('btn-outline-primary', !done);
        button.classList.toggle('btn-outline-success', done);
        glyph.className = done ? 'bi bi-check2' : 'bi bi-download';
        text.textContent = done ? 'Downloaded' : label;
        button.disabled = removed;
        button.setAttribute(
          'aria-label',
          done ? `${result.name}, downloaded. Download again` : `Download ${result.name}`,
        );
      };
      sync();
      if (removed) return button;
      let seenOnPage = false;
      const off = core.results.subscribe(() => {
        if (button.isConnected) seenOnPage = true;
        else if (seenOnPage) {
          dispose();
          return;
        }
        sync();
      });
      const entry = {
        sync,
        dispose: (): void => {
          off();
          buttons.delete(entry);
        },
      };
      const dispose = entry.dispose;
      buttons.add(entry);
      return button;
    },
  };
}
