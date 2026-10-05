import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../core/errors';
import type { CoreServices, KeyInfo, KeyStatus } from '../../core/types';
import { h, replace } from '../dom';
import { dataTable } from './data-table';
import { accountFreeDaily, balanceProblem, keyBalanceView } from './key-balance';
import { listSkeleton, loadInto } from './load-into';
import { setStarred, starButton } from './star-button';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('starButton', () => {
  it('toggles through onToggle and shows its state with aria-pressed, icon and tooltip', () => {
    const onToggle = vi.fn();
    const star = starButton({ pressed: false, label: 'Favorite: Chat', onToggle });
    expect(star.getAttribute('aria-label')).toBe('Favorite: Chat');
    expect(star.getAttribute('aria-pressed')).toBe('false');
    expect(star.title).toBe('Add to favorites');
    expect(star.querySelector('.bi-star')).not.toBeNull();
    star.click();
    expect(onToggle).toHaveBeenCalledTimes(1);

    setStarred(star, true);
    expect(star.getAttribute('aria-pressed')).toBe('true');
    expect(star.title).toBe('Remove from favorites');
    expect(star.querySelector('.bi-star-fill')).not.toBeNull();
    // The label does not change with the state: aria-pressed carries it.
    expect(star.getAttribute('aria-label')).toBe('Favorite: Chat');
  });

  it('takes its own tooltips, focus key and test id', () => {
    const star = starButton({
      pressed: true,
      label: 'Star: Run',
      titles: ['Star', 'Unstar'],
      focusKey: 'star-1',
      testId: 'run-star',
      onToggle: () => undefined,
    });
    expect(star.title).toBe('Unstar');
    expect(star.getAttribute('data-focus-key')).toBe('star-1');
    expect(star.dataset.testid).toBe('run-star');
    setStarred(star, false);
    expect(star.title).toBe('Star');
  });
});

describe('dataTable', () => {
  it('is a named, focusable, positioned scroll region with scoped headers', () => {
    const scroller = dataTable({
      scrollerLabel: 'Usage',
      caption: 'Usage by model',
      head: ['Model', 'Requests', 'Cost'],
      numericFrom: 1,
      testId: 'usage',
      rows: [['a/b', '3', '$1.00']],
    });
    expect(scroller.getAttribute('role')).toBe('region');
    expect(scroller.getAttribute('aria-label')).toBe('Usage');
    expect(scroller.tabIndex).toBe(0);
    expect(scroller.classList.contains('table-responsive')).toBe(true);
    expect(scroller.classList.contains('position-relative')).toBe(true);
    const table = scroller.querySelector('table')!;
    expect(table.dataset.testid).toBe('usage');
    expect(table.querySelector('caption')?.textContent).toBe('Usage by model');
    const heads = [...table.querySelectorAll('thead th')];
    expect(heads.map((th) => th.getAttribute('scope'))).toEqual(['col', 'col', 'col']);
    expect(heads.map((th) => th.classList.contains('text-end'))).toEqual([false, true, true]);
    const row = table.querySelector('tbody tr')!;
    expect([...row.children].map((cell) => cell.tagName)).toEqual(['TH', 'TD', 'TD']);
    expect(row.children[0]!.getAttribute('scope')).toBe('row');
    expect([...row.children].map((cell) => cell.classList.contains('text-end'))).toEqual([
      false,
      true,
      true,
    ]);
  });

  it('takes finished rows and bodies, and a foot', () => {
    const body = h('tbody', null, h('tr', null, h('td', null, 'x')));
    const foot = h('tfoot', null, h('tr', null, h('td', null, 'total')));
    const own = dataTable({ scrollerLabel: 'T', head: ['A'], body, foot });
    expect(own.querySelector('tbody')).toBe(body);
    expect(own.querySelector('tfoot')).toBe(foot);

    const tr = h('tr', { 'data-testid': 'mine' }, h('td', null, 'y'));
    const withRow = dataTable({ scrollerLabel: 'T', head: ['A'], rows: [tr], rowTestId: 'built' });
    expect(withRow.querySelector('[data-testid="mine"]')).toBe(tr);

    const built = dataTable({ scrollerLabel: 'T', head: ['A'], rows: [['z']], rowTestId: 'built' });
    expect(built.querySelector('tbody tr')?.getAttribute('data-testid')).toBe('built');
  });
});

describe('loadInto', () => {
  const error = { title: 'Could not load', testId: 'load-error' };

  it('shows the skeleton, then what load returns', async () => {
    const container = h('div');
    const done = loadInto(container, () => Promise.resolve(h('p', null, 'Loaded')), {
      skeleton: h('p', null, 'Skeleton'),
      error,
      retry: () => undefined,
    });
    expect(container.textContent).toBe('Skeleton');
    expect(await done).toBe(true);
    expect(container.textContent).toBe('Loaded');
  });

  it('leaves the container alone when load renders itself', async () => {
    const container = h('div');
    await loadInto(
      container,
      () => {
        replace(container, h('p', null, 'Mine'));
        return Promise.resolve();
      },
      { error, retry: () => undefined },
    );
    expect(container.textContent).toBe('Mine');
  });

  it('shows the error state with Try again, and the status text', async () => {
    const container = h('div');
    const retry = vi.fn();
    const status = vi.fn<(text: string) => void>();
    const ok = await loadInto(container, () => Promise.reject(new Error('boom')), {
      error,
      retry,
      status,
      messages: { loading: 'Loading…', failed: 'Failed.' },
    });
    expect(ok).toBe(false);
    expect(container.querySelector('[data-testid="load-error"]')).not.toBeNull();
    container.querySelector('button')!.click();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(status.mock.calls.map((call) => call[0])).toEqual(['Loading…', 'Failed.']);
  });

  it('drops an answer that a newer call has superseded', async () => {
    const container = h('div');
    let finishFirst: (value: HTMLElement) => void = () => undefined;
    const first = loadInto(
      container,
      () =>
        new Promise<HTMLElement>((resolve) => {
          finishFirst = resolve;
        }),
      { error, retry: () => undefined },
    );
    const second = loadInto(container, () => Promise.resolve(h('p', null, 'New')), {
      error,
      retry: () => undefined,
    });
    expect(await second).toBe(true);
    finishFirst(h('p', null, 'Old'));
    expect(await first).toBe(false);
    expect(container.textContent).toBe('New');
  });

  it('keeps content on screen when a live reload fails, if asked to', async () => {
    const container = h('div');
    const options = { error, retry: () => undefined, keepOnLiveFailure: true };
    await loadInto(container, () => Promise.resolve(h('p', null, 'Shown')), options);
    expect(await loadInto(container, () => Promise.reject(new Error('later')), options)).toBe(
      false,
    );
    expect(container.textContent).toBe('Shown');
    // A live reload shows no skeleton either.
    void loadInto(container, () => new Promise<void>(() => undefined), options);
    expect(container.textContent).toBe('Shown');
  });

  it('without keepOnLiveFailure (a load the user asked for), a failure shows the error state', async () => {
    const container = h('div');
    await loadInto(container, () => Promise.resolve(h('p', null, 'Shown')), {
      error,
      retry: () => undefined,
      keepOnLiveFailure: true,
    });
    expect(
      await loadInto(container, () => Promise.reject(new Error('search failed')), {
        error,
        retry: () => undefined,
      }),
    ).toBe(false);
    expect(container.querySelector('[data-testid="load-error"]')).not.toBeNull();
  });

  it('builds a hidden skeleton', () => {
    const skeleton = listSkeleton(3);
    expect(skeleton.getAttribute('aria-hidden')).toBe('true');
    expect(skeleton.children).toHaveLength(3);
  });
});

describe('keyBalanceView', () => {
  const key: KeyInfo = {
    id: 'k1',
    name: 'Work',
    colour: null,
    masked: 'sk-or-…1111',
    source: 'pasted',
    createdAt: 0,
    noRetention: false,
    isDefault: true,
  };
  const status = (patch: Partial<KeyStatus> = {}): KeyStatus => ({
    label: null,
    usageUsd: 5.5,
    usageMonthlyUsd: 1.25,
    limitUsd: 10,
    limitRemainingUsd: 4.5,
    limitReset: 'monthly',
    isFreeTier: false,
    freeDaily: { used: 12, limit: 50, remaining: 38 },
    fetchedAt: Date.now(),
    ...patch,
  });
  const fakeCore = (options: {
    unlocked?: boolean;
    status?: () => Promise<KeyStatus>;
  }): { core: CoreServices; load: ReturnType<typeof vi.fn> } => {
    const load = vi.fn(options.status ?? (() => Promise.resolve(status())));
    const core = {
      keys: {
        lock: { unlocked: () => options.unlocked ?? true },
        get: () => key,
        status: load,
      },
    } as unknown as CoreServices;
    return { core, load };
  };
  const text = (view: { element: HTMLElement }, testId: string): string | undefined =>
    view.element.querySelector(`[data-testid="${testId}"]`)?.textContent ?? undefined;

  it('checks the balance, showing the figures and the meter in the full view', async () => {
    const { core, load } = fakeCore({});
    const view = keyBalanceView(core, key);
    expect(view.element.textContent).toContain('Checking the balance');
    view.load();
    await vi.waitFor(() => expect(text(view, 'key-usage')).toBe('$1.25'));
    expect(text(view, 'key-remaining')).toBe('$4.50 left');
    expect(text(view, 'key-free-daily')).toBe('12 of 50 used');
    expect(view.element.querySelector('[role="progressbar"]')).not.toBeNull();
    // Loading again while a balance is on show asks the core (which caches) but keeps the figures.
    view.load();
    expect(text(view, 'key-usage')).toBe('$1.25');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('is one line when compact', async () => {
    const { core } = fakeCore({});
    const view = keyBalanceView(core, key, { compact: true });
    view.load();
    await vi.waitFor(() => expect(text(view, 'balance')).toBe('$4.50 left of $10.00'));
    expect(view.element.querySelector('[role="progressbar"]')).toBeNull();

    const unlimited = fakeCore({
      status: () => Promise.resolve(status({ limitUsd: null, limitRemainingUsd: null })),
    });
    const free = keyBalanceView(unlimited.core, key, { compact: true });
    free.load();
    await vi.waitFor(() => expect(text(free, 'balance')).toBe('$5.50 used · no limit'));
  });

  it('asks to unlock instead of loading while locked', () => {
    const { core, load } = fakeCore({ unlocked: false });
    const view = keyBalanceView(core, key);
    view.load();
    expect(load).not.toHaveBeenCalled();
    expect(text(view, 'key-unlock')).toBe('Unlock');
    const compact = keyBalanceView(core, key, { compact: true });
    expect(text(compact, 'balance-unlock')).toBe('Unlock to see');
  });

  it('says why a balance is unavailable: 401 means OpenRouter rejected the key', async () => {
    const rejected = fakeCore({
      status: () => Promise.reject(new ApiError('No auth', 401)),
    });
    const view = keyBalanceView(rejected.core, key);
    view.load();
    await vi.waitFor(() =>
      expect(text(view, 'key-balance-error')).toContain('OpenRouter rejected'),
    );
    const compact = keyBalanceView(rejected.core, key, { compact: true });
    compact.load();
    await vi.waitFor(() => expect(text(compact, 'balance-error')).toBe('Unavailable'));
    expect(
      compact.element.querySelector('[data-testid="balance-error"]')?.getAttribute('title'),
    ).toContain('OpenRouter rejected');
    expect(balanceProblem(new ApiError('Upstream broke', 500))).not.toContain('rejected');
  });

  it('loadMissing asks only while no balance is known, and repaints otherwise', async () => {
    const { core, load } = fakeCore({});
    const view = keyBalanceView(core, key);
    view.loadMissing();
    await vi.waitFor(() => expect(text(view, 'key-usage')).toBe('$1.25'));
    // Re-renders (a rename, a colour, the lock) call it again: nothing is asked.
    view.loadMissing();
    view.loadMissing();
    expect(load).toHaveBeenCalledOnce();
    expect(text(view, 'key-usage')).toBe('$1.25');

    // A failed balance is known too (Refresh asks again); only the lock leaves it missing.
    const rejected = fakeCore({ status: () => Promise.reject(new ApiError('No auth', 401)) });
    const failed = keyBalanceView(rejected.core, key);
    failed.loadMissing();
    await vi.waitFor(() => expect(text(failed, 'key-balance-error')).toBeDefined());
    failed.loadMissing();
    expect(rejected.load).toHaveBeenCalledOnce();
  });

  it('loads again after the lock got in the way', async () => {
    let unlocked = false;
    const load = vi.fn(() => Promise.resolve(status()));
    const core = {
      keys: { lock: { unlocked: () => unlocked }, get: () => key, status: load },
    } as unknown as CoreServices;
    const view = keyBalanceView(core, key);
    view.loadMissing();
    expect(load).not.toHaveBeenCalled();
    unlocked = true;
    view.loadMissing();
    await vi.waitFor(() => expect(text(view, 'key-usage')).toBe('$1.25'));
    expect(load).toHaveBeenCalledOnce();
  });

  it('keeps a good balance on show when a refresh fails, and says so', async () => {
    let fail = false;
    const { core, load } = fakeCore({
      status: () =>
        fail ? Promise.reject(new ApiError('Upstream broke', 502)) : Promise.resolve(status()),
    });
    const view = keyBalanceView(core, key);
    view.load();
    await vi.waitFor(() => expect(text(view, 'key-usage')).toBe('$1.25'));
    fail = true;
    view.load(true);
    await vi.waitFor(() => expect(text(view, 'key-balance-stale')).toContain('Could not refresh'));
    expect(text(view, 'key-usage')).toBe('$1.25');
    expect(text(view, 'key-balance-error')).toBeUndefined();
    expect(load).toHaveBeenLastCalledWith('k1', { force: true });
    // The next good answer clears the note.
    fail = false;
    view.load(true);
    await vi.waitFor(() => expect(text(view, 'key-usage')).toBe('$1.25'));
    expect(text(view, 'key-balance-stale')).toBeUndefined();
  });
});

describe('accountFreeDaily', () => {
  it('asks the default key only', async () => {
    const status = vi.fn(() =>
      Promise.resolve({ freeDaily: { used: 1, limit: 50, remaining: 49 } } as KeyStatus),
    );
    const core = {
      keys: {
        lock: { unlocked: () => true },
        resolve: () => ({ id: 'default' }),
        list: () => [{ id: 'other' }, { id: 'default' }, { id: 'third' }],
        status,
      },
    } as unknown as CoreServices;
    expect(await accountFreeDaily(core)).toEqual({ used: 1, limit: 50, remaining: 49 });
    expect(status).toHaveBeenCalledExactlyOnceWith('default');
  });

  it('is null when locked, without a key or when the default key cannot be read', async () => {
    const status = vi.fn(() => Promise.reject(new ApiError('No auth', 401)));
    const keys = { lock: { unlocked: () => true }, resolve: () => ({ id: 'default' }), status };
    expect(await accountFreeDaily({ keys } as unknown as CoreServices)).toBeNull();
    const locked = { ...keys, lock: { unlocked: () => false } };
    expect(await accountFreeDaily({ keys: locked } as unknown as CoreServices)).toBeNull();
    const none = { ...keys, resolve: () => null };
    expect(await accountFreeDaily({ keys: none } as unknown as CoreServices)).toBeNull();
    expect(status).toHaveBeenCalledOnce();
  });
});
