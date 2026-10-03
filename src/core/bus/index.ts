/**
 * Cross-tab event bus. `BroadcastChannel('ortoolbox')` when the browser has it, otherwise a `storage`-event
 * fallback: the event is written to localStorage `LS_KEYS.bus` with a nonce (so repeated events still change
 * the value and fire in other tabs). `emit` also delivers synchronously to listeners in this tab. Nothing
 * here throws: a missing or broken channel only means other tabs are not told.
 */

import type { Bus, BusEvent } from '../types';
import { LS_KEYS, local, removeItem } from '../storage/local';

const CHANNEL_NAME = 'ortoolbox';

const EVENT_TYPES = new Set<BusEvent['type']>([
  'settings-changed',
  'keys-changed',
  'history-changed',
  'prompts-changed',
  'jobs-changed',
  'run-finished',
  'stats-changed',
  'models-refreshed',
  'data-reset',
]);

function isBusEvent(value: unknown): value is BusEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    EVENT_TYPES.has((value as { type?: unknown }).type as BusEvent['type'])
  );
}

type Listener = (event: BusEvent) => void;

export function createBus(): Bus {
  const listeners = new Map<BusEvent['type'], Set<Listener>>();

  const deliver = (event: BusEvent): void => {
    for (const fn of [...(listeners.get(event.type) ?? [])]) {
      try {
        fn(event);
      } catch (error) {
        // One broken listener must not stop the others (or the emitter).
        console.error(error);
      }
    }
  };

  let channel: BroadcastChannel | null = null;
  try {
    if (typeof BroadcastChannel === 'function') {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = (message: MessageEvent<unknown>) => {
        if (isBusEvent(message.data)) deliver(message.data);
      };
    }
  } catch {
    channel = null;
  }

  if (!channel && typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key !== LS_KEYS.bus || !event.newValue) return;
      try {
        const parsed = JSON.parse(event.newValue) as { event?: unknown };
        if (isBusEvent(parsed.event)) deliver(parsed.event);
      } catch {
        // Not ours, or corrupt: ignore.
      }
    });
  }

  const broadcast = (event: BusEvent): void => {
    try {
      if (channel) {
        channel.postMessage(event);
        return;
      }
      const storage = local();
      if (!storage) return;
      storage.setItem(LS_KEYS.bus, JSON.stringify({ event, nonce: crypto.randomUUID() }));
      // Other tabs saw the change already; keep the key from lingering.
      removeItem(storage, LS_KEYS.bus);
    } catch {
      // Channel closed, quota exceeded, storage blocked: other tabs simply miss this event.
    }
  };

  return {
    emit(event) {
      deliver(event);
      broadcast(event);
    },
    on(type, fn) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      const listener = fn as Listener;
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
  };
}
