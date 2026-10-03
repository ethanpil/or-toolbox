import { describe, expect, it } from 'vitest';
import type { StatsRow } from '../core/types';
import {
  ALL_TIME,
  assignSlots,
  averageLatency,
  budgetPace,
  change,
  daysOf,
  errorRate,
  formatChange,
  formatPercent,
  freeShare,
  groupBy,
  OTHER,
  markEstimate,
  parseCustomRange,
  preferredOrder,
  presetRange,
  previousRange,
  pruneHidden,
  rangeDays,
  rangeLabel,
  resolveRange,
  rowsIn,
  seriesSummary,
  seriesTable,
  SERIES_SLOTS,
  timeSeries,
  tokensByModel,
  totalsOf,
} from './stats-logic';

function row(partial: Partial<StatsRow> = {}): StatsRow {
  return {
    day: '2026-10-01',
    tool: 'chat',
    model: 'openai/gpt-x',
    keyId: 'k1',
    free: false,
    runs: 1,
    errors: 0,
    requests: 1,
    promptTokens: 100,
    completionTokens: 50,
    costUsd: 0.01,
    estimatedUsd: 0,
    latencyMsTotal: 1000,
    ...partial,
  };
}

const NOW = Date.UTC(2026, 9, 3, 15);

describe('ranges', () => {
  it('ends presets today (UTC) and counts today as a day', () => {
    expect(presetRange('7d', NOW)).toEqual({ from: '2026-09-27', to: '2026-10-03' });
    expect(presetRange('30d', NOW)).toEqual({ from: '2026-09-04', to: '2026-10-03' });
    expect(presetRange('90d', NOW)).toEqual({ from: '2026-07-06', to: '2026-10-03' });
    expect(presetRange('month', NOW)).toEqual({ from: '2026-10-01', to: '2026-10-03' });
    expect(rangeDays(presetRange('30d', NOW))).toBe(30);
    expect(rangeDays(presetRange('month', NOW))).toBe(3);
  });

  it('lists every day, oldest first, across month and year ends', () => {
    expect(daysOf({ from: '2026-12-30', to: '2027-01-02' })).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
    expect(daysOf({ from: '2026-10-03', to: '2026-10-01' })).toEqual([]);
    expect(daysOf({ from: 'x', to: 'y' })).toEqual([]);
  });

  it('takes the previous range of equal length', () => {
    expect(previousRange({ from: '2026-09-27', to: '2026-10-03' })).toEqual({
      from: '2026-09-20',
      to: '2026-09-26',
    });
    expect(previousRange({ from: '2026-10-01', to: '2026-10-01' })).toEqual({
      from: '2026-09-30',
      to: '2026-09-30',
    });
  });

  it('validates custom ranges', () => {
    expect(parseCustomRange('2026-09-01', '2026-09-30')).toEqual({
      range: { from: '2026-09-01', to: '2026-09-30' },
    });
    expect(parseCustomRange('', '2026-09-30')).toHaveProperty('error');
    expect(parseCustomRange('2026-02-30', '2026-03-01')).toHaveProperty('error');
    expect(parseCustomRange('2026-09-30', '2026-09-01')).toEqual({
      error: 'The start day must not be after the end day.',
    });
    expect(parseCustomRange('2020-01-01', '2026-09-01')).toHaveProperty('error');
  });

  it('labels ranges for people', () => {
    expect(rangeLabel({ from: '2026-09-04', to: '2026-10-03' })).toBe('Sep 4 to Oct 3, 2026');
    expect(rangeLabel({ from: '2025-12-20', to: '2026-01-03' })).toBe(
      'Dec 20, 2025 to Jan 3, 2026',
    );
    expect(rangeLabel({ from: '2026-10-03', to: '2026-10-03' })).toBe('Oct 3, 2026');
  });
});

describe('totals', () => {
  const rows = [
    row({ requests: 4, runs: 3, errors: 1, costUsd: 0.4, latencyMsTotal: 4000 }),
    row({ free: true, requests: 6, runs: 5, costUsd: 0, latencyMsTotal: 3000, model: 'x/y:free' }),
  ];

  it('sums everything, and splits requests into free and paid', () => {
    expect(totalsOf(rows)).toEqual({
      costUsd: 0.4,
      estimatedUsd: 0,
      requests: 10,
      runs: 8,
      errors: 1,
      promptTokens: 200,
      completionTokens: 100,
      latencyMsTotal: 7000,
      freeRequests: 6,
      paidRequests: 4,
    });
  });

  it('derives the rates, and says null when there is nothing to divide', () => {
    const totals = totalsOf(rows);
    expect(errorRate(totals)).toBeCloseTo(1 / 8);
    expect(averageLatency(totals)).toBe(700);
    expect(freeShare(totals)).toBeCloseTo(0.6);
    const none = totalsOf([]);
    expect(errorRate(none)).toBeNull();
    expect(averageLatency(none)).toBeNull();
    expect(freeShare(none)).toBeNull();
  });

  it('formats percentages and changes', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.0004)).toBe('<0.1%');
    expect(formatPercent(0.032)).toBe('3.2%');
    expect(formatPercent(0.125)).toBe('13%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(NaN)).toBe('—');
    expect(formatChange(0.124)).toBe('+12%');
    expect(formatChange(-0.5)).toBe('−50%');
    expect(formatChange(0.001)).toBe('no change');
    expect(change(12, 10)).toBeCloseTo(0.2);
    expect(change(5, 0)).toBeNull();
  });
});

describe('groups', () => {
  const rows = [
    row({ tool: 'chat', model: 'a/a', keyId: 'k1', costUsd: 0.1, requests: 2 }),
    row({ tool: 'ocr', model: 'b/b', keyId: 'k1', costUsd: 0.3, requests: 1 }),
    row({ tool: 'chat', model: 'b/b', keyId: 'k2', costUsd: 0.1, requests: 5, day: '2026-10-02' }),
    row({ tool: 'ocr', model: 'c/c:free', keyId: 'k2', costUsd: 0, requests: 9, free: true }),
  ];

  it('groups by tool, model and key, biggest spender first, then most requests', () => {
    expect(groupBy(rows, 'tool').map((g) => [g.id, g.costUsd, g.requests])).toEqual([
      ['ocr', 0.3, 10],
      ['chat', 0.2, 7],
    ]);
    expect(groupBy(rows, 'model').map((g) => g.id)).toEqual(['b/b', 'a/a', 'c/c:free']);
    expect(groupBy(rows, 'key').map((g) => [g.id, g.requests])).toEqual([
      ['k1', 3],
      ['k2', 14],
    ]);
    expect(groupBy([], 'tool')).toEqual([]);
  });
});

describe('colour slots follow the entity', () => {
  const preferred = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];

  it('keeps the slot of the overall rank when the series set changes', () => {
    expect([...assignSlots(['a', 'b', 'c'], preferred)]).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
    // "b" dropped out of the range: the others keep their colours.
    expect([...assignSlots(['a', 'c'], preferred)]).toEqual([
      ['a', 0],
      ['c', 2],
    ]);
    expect([...assignSlots(['d'], preferred)]).toEqual([['d', 3]]);
  });

  it('gives entities without a rank in the palette the free slots, in order', () => {
    // "h" and "i" rank 7 and 8: beyond the seven slots, so they take free ones.
    const slots = assignSlots(['a', 'h', 'i'], preferred);
    expect(slots.get('a')).toBe(0);
    expect(slots.get('h')).toBe(1);
    expect(slots.get('i')).toBe(2);
    // Never an eighth colour.
    const many = assignSlots(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], preferred);
    expect(many.size).toBe(SERIES_SLOTS);
    expect(many.has('h')).toBe(false);
    expect(new Set(many.values()).size).toBe(SERIES_SLOTS);
  });

  it('works with no preference at all', () => {
    expect([...assignSlots(['x', 'y'], [])]).toEqual([
      ['x', 0],
      ['y', 1],
    ]);
  });

  it('orders the preference by spend, then requests', () => {
    expect(
      preferredOrder(
        [
          row({ tool: 'chat', costUsd: 1 }),
          row({ tool: 'ocr', costUsd: 2 }),
          row({ tool: 'decision', costUsd: 0, requests: 99 }),
        ],
        'tool',
      ),
    ).toEqual(['ocr', 'chat', 'decision']);
  });
});

describe('time series', () => {
  const days = ['2026-10-01', '2026-10-02', '2026-10-03'];

  it('lays one value per day per entity, biggest first', () => {
    const rows = [
      row({ day: '2026-10-01', tool: 'chat', costUsd: 1 }),
      row({ day: '2026-10-03', tool: 'chat', costUsd: 2, model: 'm2' }),
      row({ day: '2026-10-02', tool: 'ocr', costUsd: 5 }),
    ];
    const series = timeSeries(rows, days, 'tool', 'costUsd');
    expect(series.map((s) => [s.id, s.values, s.total, s.slot])).toEqual([
      ['ocr', [0, 5, 0], 5, 0],
      ['chat', [1, 0, 2], 3, 1],
    ]);
  });

  it('adds up the rows of one entity and day (several keys or tools)', () => {
    const rows = [
      row({ model: 'm', tool: 'chat', keyId: 'k1', requests: 2 }),
      row({ model: 'm', tool: 'ocr', keyId: 'k2', requests: 3 }),
    ];
    expect(timeSeries(rows, days, 'model', 'requests')[0]!.values).toEqual([5, 0, 0]);
  });

  it('leaves out entities with nothing in the metric, and rows outside the range', () => {
    const rows = [
      row({ model: 'free', free: true, costUsd: 0, requests: 9 }),
      row({ model: 'paid', costUsd: 1 }),
      row({ model: 'old', day: '2026-01-01', costUsd: 9 }),
    ];
    expect(timeSeries(rows, days, 'model', 'costUsd').map((s) => s.id)).toEqual(['paid']);
    expect(timeSeries(rows, days, 'model', 'requests').map((s) => s.id)).toEqual(['free', 'paid']);
  });

  it('keeps the top seven and folds the rest into Other, without a slot', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ model: `m${i}`, costUsd: 10 - i, requests: 1 }),
    );
    const series = timeSeries(rows, days, 'model', 'costUsd');
    expect(series).toHaveLength(8);
    expect(series.slice(0, 7).map((s) => s.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    const other = series[7]!;
    expect(other).toMatchObject({ id: OTHER, slot: null, total: 3 + 2 + 1 });
    expect(other.values).toEqual([6, 0, 0]);
    expect(new Set(series.slice(0, 7).map((s) => s.slot)).size).toBe(7);
  });

  it('keeps colours stable when the range changes (the preference decides)', () => {
    const rows = [row({ tool: 'chat', costUsd: 1 }), row({ tool: 'ocr', costUsd: 5 })];
    const preferred = ['chat', 'ocr'];
    const both = timeSeries(rows, days, 'tool', 'costUsd', preferred);
    const onlyOcr = timeSeries([rows[1]!], days, 'tool', 'costUsd', preferred);
    const slot = (list: typeof both, id: string) => list.find((s) => s.id === id)?.slot;
    expect(slot(both, 'ocr')).toBe(1);
    expect(slot(onlyOcr, 'ocr')).toBe(1);
  });

  it('is empty without rows', () => {
    expect(timeSeries([], days, 'tool', 'costUsd')).toEqual([]);
    expect(timeSeries([row()], [], 'tool', 'costUsd')).toEqual([]);
  });
});

describe('tokens per model', () => {
  it('lists the models that used the most tokens, skipping those without tokens', () => {
    const rows = [
      row({ model: 'a', promptTokens: 10, completionTokens: 5 }),
      row({ model: 'b', promptTokens: 100, completionTokens: 50 }),
      row({ model: 'tts', promptTokens: 0, completionTokens: 0 }),
      row({ model: 'a', promptTokens: 1000, completionTokens: 0, day: '2026-10-02' }),
    ];
    expect(tokensByModel(rows)).toEqual([
      { model: 'a', promptTokens: 1010, completionTokens: 5 },
      { model: 'b', promptTokens: 100, completionTokens: 50 },
    ]);
    expect(tokensByModel(rows, 1)).toHaveLength(1);
  });
});

describe('series table', () => {
  const days = ['2026-10-01', '2026-10-02', '2026-10-03'];
  const series = [
    { id: 'chat', slot: 0, values: [1, 0, 2], total: 3 },
    { id: OTHER, slot: null, values: [0.5, 0, 0], total: 0.5 },
  ];
  const label = (id: string): string => (id === OTHER ? 'Other' : id);

  it('has a header, a total column and only days with data', () => {
    expect(seriesTable(days, series, label, (value) => `$${value}`)).toEqual({
      head: ['Day', 'chat', 'Other', 'Total'],
      body: [
        ['Oct 1', '$1', '$0.5', '$1.5'],
        ['Oct 3', '$2', '$0', '$2'],
      ],
    });
  });

  it('skips the total for one series', () => {
    expect(seriesTable(days, [series[0]!], label, String)).toEqual({
      head: ['Day', 'chat'],
      body: [
        ['Oct 1', '1'],
        ['Oct 3', '2'],
      ],
    });
  });
});

describe('budget pace', () => {
  it('compares spend with the limit and where an even spender would be', () => {
    const pace = budgetPace(25, 100, Date.UTC(2026, 9, 16, 12));
    expect(pace).toMatchObject({
      spendUsd: 25,
      limitUsd: 100,
      fraction: 0.25,
      remainingUsd: 75,
      severity: 'ok',
    });
    expect(pace.elapsed).toBeCloseTo(15.5 / 31);
    expect(pace.projectedUsd).toBeCloseTo((25 / 15.5) * 31);
    expect(pace.daysLeft).toBe(16);
  });

  it('warns from 80% and flags a passed limit', () => {
    expect(budgetPace(80, 100, NOW).severity).toBe('warning');
    expect(budgetPace(79.99, 100, NOW).severity).toBe('ok');
    const over = budgetPace(120, 100, NOW);
    expect(over.severity).toBe('over');
    expect(over.remainingUsd).toBe(0);
  });

  it('does not project in the first day of the month, and survives a zero limit', () => {
    expect(budgetPace(1, 10, Date.UTC(2026, 9, 1, 6)).projectedUsd).toBeNull();
    expect(budgetPace(1, 0, NOW)).toMatchObject({ fraction: Infinity, severity: 'over' });
    expect(budgetPace(0, 0, NOW).fraction).toBe(0);
  });

  it('handles February', () => {
    expect(budgetPace(10, 100, Date.UTC(2027, 1, 14, 0)).daysLeft).toBe(15);
  });
});

describe('series summary', () => {
  const days = ['2026-10-01', '2026-10-02', '2026-10-03'];
  const label = (id: string): string => id.toUpperCase();

  it('names the total, the busiest day and the biggest series', () => {
    const series = [
      { id: 'chat', slot: 0, values: [1, 0, 5], total: 6 },
      { id: 'ocr', slot: 1, values: [0, 2, 0], total: 2 },
    ];
    expect(seriesSummary('Spend per day', days, series, label, (v) => `$${v}`)).toBe(
      'Spend per day: $8 over 3 active days. Busiest day Oct 3 with $5. Largest series CHAT with $6. The table view lists every value.',
    );
  });

  it('is short for one series and honest about no data', () => {
    expect(
      seriesSummary(
        'Requests',
        days,
        [{ id: 'chat', slot: 0, values: [0, 3, 0], total: 3 }],
        label,
        String,
      ),
    ).toBe(
      'Requests: 3 over 1 active day. Busiest day Oct 2 with 3. The table view lists every value.',
    );
    expect(seriesSummary('Requests', days, [], label, String)).toBe(
      'Requests: no data in this period.',
    );
  });
});

describe('estimated spend', () => {
  const days = ['2026-10-01', '2026-10-02', '2026-10-03'];

  it('sums the estimated part with the totals and the groups', () => {
    const rows = [
      row({ tool: 'chat', costUsd: 0.4, estimatedUsd: 0.1 }),
      row({ tool: 'chat', costUsd: 0.2, estimatedUsd: 0 }),
      row({ tool: 'ocr', costUsd: 0.3, estimatedUsd: 0.3 }),
    ];
    expect(totalsOf(rows).estimatedUsd).toBeCloseTo(0.4);
    expect(groupBy(rows, 'tool').map((g) => [g.id, g.costUsd, g.estimatedUsd])).toEqual([
      ['chat', expect.closeTo(0.6) as number, expect.closeTo(0.1) as number],
      ['ocr', 0.3, 0.3],
    ]);
    expect(totalsOf([]).estimatedUsd).toBe(0);
  });

  it('marks a figure that includes an estimate with ≈, and leaves exact ones alone', () => {
    expect(markEstimate('$1.65', 0.3)).toBe('≈ $1.65');
    expect(markEstimate('$1.65', 0)).toBe('$1.65');
  });

  it('carries the estimated part of each day through the spend series, folded into Other too', () => {
    const rows = [
      row({ day: '2026-10-01', tool: 'chat', costUsd: 1, estimatedUsd: 0.25 }),
      row({ day: '2026-10-01', tool: 'chat', model: 'm2', costUsd: 1, estimatedUsd: 0.25 }),
      row({ day: '2026-10-03', tool: 'chat', costUsd: 2 }),
    ];
    const [chat] = timeSeries(rows, days, 'tool', 'costUsd');
    expect(chat!.values).toEqual([2, 0, 2]);
    expect(chat!.estimated).toEqual([0.5, 0, 0]);
    // The requests series has no estimated part.
    expect(timeSeries(rows, days, 'tool', 'requests')[0]!.estimated).toEqual([0, 0, 0]);

    const many = Array.from({ length: 9 }, (_, i) =>
      row({ model: `m${i}`, costUsd: 10 - i, estimatedUsd: i === 8 ? 1 : 0 }),
    );
    const other = timeSeries(many, days, 'model', 'costUsd').find((s) => s.id === OTHER);
    expect(other?.estimated).toEqual([1, 0, 0]);
  });

  it('marks estimated cells and totals in the table view, and says so in the summary', () => {
    const series = [
      { id: 'chat', slot: 0, values: [1, 0, 2], total: 3, estimated: [0.5, 0, 0] },
      { id: 'ocr', slot: 1, values: [0.5, 0, 0], total: 0.5, estimated: [0, 0, 0] },
    ];
    const format = (value: number): string => `$${value}`;
    expect(seriesTable(days, series, String, format).body).toEqual([
      ['Oct 1', '≈ $1', '$0.5', '≈ $1.5'],
      ['Oct 3', '$2', '$0', '$2'],
    ]);
    expect(seriesSummary('Spend', days, series, String, format)).toContain(
      'Includes estimated costs.',
    );
    expect(seriesSummary('Spend', days, [{ ...series[1]! }], String, format)).not.toContain(
      'estimated',
    );
  });
});

describe('hidden series', () => {
  it('forgets hidden series when the legend goes away (a lone series is always shown)', () => {
    expect(pruneHidden(new Set(['a']), ['a'])).toEqual(new Set());
    expect(pruneHidden(new Set(['a', 'b']), [])).toEqual(new Set());
  });

  it('keeps the hidden series that are still in a legend, and drops the ones that left', () => {
    expect(pruneHidden(new Set(['a', 'gone']), ['a', 'b'])).toEqual(new Set(['a']));
    expect(pruneHidden(new Set(), ['a', 'b'])).toEqual(new Set());
  });
});

describe('relative ranges roll over', () => {
  const custom = { from: '2026-01-01', to: '2026-01-31' };

  it('recomputes the presets from the current time, and leaves custom ranges alone', () => {
    const before = Date.UTC(2026, 9, 3, 23, 59, 59);
    const after = Date.UTC(2026, 9, 4, 0, 0, 1);
    expect(resolveRange('7d', custom, before)).toEqual({ from: '2026-09-27', to: '2026-10-03' });
    expect(resolveRange('7d', custom, after)).toEqual({ from: '2026-09-28', to: '2026-10-04' });
    expect(resolveRange('custom', custom, after)).toBe(custom);
  });

  it('this month starts over at the end of the month, and so does the range before it', () => {
    const last = Date.UTC(2026, 9, 31, 23, 59, 59);
    const first = Date.UTC(2026, 10, 1, 0, 0, 1);
    expect(resolveRange('month', custom, last)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    const november = resolveRange('month', custom, first);
    expect(november).toEqual({ from: '2026-11-01', to: '2026-11-01' });
    expect(previousRange(november)).toEqual({ from: '2026-10-31', to: '2026-10-31' });
  });
});

describe('reading one ledger', () => {
  const rows = [
    row({ day: '2026-09-30', costUsd: 1 }),
    row({ day: '2026-10-01', costUsd: 2 }),
    row({ day: '2026-10-03', costUsd: 4 }),
    row({ day: '2026-10-03', keyId: 'k2', costUsd: 8, free: true, requests: 5 }),
  ];

  it('picks the rows of a range, both days included', () => {
    expect(rowsIn(rows, { from: '2026-10-01', to: '2026-10-03' })).toHaveLength(3);
    expect(rowsIn(rows, { from: '2026-10-02', to: '2026-10-02' })).toEqual([]);
    expect(rowsIn(rows, ALL_TIME)).toHaveLength(4);
  });

  it('derives the month, a key and today from it', () => {
    const month = rowsIn(rows, presetRange('month', Date.UTC(2026, 9, 3, 12)));
    expect(totalsOf(month).costUsd).toBeCloseTo(14);
    expect(totalsOf(month.filter((r) => r.keyId === 'k2')).costUsd).toBe(8);
    const today = rowsIn(rows, { from: '2026-10-03', to: '2026-10-03' });
    expect(totalsOf(today).freeRequests).toBe(5);
  });
});
