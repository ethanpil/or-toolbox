/**
 * Test doubles for the core contract, shared by the api, keys, oauth and models tests. Not imported by app code.
 * The real settings service and bus come from another module; these honour only the contract.
 */

import type {
  Bus,
  BusEvent,
  CoreServices,
  RunHandle,
  Settings,
  SettingsService,
  ToolId,
  Usage,
  UsageTotals,
} from '../types';

export function defaultSettings(): Settings {
  return {
    version: 1,
    onboarding: { completed: false },
    favouriteTools: [],
    defaultKeyId: null,
    defaultModels: {},
    freeOnly: false,
    tools: {},
    budgets: { mode: 'warn', perRunUsd: 0.1, monthlyUsd: null, perKeyMonthlyUsd: {} },
    appearance: { theme: 'system', accent: null, density: 'comfortable', reducedMotion: false },
    data: { retentionDays: 90, recordRecentPrompts: true },
    security: { autoLockMinutes: 15 },
    models: { favourites: [], recent: [] },
    ui: {},
  };
}

export function fakeSettings(initial: Partial<Settings> = {}): SettingsService {
  let current: Settings = { ...defaultSettings(), ...initial };
  const listeners = new Set<(next: Readonly<Settings>, prev: Readonly<Settings>) => void>();
  return {
    get: () => current,
    update(mutate) {
      const prev = current;
      const draft = structuredClone(current);
      mutate(draft);
      current = draft;
      for (const fn of listeners) fn(current, prev);
      return current;
    },
    reset() {
      current = defaultSettings();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    toolOptions: <T extends Record<string, unknown>>() => ({}) as T,
    setToolOptions() {},
  };
}

type Listener = (event: BusEvent) => void;

/**
 * Buses that deliver to their own listeners and to every other bus in the group, like the real
 * BroadcastChannel-backed bus does across tabs. `events` records what each bus emitted.
 */
export function linkedBuses(count: number): Array<Bus & { events: BusEvent[] }> {
  const groups: Array<Map<string, Set<Listener>>> = [];
  return Array.from({ length: count }, (_, index) => {
    const listeners = new Map<string, Set<Listener>>();
    groups[index] = listeners;
    const events: BusEvent[] = [];
    return {
      events,
      emit(event) {
        events.push(event);
        for (const group of groups) for (const fn of group.get(event.type) ?? []) fn(event);
      },
      on(type, fn) {
        const set = listeners.get(type) ?? new Set<Listener>();
        set.add(fn as Listener);
        listeners.set(type, set);
        return () => set.delete(fn as Listener);
      },
    };
  });
}

export function fakeBus(): Bus & { events: BusEvent[] } {
  const [bus] = linkedBuses(1);
  if (!bus) throw new Error('unreachable');
  return bus;
}

export interface FakeRun extends RunHandle {
  usages: Usage[];
  controller: AbortController;
}

export function fakeRun(
  tool: ToolId = 'chat',
  keyId = 'key-1',
  model = 'openai/gpt-6-luna',
): FakeRun {
  const controller = new AbortController();
  const usages: Usage[] = [];
  const totals: UsageTotals = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    latencyMsTotal: 0,
    costEstimated: false,
    byModel: {},
  };
  return {
    id: 'run-1',
    tool,
    model,
    keyId,
    signal: controller.signal,
    controller,
    usages,
    abort: (reason?: string) => controller.abort(reason),
    addUsage: (usage) => {
      usages.push(usage);
    },
    get totals() {
      return totals;
    },
    onUsage: () => () => undefined,
    checkpoint: () => Promise.resolve(),
    finish: () => Promise.reject(new Error('not used')),
    fail: () => Promise.reject(new Error('not used')),
  };
}

/** A partial core cast to the full contract, as the composition convention allows in tests. */
export function fakeCore(parts: Partial<CoreServices>): CoreServices {
  return parts as CoreServices;
}
