/**
 * Pure helpers behind the Settings page: hash routing, parsing of typed numbers, spend against limits, the
 * free-only preview, passphrase strength, key balance lines and the backup file name. No DOM and no services, so
 * logic.test.ts covers them without a page.
 */
import { SHIPPED_DEFAULTS } from '../../core/models/defaults';
import { isFreeModelId } from '../../core/models/free';
import type { Capability, KeyStatus, Settings, ToolManifest } from '../../core/types';
import { formatBytes, formatUsd } from '../../ui/format';
import { SETTINGS_SECTIONS, type SettingsSection } from '../../ui/shell/links';

/** The section a URL hash names (`#budgets`), or null. */
export function sectionFromHash(hash: string): SettingsSection | null {
  const id = hash.replace(/^#/, '');
  return SETTINGS_SECTIONS.find((section) => section.id === id)?.id ?? null;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * A dollar amount typed by the user: `5`, `0.25`, `$1,000`. Empty is `null` (no limit) when `optional`.
 * Negative, non-numeric or above `max` is an error with a message for the field.
 */
export function parseUsd(
  text: string,
  options: { max: number; optional?: boolean },
): Parsed<number | null> {
  const cleaned = text
    .trim()
    .replace(/^\$\s*/, '')
    .replace(/,/g, '');
  if (cleaned === '') {
    return options.optional
      ? { ok: true, value: null }
      : { ok: false, error: 'Enter an amount in dollars, like 0.25.' };
  }
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(cleaned)) {
    return { ok: false, error: 'Enter an amount in dollars, like 5 or 0.25.' };
  }
  const value = Number(cleaned);
  if (value > options.max) return { ok: false, error: `Enter at most ${formatUsd(options.max)}.` };
  // Sub-cent precision is plenty for limits; this also drops float noise like 0.30000000000000004.
  return { ok: true, value: Math.round(value * 1e6) / 1e6 };
}

/** A whole number between `min` and `max`, e.g. retention days or auto-lock minutes. */
export function parseWhole(text: string, options: { min: number; max: number }): Parsed<number> {
  const cleaned = text.trim();
  const value = /^\d+$/.test(cleaned) ? Number(cleaned) : NaN;
  if (!Number.isSafeInteger(value) || value < options.min || value > options.max) {
    return {
      ok: false,
      error: `Enter a whole number from ${options.min.toLocaleString('en-US')} to ${options.max.toLocaleString('en-US')}.`,
    };
  }
  return { ok: true, value };
}

/** A dollar value for an input field: `0.1` → `0.10`, `12.5` → `12.50`, `0.005` → `0.005`; null → ''. */
export function usdFieldValue(value: number | null): string {
  if (value === null) return '';
  return value >= 0.01 && Math.round(value * 100) === value * 100
    ? value.toFixed(2)
    : String(value);
}

export interface SpendMeter {
  /** 0–100, for the progress bar. */
  percent: number;
  tone: 'success' | 'warning' | 'danger';
  /** True once spend has reached the limit (budgets then block or ask before every paid run). */
  reached: boolean;
  /** `$1.20 of $5.00 · $3.80 left`. */
  text: string;
}

/** Spend against a limit; null when there is no limit. Warns from 80 %. */
export function spendMeter(spent: number, limit: number | null): SpendMeter | null {
  if (limit === null) return null;
  const ratio = limit > 0 ? spent / limit : 1;
  const reached = spent >= limit;
  return {
    percent: Math.min(100, Math.max(0, Math.round(ratio * 100))),
    tone: reached ? 'danger' : ratio >= 0.8 ? 'warning' : 'success',
    reached,
    text: `${formatUsd(spent)} of ${formatUsd(limit)} · ${
      reached ? 'limit reached' : `${formatUsd(limit - spent)} left`
    }`,
  };
}

/** The model a capability uses outside free-only mode, and whether the user changed it. */
export function capabilityDefault(
  settings: Pick<Settings, 'defaultModels'>,
  capability: Capability,
): { model: string; custom: boolean; shipped: string } {
  const shipped = SHIPPED_DEFAULTS[capability].paid;
  const chosen = settings.defaultModels[capability];
  return { model: chosen ?? shipped, custom: chosen !== undefined && chosen !== shipped, shipped };
}

/**
 * The model free-only mode would use: the first free one of the tool's pinned model, the capability default and
 * the shipped default, else the shipped free model, else null (blocked). The same cascade as
 * `ModelsService.resolve()` with free-only on (logic.test.ts checks they agree), but usable while the mode is
 * off, to show what turning it on would do.
 */
export function freeOnlyModel(
  settings: Pick<Settings, 'defaultModels' | 'tools'>,
  capability: Capability,
  tool?: ToolManifest['id'],
): string | null {
  const candidates = [
    tool ? settings.tools[tool]?.model : undefined,
    settings.defaultModels[capability],
    SHIPPED_DEFAULTS[capability].paid,
  ];
  return (
    candidates.find((id) => id !== undefined && isFreeModelId(id)) ??
    SHIPPED_DEFAULTS[capability].free
  );
}

export interface FreeOnlyImpact {
  /** Capabilities that have no free model (none shipped and no free default chosen). */
  capabilities: Capability[];
  /** Tools that cannot run in free-only mode: their primary capability resolves to no model. */
  tools: ToolManifest[];
}

export function freeOnlyImpact(
  settings: Pick<Settings, 'defaultModels' | 'tools'>,
  capabilities: readonly Capability[],
  tools: readonly ToolManifest[],
): FreeOnlyImpact {
  return {
    capabilities: capabilities.filter((cap) => freeOnlyModel(settings, cap) === null),
    tools: tools.filter((tool) => freeOnlyModel(settings, tool.capabilities[0]!, tool.id) === null),
  };
}

export const MIN_PASSPHRASE_LENGTH = 8;

export interface PassphraseStrength {
  /** 0 = too short, 1 weak … 4 strong. */
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  hint: string;
}

const WEAK_PARTS = ['password', 'passphrase', 'qwerty', 'letmein', '123456', 'abc123', 'ortoolbox'];

/**
 * A rough strength hint, not a guarantee: length matters most, then variety. Nothing here is sent anywhere.
 */
export function passphraseStrength(text: string): PassphraseStrength {
  if (text.length < MIN_PASSPHRASE_LENGTH) {
    return {
      score: 0,
      label: 'Too short',
      hint: `Use at least ${MIN_PASSPHRASE_LENGTH} characters. A few unrelated words are easy to remember and hard to guess.`,
    };
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(text)).length;
  const words = text.trim().split(/\s+/).length;
  let score = 1;
  if (text.length >= 12) score++;
  if (text.length >= 16 || words >= 4) score++;
  if (classes >= 3) score++;
  const lower = text.toLowerCase();
  if (/^(.)\1+$/.test(text) || WEAK_PARTS.some((part) => lower.includes(part))) score = 1;
  const capped = Math.min(score, 4) as PassphraseStrength['score'];
  const labels = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'] as const;
  return {
    score: capped,
    label: labels[capped],
    hint:
      capped >= 3
        ? 'Remember it: a forgotten passphrase cannot be recovered.'
        : 'Longer is stronger: try four or more unrelated words.',
  };
}

/** `ortoolbox-2026-10-03.ortoolbox.json`, dated in the user's time zone. */
export function backupFilename(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `ortoolbox-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.ortoolbox.json`;
}

/** `2.4 MB of 1.2 GB` with a percentage, or null when the browser reports nothing. */
export function storageUsage(
  usedBytes: number | null,
  quotaBytes: number | null,
): { text: string; percent: number | null } | null {
  if (usedBytes === null) return null;
  if (quotaBytes === null || quotaBytes <= 0) {
    return { text: `${formatBytes(usedBytes)} used`, percent: null };
  }
  const percent = Math.min(100, (usedBytes / quotaBytes) * 100);
  return {
    text: `${formatBytes(usedBytes)} of ${formatBytes(quotaBytes)} (${percent < 1 && usedBytes > 0 ? '<1' : Math.round(percent)}%)`,
    percent,
  };
}

export interface KeyBalance {
  /** `Used this month` / `Used in total`, with the amount. */
  usageLabel: string;
  usage: string;
  /** `$5.00`, or `No limit`. */
  limit: string;
  /** `$4.50 left`, or null without a limit. */
  remaining: string | null;
  /** Share of the limit still available, 0–100; null without a limit. */
  remainingPercent: number | null;
  /** `resets monthly`, or null. */
  reset: string | null;
  /** `12 of 50 used`, or null when OpenRouter did not say. */
  freeDaily: string | null;
}

/** What the Keys section shows for one key's `GET /key` status. */
export function keyBalance(status: KeyStatus): KeyBalance {
  const monthly = status.usageMonthlyUsd !== null;
  const limited = status.limitUsd !== null;
  const remaining =
    status.limitRemainingUsd ?? (limited ? Math.max(0, status.limitUsd! - status.usageUsd) : null);
  return {
    usageLabel: monthly ? 'Used this month' : 'Used in total',
    usage: formatUsd(status.usageMonthlyUsd ?? status.usageUsd),
    limit: limited ? formatUsd(status.limitUsd!) : 'No limit',
    remaining: remaining !== null ? `${formatUsd(remaining)} left` : null,
    remainingPercent:
      limited && remaining !== null
        ? status.limitUsd! > 0
          ? Math.min(100, Math.max(0, Math.round((remaining / status.limitUsd!) * 100)))
          : 0
        : null,
    reset: status.limitReset ? `resets ${status.limitReset}` : null,
    freeDaily: status.freeDaily
      ? `${status.freeDaily.used.toLocaleString('en-US')} of ${status.freeDaily.limit.toLocaleString('en-US')} used`
      : null,
  };
}
