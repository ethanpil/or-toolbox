/**
 * Settings schema: shipped defaults, versioned migrations and a per-field validator that repairs corrupt or
 * partial data instead of throwing. Keep `appearance.theme` where it is: public/theme-init.js reads it from
 * the raw localStorage JSON before first paint.
 */

import { CAPABILITIES, TOOL_IDS, type Capability, type ToolId } from '../../tools/types';
import type { BudgetMode, Settings, ThemeMode, ToolBinding } from '../types';
import { isPlainObject, jsonCopy } from './merge';

export const SETTINGS_VERSION = 1;

export const RECENT_MODELS_CAP = 20;

export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
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

type Raw = Record<string, unknown>;

/**
 * Step `n` turns a version-`n` object into version `n + 1`. Version 0 means "no or unreadable version" and
 * is treated as the v1 shape (the validator repairs whatever does not fit).
 *
 * To add v2: bump SETTINGS_VERSION to 2 and add `1: (s) => ({ ...s, newField: … })`.
 */
const MIGRATIONS: Record<number, (settings: Raw) => Raw> = {
  0: (settings) => settings,
};

/** Runs every migration from the stored version up to SETTINGS_VERSION. */
export function migrateSettings(raw: unknown): Raw {
  let settings: Raw = isPlainObject(raw) ? { ...raw } : {};
  const stored = settings['version'];
  let version = typeof stored === 'number' && Number.isInteger(stored) && stored >= 0 ? stored : 0;
  while (version < SETTINGS_VERSION) {
    const step = MIGRATIONS[version];
    if (step) settings = step(settings);
    version++;
  }
  return settings;
}

const THEMES: readonly ThemeMode[] = ['light', 'dark', 'system'];
const BUDGET_MODES: readonly BudgetMode[] = ['disabled', 'warn', 'hard'];
const DENSITIES: readonly Settings['appearance']['density'][] = ['comfortable', 'compact'];

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;

const nonNegative = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;

const nonNegativeOrNull = (value: unknown, fallback: number | null): number | null =>
  value === null
    ? null
    : typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : fallback;

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const stringOrNull = (value: unknown, fallback: string | null): string | null =>
  value === null ? null : nonEmptyString(value) ? value : fallback;

const uniqueStrings = (value: unknown, cap = Infinity): string[] =>
  Array.isArray(value) ? [...new Set(value.filter(nonEmptyString))].slice(0, cap) : [];

const isToolId = (value: unknown): value is ToolId =>
  typeof value === 'string' && (TOOL_IDS as readonly string[]).includes(value);

const isCapability = (value: unknown): value is Capability =>
  typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value);

/** A JSON-safe plain object, or an empty one. */
const jsonObject = (value: unknown): Record<string, unknown> => {
  if (!isPlainObject(value)) return {};
  try {
    const copy = jsonCopy(value);
    return isPlainObject(copy) ? copy : {};
  } catch {
    return {}; // cycles or BigInt
  }
};

const section = (raw: Raw, key: string): Raw => {
  const value = raw[key];
  return isPlainObject(value) ? value : {};
};

function normalizeBinding(value: unknown): ToolBinding | null {
  if (!isPlainObject(value)) return null;
  const binding: ToolBinding = {};
  if (nonEmptyString(value['keyId'])) binding.keyId = value['keyId'];
  if (nonEmptyString(value['model'])) binding.model = value['model'];
  if (isPlainObject(value['options'])) binding.options = jsonObject(value['options']);
  return binding;
}

/**
 * Migrates and validates anything (parsed JSON, a mutated draft, an imported backup) into a complete,
 * valid `Settings`. Each field that is missing or wrong falls back to its shipped default; nothing throws.
 */
export function normalizeSettings(input: unknown): Settings {
  const raw = migrateSettings(input);
  const d = defaultSettings();

  const onboarding = section(raw, 'onboarding');
  const budgets = section(raw, 'budgets');
  const appearance = section(raw, 'appearance');
  const data = section(raw, 'data');
  const security = section(raw, 'security');
  const models = section(raw, 'models');

  const defaultModels: Settings['defaultModels'] = {};
  for (const [cap, model] of Object.entries(section(raw, 'defaultModels'))) {
    if (isCapability(cap) && nonEmptyString(model)) defaultModels[cap] = model;
  }

  const tools: Settings['tools'] = {};
  for (const [tool, value] of Object.entries(section(raw, 'tools'))) {
    const binding = isToolId(tool) ? normalizeBinding(value) : null;
    if (isToolId(tool) && binding) tools[tool] = binding;
  }

  const perKeyMonthlyUsd: Record<string, number | null> = {};
  for (const [keyId, limit] of Object.entries(section(budgets, 'perKeyMonthlyUsd'))) {
    if (limit === null || (typeof limit === 'number' && Number.isFinite(limit) && limit >= 0)) {
      perKeyMonthlyUsd[keyId] = limit;
    }
  }

  const accent = appearance['accent'];
  const retention = data['retentionDays'];
  const autoLock = security['autoLockMinutes'];

  return {
    version: SETTINGS_VERSION,
    onboarding: { completed: bool(onboarding['completed'], d.onboarding.completed) },
    favouriteTools: [
      ...new Set(Array.isArray(raw['favouriteTools']) ? raw['favouriteTools'] : []),
    ].filter(isToolId),
    defaultKeyId: stringOrNull(raw['defaultKeyId'], d.defaultKeyId),
    defaultModels,
    freeOnly: bool(raw['freeOnly'], d.freeOnly),
    tools,
    budgets: {
      mode: oneOf(budgets['mode'], BUDGET_MODES, d.budgets.mode),
      perRunUsd: nonNegative(budgets['perRunUsd'], d.budgets.perRunUsd),
      monthlyUsd: nonNegativeOrNull(budgets['monthlyUsd'], d.budgets.monthlyUsd),
      perKeyMonthlyUsd,
    },
    appearance: {
      theme: oneOf(appearance['theme'], THEMES, d.appearance.theme),
      accent:
        typeof accent === 'string' && /^#[0-9a-f]{6}$/i.test(accent)
          ? accent.toLowerCase()
          : d.appearance.accent,
      density: oneOf(appearance['density'], DENSITIES, d.appearance.density),
      reducedMotion: bool(appearance['reducedMotion'], d.appearance.reducedMotion),
    },
    data: {
      retentionDays:
        typeof retention === 'number' && Number.isFinite(retention) && retention >= 1
          ? Math.min(Math.round(retention), 36_500)
          : d.data.retentionDays,
      recordRecentPrompts: bool(data['recordRecentPrompts'], d.data.recordRecentPrompts),
    },
    security: {
      autoLockMinutes:
        typeof autoLock === 'number' && Number.isFinite(autoLock) && autoLock >= 0
          ? Math.round(autoLock)
          : d.security.autoLockMinutes,
    },
    models: {
      favourites: uniqueStrings(models['favourites']),
      recent: uniqueStrings(models['recent'], RECENT_MODELS_CAP),
    },
    ui: jsonObject(raw['ui']),
  };
}
