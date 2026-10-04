import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from '../dom';
import * as announcer from '../feedback/announce';
import { BUSY_REASON, retryGate } from './retry-gate';
import { createRunner } from './runner';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function setup() {
  let finish!: () => void;
  const runs: (string[] | undefined)[] = [];
  const runner = createRunner<string[]>(
    {
      run: (_signal, keys) => {
        runs.push(keys);
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    },
    true,
  );
  document.body.append(runner.element);
  return { runner, runs, finish: () => finish() };
}

describe('retryGate', () => {
  it('keeps bound buttons in step with the runner, focusable with the reason', async () => {
    const { runner, finish } = setup();
    const gate = retryGate(runner);
    const button = gate.bind(h('button', { type: 'button' }, 'Retry'));
    document.body.append(button);
    expect(button.getAttribute('aria-disabled')).toBe('false');

    const done = runner.trigger();
    expect(gate.blocked()).toBe(BUSY_REASON);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.classList.contains('disabled')).toBe(true);
    expect(button.title).toBe(BUSY_REASON);
    finish();
    await done;
    expect(button.getAttribute('aria-disabled')).toBe('false');

    runner.setDisabled('Add a file first');
    expect(button.title).toBe('Add a file first');
    expect(button.disabled).toBe(false); // still focusable
  });

  it('retries with the argument, and says why when it cannot start', async () => {
    const said = vi.spyOn(announcer, 'announce').mockImplementation(() => undefined);
    const { runner, runs, finish } = setup();
    const gate = retryGate(runner);
    expect(gate.retry(['page-2'])).toBe(true);
    expect(runs).toEqual([['page-2']]);
    expect(gate.retry(['page-3'])).toBe(false); // busy
    expect(said).toHaveBeenLastCalledWith(BUSY_REASON);
    finish();
    await vi.waitFor(() => expect(runner.busy).toBe(false));
    runner.setDisabled(null);
    expect(runs).toEqual([['page-2']]);
  });

  it('moves focus to the fallback when a focused Retry button disappears', async () => {
    const { runner } = setup();
    const heading = h('h2', { tabIndex: -1 }, 'Pages');
    document.body.append(heading);
    const gate = retryGate(runner, { fallback: () => heading });
    const list = h('div');
    const button = gate.bind(h('button', { type: 'button' }, 'Retry'));
    list.append(button);
    document.body.append(list);
    button.focus();
    list.replaceChildren(h('span', null, 'Reading…')); // the item re-rendered as running
    await vi.waitFor(() => expect(document.activeElement).toBe(heading));

    // Default fallback: the Run button.
    const other = retryGate(runner);
    const second = other.bind(h('button', { type: 'button' }, 'Retry'));
    list.replaceChildren(second);
    second.focus();
    second.remove();
    await vi.waitFor(() => expect(document.activeElement).toBe(runner.button));
  });

  it('leaves focus alone when something else took it', async () => {
    const { runner } = setup();
    const gate = retryGate(runner);
    const keep = h('button', { type: 'button' }, 'Elsewhere');
    const button = gate.bind(h('button', { type: 'button' }, 'Retry'));
    document.body.append(keep, button);
    button.focus();
    keep.focus();
    button.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(keep);
  });
});
