import { describe, expect, it } from 'vitest';
import type { KeyStatus } from '../core/types';
import {
  formatContext,
  formatCount,
  formatDate,
  formatEstimate,
  formatInt,
  formatModelPrice,
  formatMs,
  formatRelativeTime,
  formatTokens,
  formatUsd,
  keyBalance,
  plural,
} from './format';

const pricing = (
  prompt: number | null,
  completion: number | null,
  extra: { request?: number; image?: number } = {},
) => ({
  prompt,
  completion,
  image: extra.image ?? null,
  request: extra.request ?? null,
  raw: {},
});

describe('formatUsd', () => {
  it.each([
    [0, '$0.00'],
    [1, '$1.00'],
    [1234.5, '$1,234.50'],
    [0.1, '$0.10'],
    [0.25, '$0.25'],
    [0.0512, '$0.051'],
    [0.0012, '$0.0012'],
    [0.00012, '$0.00012'],
    [0.00001, '<$0.0001'],
    [-0.5, '−$0.50'],
  ])('%s → %s', (value, expected) => {
    expect(formatUsd(value)).toBe(expected);
  });

  it('shows a dash for values that are not finite', () => {
    expect(formatUsd(Number.NaN)).toBe('—');
  });
});

describe('formatEstimate', () => {
  it('distinguishes unknown, free and an estimate', () => {
    expect(formatEstimate(null)).toBe('Unknown');
    expect(formatEstimate(0)).toBe('Free');
    expect(formatEstimate(0.0012)).toBe('≈ $0.0012');
  });
});

describe('counts, tokens, latencies and context', () => {
  it.each([
    [950, '950'],
    [1200, '1.2K'],
    [34_000, '34K'],
    [128_000, '128K'],
    [1_500_000, '1.5M'],
  ])('formatCount(%s) → %s', (value, expected) => {
    expect(formatCount(value)).toBe(expected);
  });

  it('formats tokens with a singular', () => {
    expect(formatTokens(1)).toBe('1 token');
    expect(formatTokens(1234)).toBe('1,234 tokens');
  });

  it.each([
    [850, '850 ms'],
    [1234, '1.2 s'],
    [42_000, '42 s'],
    [185_000, '3 min 5 s'],
    [3_720_000, '1 h 2 min'],
  ])('formatMs(%s) → %s', (value, expected) => {
    expect(formatMs(value)).toBe(expected);
  });

  it('formats the context window, or nothing', () => {
    expect(formatContext(128_000)).toBe('128K context');
    expect(formatContext(null)).toBeNull();
    expect(formatContext(0)).toBeNull();
  });

  it('pluralises', () => {
    expect(plural(1, 'image')).toBe('1 image');
    expect(plural(3, 'image')).toBe('3 images');
    expect(plural(2, 'audio file')).toBe('2 audio files');
  });
});

describe('formatModelPrice', () => {
  it('says Free for free models whatever the catalog prices', () => {
    expect(formatModelPrice({ isFree: true, pricing: pricing(0.000001, 0.000002) })).toBe('Free');
  });

  it('shows per-million token prices', () => {
    expect(formatModelPrice({ isFree: false, pricing: pricing(0.0000001, 0.0000005) })).toBe(
      '$0.10 in · $0.50 out per 1M tokens',
    );
  });

  it('falls back to per-request, per-input-image or "Price varies"', () => {
    expect(
      formatModelPrice({ isFree: false, pricing: pricing(null, null, { request: 0.04 }) }),
    ).toBe('$0.04 per request');
    expect(formatModelPrice({ isFree: false, pricing: pricing(null, null, { image: 0.03 }) })).toBe(
      '$0.03 per input image',
    );
    expect(formatModelPrice({ isFree: false, pricing: pricing(null, null) })).toBe('Price varies');
    expect(formatModelPrice({ isFree: false, pricing: pricing(0, 0) })).toBe('Price varies');
  });
});

describe('formatRelativeTime', () => {
  const now = new Date(2026, 9, 2, 15, 0, 0).getTime();

  it('reads naturally for recent times', () => {
    expect(formatRelativeTime(now - 10_000, now)).toBe('just now');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3 hours ago');
  });

  it('uses calendar days for older times', () => {
    const lastNight = new Date(2026, 9, 1, 23, 0, 0).getTime();
    const yesterdayMorning = new Date(2026, 9, 1, 8, 0, 0).getTime();
    expect(formatRelativeTime(yesterdayMorning, now)).toBe('yesterday');
    // 16 hours ago is still "16 hours ago", not "yesterday".
    expect(formatRelativeTime(lastNight, now)).toBe('16 hours ago');
    expect(formatRelativeTime(new Date(2026, 8, 28, 12).getTime(), now)).toBe('4 days ago');
  });

  it('shows a date after a week, with the year only for another year', () => {
    expect(formatRelativeTime(new Date(2026, 2, 4, 12).getTime(), now)).toBe('Mar 4');
    expect(formatRelativeTime(new Date(2025, 2, 4, 12).getTime(), now)).toBe('Mar 4, 2025');
  });
});

describe('formatInt', () => {
  it('groups thousands and rounds to a whole number', () => {
    expect(formatInt(0)).toBe('0');
    expect(formatInt(1234567)).toBe('1,234,567');
    expect(formatInt(12.6)).toBe('13');
    expect(formatInt(-1500)).toBe('-1,500');
    expect(formatInt(Number.NaN)).toBe('—');
  });
});

describe('formatDate', () => {
  it('shows a timestamp in local time and a day string as that UTC day', () => {
    expect(formatDate(new Date(2026, 9, 3, 12).getTime())).toBe('Oct 3, 2026');
    expect(formatDate('2026-10-03')).toBe('Oct 3, 2026');
    // A UTC day is the same day everywhere, whatever the time zone.
    expect(formatDate('2026-10-03T23:59:59Z')).toBe('Oct 3, 2026');
  });

  it('can leave out the year or add the weekday', () => {
    expect(formatDate('2026-10-03', { year: false })).toBe('Oct 3');
    expect(formatDate(new Date(2026, 9, 3, 12).getTime(), { weekday: true, year: false })).toBe(
      'Sat, Oct 3',
    );
  });
});

describe('keyBalance', () => {
  const status = (patch: Partial<KeyStatus> = {}): KeyStatus => ({
    label: null,
    usageUsd: 25.5,
    usageMonthlyUsd: 3.25,
    limitUsd: 100,
    limitRemainingUsd: 74.5,
    limitReset: 'monthly',
    isFreeTier: false,
    freeDaily: { used: 12, limit: 50, remaining: 38 },
    fetchedAt: 0,
    ...patch,
  });

  it('describes a limited key', () => {
    expect(keyBalance(status())).toEqual({
      usageLabel: 'Used this month',
      usage: '$3.25',
      limit: '$100.00',
      remaining: '$74.50 left',
      remainingPercent: 75,
      reset: 'resets monthly',
      freeDaily: '12 of 50 used',
    });
  });

  it('describes an unlimited key without monthly usage or a free counter', () => {
    expect(
      keyBalance(
        status({
          usageMonthlyUsd: null,
          limitUsd: null,
          limitRemainingUsd: null,
          limitReset: null,
          freeDaily: null,
        }),
      ),
    ).toEqual({
      usageLabel: 'Used in total',
      usage: '$25.50',
      limit: 'No limit',
      remaining: null,
      remainingPercent: null,
      reset: null,
      freeDaily: null,
    });
  });

  it('derives the remaining amount when OpenRouter leaves it out', () => {
    expect(
      keyBalance(status({ limitUsd: 10, limitRemainingUsd: null, usageUsd: 4 })),
    ).toMatchObject({ remaining: '$6.00 left', remainingPercent: 60 });
  });
});
