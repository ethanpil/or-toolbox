/**
 * Settings schema: shipped defaults, versioned migrations and a per-field validator that repairs corrupt or
 * partial data instead of throwing. Keep `appearance.theme` where it is: public/theme-init.js reads it from
 * the raw localStorage JSON before first paint.
 */

import { CAPABILITIES, TOOL_IDS, type Capability, type ToolId } from '../../tools/types';
import type { BudgetMode, Settings, ThemeMode, ToolBinding } from '../types';
import { isFiniteNumber, isPlainObject, isUnsafeKey, stripUnsafeKeys } from '../util';
import { jsonCopy } from './merge';

export const SETTINGS_VERSION = 1;

export const RECENT_MODELS_CAP = 20;

/** Upper bounds for numeric settings; values outside a range are clamped into it. */
export const MAX_PER_RUN_USD = 1000;
export const MAX_MONTHLY_USD = 100_000;
export const MAX_RETENTION_DAYS = 3650;
export const MAX_AUTO_LOCK_MINUTES = 1440;

export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    onboarding: { completed: false },
    favoriteTools: [],
    defaultKeyId: null,
    defaultModels: {},
    freeOnly: false,
    tools: {},
    budgets: { mode: 'warn', perRunUsd: 0.1, monthlyUsd: null, perKeyMonthlyUsd: {} },
    appearance: { theme: 'system', accent: null, density: 'comfortable', reducedMotion: false },
    data: { retentionDays: 90, recordRecentPrompts: true },
    security: { autoLockMinutes: 15 },
    models: { favorites: [], recent: [] },
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

/** Runs every migration from the stored version up to SETTINGS_VERSION. Unsafe keys are dropped first. */
export function migrateSettings(raw: unknown): Raw {
  let settings: Raw = isPlainObject(raw) ? stripUnsafeKeys(raw) : {};
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

/** A finite number clamped into [min, max]; anything else is the fallback. */
const clamped = (value: unknown, min: number, max: number, fallback: number): number =>
  isFiniteNumber(value) ? Math.min(Math.max(value, min), max) : fallback;

const usdOrNull = (value: unknown, fallback: number | null): number | null =>
  value === null ? null : isFiniteNumber(value) ? clamped(value, 0, MAX_MONTHLY_USD, 0) : fallback;

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

/** A JSON-safe plain object without unsafe keys, or an empty one. */
const jsonObject = (value: unknown): Record<string, unknown> => {
  if (!isPlainObject(value)) return {};
  try {
    const copy = stripUnsafeKeys(jsonCopy(value));
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
 * valid `Settings`. Each field that is missing or wrong falls back to its shipped default, numbers are
 * clamped to sane ranges, and nothing throws.
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
    if (isUnsafeKey(keyId) || (limit !== null && !isFiniteNumber(limit))) continue;
    perKeyMonthlyUsd[keyId] = usdOrNull(limit, null);
  }

  const accent = appearance['accent'];
  // Settings written before the US spelling used `favouriteTools` and `models.favourites`.
  const favoriteTools = raw['favoriteTools'] ?? raw['favouriteTools'];

  return {
    version: SETTINGS_VERSION,
    onboarding: { completed: bool(onboarding['completed'], d.onboarding.completed) },
    favoriteTools: [...new Set(Array.isArray(favoriteTools) ? favoriteTools : [])].filter(isToolId),
    defaultKeyId: stringOrNull(raw['defaultKeyId'], d.defaultKeyId),
    defaultModels,
    freeOnly: bool(raw['freeOnly'], d.freeOnly),
    tools,
    budgets: {
      mode: oneOf(budgets['mode'], BUDGET_MODES, d.budgets.mode),
      perRunUsd: clamped(budgets['perRunUsd'], 0, MAX_PER_RUN_USD, d.budgets.perRunUsd),
      monthlyUsd: usdOrNull(budgets['monthlyUsd'], d.budgets.monthlyUsd),
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
      retentionDays: Math.round(
        clamped(data['retentionDays'], 1, MAX_RETENTION_DAYS, d.data.retentionDays),
      ),
      recordRecentPrompts: bool(data['recordRecentPrompts'], d.data.recordRecentPrompts),
    },
    security: {
      autoLockMinutes: Math.round(
        // 0 = never auto-lock (the unlocked key still ends with the tab session).
        clamped(security['autoLockMinutes'], 0, MAX_AUTO_LOCK_MINUTES, d.security.autoLockMinutes),
      ),
    },
    models: {
      favorites: uniqueStrings(models['favorites'] ?? models['favourites']),
      recent: uniqueStrings(models['recent'], RECENT_MODELS_CAP),
    },
    ui: jsonObject(raw['ui']),
  };
}
