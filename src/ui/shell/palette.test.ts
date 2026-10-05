import { describe, expect, it, vi } from 'vitest';
import type { CoreServices } from '../../core/types';
import { arrange, type PaletteItem, staticItems, togglePalette } from './palette';

describe('the palette dialog', () => {
  it('leaves Enter and the arrows to an input method that is composing (Japanese, Chinese, Korean)', async () => {
    const core = {
      ...fakeCore({ enabled: false, unlocked: true }).core,
      history: { query: () => Promise.resolve([]) },
      models: { list: () => Promise.resolve([]) },
    } as unknown as CoreServices;
    Element.prototype.scrollIntoView = () => undefined; // jsdom has none
    togglePalette(core);
    const input = document.querySelector<HTMLInputElement>('[data-testid="palette-input"]')!;
    const active = () => input.getAttribute('aria-activedescendant');
    const first = active();
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(active()).toBe(first);
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector('[data-testid="palette"]')?.classList.contains('show')).toBe(
      true,
    );
    togglePalette(core); // close
  });
});

function fakeCore(lock: { enabled: boolean; unlocked: boolean }) {
  const update = vi.fn();
  const lockNow = vi.fn();
  const core = {
    settings: { update } as unknown as CoreServices['settings'],
    keys: {
      lock: { enabled: () => lock.enabled, unlocked: () => lock.unlocked, lockNow },
    } as unknown as CoreServices['keys'],
  };
  return { core, update, lockNow };
}

describe('staticItems', () => {
  it('has every tool, page and settings section', () => {
    const items = staticItems(fakeCore({ enabled: false, unlocked: true }).core);
    expect(items.filter((item) => item.group === 'Tools')).toHaveLength(14);
    expect(items.find((item) => item.id === 'page:history')?.href).toBe('/or-toolbox/history/');
    expect(items.find((item) => item.id === 'settings:keys')?.href).toBe(
      '/or-toolbox/settings/#keys',
    );
    expect(items.find((item) => item.id === 'tool:ocr')?.href).toBe('/or-toolbox/tools/ocr/');
  });

  it('offers "Lock keys now" only while the lock is on and open', () => {
    const has = (lock: { enabled: boolean; unlocked: boolean }) =>
      staticItems(fakeCore(lock).core).some((item) => item.id === 'action:lock');
    expect(has({ enabled: false, unlocked: true })).toBe(false);
    expect(has({ enabled: true, unlocked: false })).toBe(false);
    expect(has({ enabled: true, unlocked: true })).toBe(true);
  });

  it('runs theme actions through the settings', () => {
    const { core, update } = fakeCore({ enabled: false, unlocked: true });
    staticItems(core)
      .find((item) => item.id === 'theme:dark')
      ?.action?.();
    expect(update).toHaveBeenCalledOnce();
    const draft = { appearance: { theme: 'light' } };
    (update.mock.calls[0]![0] as (d: typeof draft) => void)(draft);
    expect(draft.appearance.theme).toBe('dark');
  });
});

describe('arrange', () => {
  const items = staticItems(fakeCore({ enabled: false, unlocked: true }).core);

  it('keeps group order; with no query every tool and page is listed, other groups six at most', () => {
    const arranged = arrange(items, '');
    const groups = [...new Set(arranged.map((item) => item.group))];
    expect(groups).toEqual(['Tools', 'Pages', 'Settings', 'Actions']);
    const all = (group: string) => items.filter((item) => item.group === group).length;
    expect(arranged.filter((item) => item.group === 'Tools')).toHaveLength(all('Tools'));
    expect(arranged.filter((item) => item.group === 'Pages')).toHaveLength(all('Pages'));
    for (const id of ['tool:video-studio', 'tool:model-arena', 'page:diagnostics']) {
      expect(
        arranged.some((item) => item.id === id),
        id,
      ).toBe(true);
    }
    expect(arranged.filter((item) => item.group === 'Settings').length).toBeLessThanOrEqual(6);
    // While searching, six per group.
    expect(arrange(items, 'a').filter((item) => item.group === 'Tools').length).toBeLessThanOrEqual(
      6,
    );
  });

  it('ranks within a group', () => {
    const arranged = arrange(items, 'speech');
    expect(arranged[0]?.label).toBe('Speech-to-text');
    expect(arranged.slice(0, 2).map((item) => item.label)).toContain('Text-to-speech');
  });

  it('puts the group with the best match first when searching', () => {
    const arranged = arrange(items, 'models');
    expect(arranged[0]?.id).toBe('page:models');
    expect(arranged.some((item) => item.id === 'tool:model-arena')).toBe(true);
  });

  it('keeps recent runs newest first when there is no query', () => {
    const runs: PaletteItem[] = ['b', 'a', 'c'].map((title) => ({
      id: `run:${title}`,
      group: 'Recent runs',
      label: title,
      icon: 'clock',
    }));
    const arranged = arrange([...items, ...runs], '');
    expect(
      arranged.filter((item) => item.group === 'Recent runs').map((item) => item.label),
    ).toEqual(['b', 'a', 'c']);
  });

  it('returns nothing for a query nothing matches', () => {
    expect(arrange(items, 'qqqzzz')).toEqual([]);
  });
});
