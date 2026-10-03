import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../core/types';
import {
  activeHistoryFilters,
  appendPage,
  costInfo,
  dayKey,
  dayLabel,
  entriesOf,
  groupByDay,
  humanizeKey,
  latencyText,
  localDayEnd,
  localDayStart,
  nextPage,
  NO_HISTORY_FILTERS,
  modelsOf,
  outputView,
  prettyJson,
  parseHistoryParams,
  splitDeletable,
  toQuery,
  tokenText,
  usageRows,
} from './history-logic';

// Noon local time, so day arithmetic never lands on a DST edge.
const at = (year: number, month: number, day: number, hour = 12): number =>
  new Date(year, month - 1, day, hour).getTime();
const NOW = at(2026, 10, 3, 15);

function run(id: string, startedAt: number, partial: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    tool: 'chat',
    status: 'ok',
    model: 'openai/gpt-x',
    models: ['openai/gpt-x'],
    keyId: 'k1',
    keyName: 'Work',
    startedAt,
    finishedAt: startedAt + 500,
    latencyMs: 500,
    title: id,
    prompt: null,
    settings: null,
    output: null,
    error: null,
    usage: {
      requests: 1,
      promptTokens: 1200,
      completionTokens: 340,
      costUsd: 0.0123,
      latencyMsTotal: 500,
      costEstimated: false,
      costUnknown: false,
      byModel: {},
    },
    reservedUsd: 0,
    jobId: null,
    meta: {},
    starred: false,
    groupId: null,
    ...partial,
  };
}

const isFree = (model: string): boolean => model.endsWith(':free');

describe('days', () => {
  it('labels today, yesterday, this year and earlier years', () => {
    expect(dayLabel(at(2026, 10, 3, 9), NOW)).toBe('Today');
    expect(dayLabel(at(2026, 10, 2, 23), NOW)).toBe('Yesterday');
    expect(dayLabel(at(2026, 9, 28), NOW)).toBe('Mon, Sep 28');
    expect(dayLabel(at(2025, 12, 31), NOW)).toBe('Dec 31, 2025');
  });

  it('keeps yesterday right across a month boundary', () => {
    expect(dayLabel(at(2026, 9, 30), at(2026, 10, 1, 8))).toBe('Yesterday');
  });

  it('groups consecutive runs of one local day, keeping the order', () => {
    const runs = [
      run('a', at(2026, 10, 3, 14)),
      run('b', at(2026, 10, 3, 9)),
      run('c', at(2026, 10, 2, 20)),
      run('d', at(2026, 9, 1)),
    ];
    const groups = groupByDay(runs, NOW);
    expect(groups.map((g) => [g.label, g.runs.map((r) => r.id)])).toEqual([
      ['Today', ['a', 'b']],
      ['Yesterday', ['c']],
      ['Tue, Sep 1', ['d']],
    ]);
    expect(groupByDay([], NOW)).toEqual([]);
  });

  it('parses local days, refusing impossible ones', () => {
    expect(localDayStart('2026-10-03')).toBe(new Date(2026, 9, 3).getTime());
    expect(localDayEnd('2026-10-03')).toBe(new Date(2026, 9, 4).getTime() - 1);
    expect(localDayStart('2026-02-31')).toBeNull();
    expect(localDayStart('yesterday')).toBeNull();
    expect(localDayEnd('')).toBeNull();
    expect(dayKey(at(2026, 1, 5))).toBe('2026-01-05');
  });
});

describe('queries', () => {
  it('leaves unset filters out', () => {
    expect(toQuery(NO_HISTORY_FILTERS)).toEqual({});
    expect(toQuery(NO_HISTORY_FILTERS, { limit: 40 })).toEqual({ limit: 40 });
  });

  it('maps every filter to the history query', () => {
    expect(
      toQuery(
        {
          text: '  invoice ',
          tool: 'ocr',
          status: 'error',
          model: 'm/x',
          keyId: 'k2',
          starred: true,
          from: '2026-10-01',
          to: '2026-10-03',
        },
        { limit: 10, before: 5 },
      ),
    ).toEqual({
      text: 'invoice',
      tool: 'ocr',
      status: 'error',
      model: 'm/x',
      keyId: 'k2',
      starred: true,
      from: new Date(2026, 9, 1).getTime(),
      to: new Date(2026, 9, 4).getTime() - 1,
      limit: 10,
      before: 5,
    });
  });

  it('ignores unreadable dates', () => {
    expect(toQuery({ ...NO_HISTORY_FILTERS, from: 'x', to: '2026-13-01' })).toEqual({});
  });

  it('counts active filters', () => {
    expect(activeHistoryFilters(NO_HISTORY_FILTERS)).toBe(0);
    expect(activeHistoryFilters({ ...NO_HISTORY_FILTERS, text: '   ' })).toBe(0);
    expect(
      activeHistoryFilters({ ...NO_HISTORY_FILTERS, text: 'a', starred: true, from: '2026-01-01' }),
    ).toBe(3);
  });

  it('reads ?tool= and ?run=, ignoring unknown tools and odd run ids', () => {
    expect(parseHistoryParams('?tool=ocr&run=abc-123')).toEqual({ tool: 'ocr', run: 'abc-123' });
    expect(parseHistoryParams('?tool=nope')).toEqual({ tool: null, run: null });
    expect(parseHistoryParams('?run=<script>')).toEqual({ tool: null, run: null });
    expect(parseHistoryParams('')).toEqual({ tool: null, run: null });
  });
});

describe('paging', () => {
  it('asks for the page after the last row, inclusive of its millisecond', () => {
    expect(nextPage([])).toBeNull();
    const shown = [run('a', 300), run('b', 200)];
    expect(nextPage(shown, 40)).toEqual({ before: 201, limit: 41 });
  });

  it('re-asks for rows that share the boundary millisecond, so none is skipped', () => {
    const shown = [run('a', 300), run('b', 200), run('c', 200)];
    expect(nextPage(shown, 2)).toEqual({ before: 201, limit: 4 });
  });

  it('drops rows that are already shown when appending', () => {
    const shown = [run('a', 300), run('b', 200)];
    const page = [run('b', 200), run('c', 200), run('d', 100)];
    expect(appendPage(shown, page).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(appendPage(shown, []).map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('cost', () => {
  it('shows reported costs, Free for free models, and $0.00 for a paid model that reported nothing', () => {
    expect(costInfo(run('a', 1), isFree)).toMatchObject({ text: '$0.012', note: null });
    const zero = { usage: { ...run('a', 1).usage, costUsd: 0 } };
    expect(costInfo(run('a', 1, { ...zero, model: 'x/y:free' }), isFree).text).toBe('Free');
    expect(costInfo(run('a', 1, zero), isFree).text).toBe('$0.00');
  });

  it('marks estimated and unknown costs', () => {
    const estimated = run('a', 1, { usage: { ...run('a', 1).usage, costEstimated: true } });
    expect(costInfo(estimated, isFree)).toMatchObject({ text: '≈ $0.012', note: 'estimated' });
    const unknown = run('a', 1, { usage: { ...run('a', 1).usage, costUnknown: true, costUsd: 0 } });
    expect(costInfo(unknown, isFree)).toMatchObject({ text: 'Unknown', note: 'unknown' });
  });

  it('says Running while running', () => {
    expect(costInfo(run('a', 1, { status: 'running' }), isFree).text).toBe('Running');
  });

  it('formats tokens and latency, and omits them when there are none', () => {
    expect(tokenText(run('a', 1))).toBe('1.2K in · 340 out');
    expect(
      tokenText(
        run('a', 1, { usage: { ...run('a', 1).usage, promptTokens: 0, completionTokens: 0 } }),
      ),
    ).toBeNull();
    expect(latencyText(run('a', 1))).toBe('500 ms');
    expect(latencyText(run('a', 1, { latencyMs: null }))).toBeNull();
  });

  it('lists usage per model with average latency', () => {
    const r = run('a', 1, {
      usage: {
        ...run('a', 1).usage,
        byModel: {
          'a/b': {
            requests: 2,
            promptTokens: 10,
            completionTokens: 5,
            costUsd: 0.1,
            latencyMsTotal: 3000,
          },
          'c/d': {
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            costUsd: 0,
            latencyMsTotal: 0,
          },
        },
      },
    });
    expect(usageRows(r)).toEqual([
      {
        model: 'a/b',
        requests: 2,
        promptTokens: 10,
        completionTokens: 5,
        costUsd: 0.1,
        avgLatencyMs: 1500,
      },
      {
        model: 'c/d',
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        avgLatencyMs: null,
      },
    ]);
  });
});

describe('settings and output', () => {
  it('makes setting names readable', () => {
    expect(humanizeKey('aspectRatio')).toBe('Aspect ratio');
    expect(humanizeKey('max_tokens')).toBe('Max tokens');
    expect(humanizeKey('response-format')).toBe('Response format');
    expect(humanizeKey('temperature')).toBe('Temperature');
    expect(humanizeKey('')).toBe('');
  });

  it('formats values: booleans, lists, nested objects, long text', () => {
    const entries = entriesOf({
      temperature: 0.3,
      stream: true,
      voices: ['a', 'b'],
      empty: [],
      nothing: null,
      blank: '',
      nested: { a: 1 },
      long: 'x'.repeat(100),
      lines: 'one\ntwo',
      gone: undefined,
    });
    const byLabel = Object.fromEntries(entries.map((e) => [e.label, e]));
    expect(byLabel['Temperature']).toEqual({ label: 'Temperature', value: '0.3', block: false });
    expect(byLabel['Stream']?.value).toBe('Yes');
    expect(byLabel['Voices']?.value).toBe('a, b');
    expect(byLabel['Empty']?.value).toBe('—');
    expect(byLabel['Nothing']?.value).toBe('—');
    expect(byLabel['Blank']?.value).toBe('—');
    expect(byLabel['Nested']?.value).toBe('{"a":1}');
    expect(byLabel['Long']?.block).toBe(true);
    expect(byLabel['Lines']?.block).toBe(true);
    expect(byLabel['Gone']).toBeUndefined();
    expect(entriesOf(null)).toEqual([]);
  });

  it('pretty-prints JSON outputs and leaves other text alone', () => {
    expect(outputView('{"a":1,"b":[2]}')).toEqual({
      kind: 'json',
      text: '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}',
    });
    expect(outputView('  [1, 2]  ').kind).toBe('json');
    expect(outputView('# Title\n\ntext')).toEqual({ kind: 'markdown', text: '# Title\n\ntext' });
    expect(outputView('{not json')).toEqual({ kind: 'markdown', text: '{not json' });
    expect(outputView('')).toEqual({ kind: 'markdown', text: '' });
  });
});

describe('JSON output keeps every value as stored', () => {
  /** The tokens of a JSON text with all whitespace outside strings dropped: what "unchanged" means. */
  const tokens = (text: string): string => (text.match(/"(?:[^"\\]|\\.)*"|[^\s"]/g) ?? []).join('');

  it('keeps big integers, exponents that overflow, trailing zeros and negative zero', () => {
    const input = '{"id": 12345678901234567890, "big": 1e999, "price": 1.50, "z": -0, "e": 1E+2}';
    const view = outputView(input);
    expect(view.kind).toBe('json');
    expect(view.text).toContain('12345678901234567890');
    expect(view.text).toContain('1e999');
    expect(view.text).toContain('1.50');
    expect(view.text).toContain('-0');
    expect(view.text).toContain('1E+2');
    expect(tokens(view.text)).toBe(tokens(input));
  });

  it('keeps duplicate keys, key order and escapes inside strings', () => {
    const input = '{"a":1,"a":2,"s":"x, {y}: [z] \\"q\\" \\\\ \\u00e9  spaced","b":"\\n"}';
    const view = outputView(input);
    expect(view.text.split('\n').filter((line) => line.includes('"a"'))).toHaveLength(2);
    expect(view.text).toContain('"x, {y}: [z] \\"q\\" \\\\ \\u00e9  spaced"');
    expect(tokens(view.text)).toBe(tokens(input));
  });

  it('indents objects and arrays, and keeps empty ones compact', () => {
    expect(prettyJson('{"a":[],"b":{},"c":[{"d":null},true,"x"]}')).toBe(
      [
        '{',
        '  "a": [],',
        '  "b": {},',
        '  "c": [',
        '    {',
        '      "d": null',
        '    },',
        '    true,',
        '    "x"',
        '  ]',
        '}',
      ].join('\n'),
    );
    expect(prettyJson('[ ]')).toBe('[]');
    expect(prettyJson('  {  }  ')).toBe('{}');
    expect(prettyJson('"just a string"')).toBe('"just a string"');
    expect(prettyJson('12345678901234567890')).toBe('12345678901234567890');
  });

  it('shows text that is too deeply nested as stored', () => {
    const deep = '['.repeat(100) + ']'.repeat(100);
    expect(prettyJson(deep)).toBe(deep);
    expect(outputView(deep)).toEqual({ kind: 'json', text: deep });
  });

  it('a top-level scalar is not treated as JSON output', () => {
    expect(outputView('42')).toEqual({ kind: 'markdown', text: '42' });
  });
});

describe('deleting runs', () => {
  it('never deletes a run in progress, and says how many it kept', () => {
    const runs = [
      run('a', 3, { status: 'ok' }),
      run('b', 2, { status: 'running' }),
      run('c', 1, { status: 'error' }),
      run('d', 0, { status: 'aborted' }),
    ];
    const { deletable, running } = splitDeletable(runs);
    expect(deletable.map((r) => r.id)).toEqual(['a', 'c', 'd']);
    expect(running.map((r) => r.id)).toEqual(['b']);
    expect(splitDeletable([])).toEqual({ deletable: [], running: [] });
  });
});

describe('models of the runs', () => {
  it('lists the primary and every other model, once each, sorted', () => {
    const runs = [
      run('a', 3, { model: 'openrouter/free', models: ['openrouter/free'] }),
      run('b', 2, { model: 'x/one', models: ['x/one', 'y/two:free', 'x/one'] }),
      run('c', 1, { model: 'x/one', models: [] }),
    ];
    expect(modelsOf(runs)).toEqual(['openrouter/free', 'x/one', 'y/two:free']);
    expect(modelsOf([])).toEqual([]);
  });

  it('skips empty ids', () => {
    expect(modelsOf([run('a', 1, { model: '', models: ['', 'x/y'] })])).toEqual(['x/y']);
  });
});
