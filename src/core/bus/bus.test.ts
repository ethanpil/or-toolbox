import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus } from '.';
import { LS_KEYS } from '../storage/local';
import { FakeBroadcastChannel } from '../testing/state-fakes';

beforeEach(() => {
  FakeBroadcastChannel.reset();
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bus with BroadcastChannel', () => {
  beforeEach(() => vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel));

  it('delivers to local listeners synchronously, by type', () => {
    const bus = createBus();
    const history = vi.fn();
    const stats = vi.fn();
    bus.on('history-changed', history);
    bus.on('stats-changed', stats);

    bus.emit({ type: 'history-changed', ids: ['a'] });

    expect(history).toHaveBeenCalledWith({ type: 'history-changed', ids: ['a'] });
    expect(stats).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe', () => {
    const bus = createBus();
    const fn = vi.fn();
    const off = bus.on('data-reset', fn);
    off();
    bus.emit({ type: 'data-reset' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('delivers to other tabs once, and not back to the sender twice', async () => {
    const tabA = createBus();
    const tabB = createBus();
    const inA = vi.fn();
    const inB = vi.fn();
    tabA.on('jobs-changed', inA);
    tabB.on('jobs-changed', inB);

    tabA.emit({ type: 'jobs-changed', id: 'j1' });
    await Promise.resolve();

    expect(inA).toHaveBeenCalledTimes(1);
    expect(inB).toHaveBeenCalledExactlyOnceWith({ type: 'jobs-changed', id: 'j1' });
  });

  it('ignores foreign messages on the channel', async () => {
    const bus = createBus();
    const fn = vi.fn();
    bus.on('settings-changed', fn);
    const stranger = new FakeBroadcastChannel('ortoolbox');
    stranger.postMessage({ type: 'not-an-event' });
    stranger.postMessage('hello');
    await Promise.resolve();
    expect(fn).not.toHaveBeenCalled();
  });

  it('keeps going when a listener throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bus = createBus();
    const after = vi.fn();
    bus.on('keys-changed', () => {
      throw new Error('boom');
    });
    bus.on('keys-changed', after);
    expect(() => bus.emit({ type: 'keys-changed' })).not.toThrow();
    expect(after).toHaveBeenCalled();
  });

  it('never throws when posting fails', () => {
    class Closed extends FakeBroadcastChannel {
      override postMessage(): void {
        throw new DOMException('closed', 'InvalidStateError');
      }
    }
    vi.stubGlobal('BroadcastChannel', Closed);
    const bus = createBus();
    const fn = vi.fn();
    bus.on('models-refreshed', fn);
    expect(() => bus.emit({ type: 'models-refreshed' })).not.toThrow();
    expect(fn).toHaveBeenCalled();
  });

  it('works locally when the BroadcastChannel constructor throws', () => {
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        constructor() {
          throw new Error('blocked');
        }
      },
    );
    const bus = createBus();
    const fn = vi.fn();
    bus.on('stats-changed', fn);
    bus.emit({ type: 'stats-changed' });
    expect(fn).toHaveBeenCalled();
  });
});

describe('bus without BroadcastChannel (storage-event fallback)', () => {
  beforeEach(() => vi.stubGlobal('BroadcastChannel', undefined));

  it('writes the event to localStorage for other tabs and removes it again', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const bus = createBus();
    bus.emit({ type: 'prompts-changed', tool: 'chat' });

    const [key, value] = setItem.mock.calls.find(([k]) => k === LS_KEYS.bus) ?? [];
    expect(key).toBe(LS_KEYS.bus);
    expect(JSON.parse(value ?? '{}')).toMatchObject({
      event: { type: 'prompts-changed', tool: 'chat' },
    });
    expect(localStorage.getItem(LS_KEYS.bus)).toBeNull();
  });

  it('uses a fresh nonce so identical events still change the value', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const bus = createBus();
    bus.emit({ type: 'stats-changed' });
    bus.emit({ type: 'stats-changed' });
    const values = setItem.mock.calls.filter(([k]) => k === LS_KEYS.bus).map(([, v]) => v);
    expect(values).toHaveLength(2);
    expect(values[0]).not.toBe(values[1]);
  });

  it('delivers events that another tab wrote', () => {
    const bus = createBus();
    const fn = vi.fn();
    bus.on('run-finished', fn);
    const event = { type: 'run-finished', id: 'r1', tool: 'chat', status: 'ok' };
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: LS_KEYS.bus,
        newValue: JSON.stringify({ event, nonce: 'x' }),
      }),
    );
    window.dispatchEvent(new StorageEvent('storage', { key: LS_KEYS.bus, newValue: null }));
    window.dispatchEvent(new StorageEvent('storage', { key: LS_KEYS.bus, newValue: '{bad' }));
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'other', newValue: JSON.stringify({ event }) }),
    );
    expect(fn).toHaveBeenCalledExactlyOnceWith(event);
  });

  it('never throws when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const bus = createBus();
    const fn = vi.fn();
    bus.on('data-reset', fn);
    expect(() => bus.emit({ type: 'data-reset' })).not.toThrow();
    expect(fn).toHaveBeenCalled();
  });
});
