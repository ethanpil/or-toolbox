import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECKPOINT_INTERVAL_MS, OUTPUT_CAP, excerpt } from '.';
import type { BusEvent, CoreServices, RunHandle, RunRecord, RunSpec, Usage } from '../types';
import { ApiError, FreeOnlyError, KeyLockedError, NoKeyError } from '../errors';
import { getDb } from '../storage/db';
import {
  createTestCore,
  isolateChannels,
  resetDb,
  settle,
  until,
  type KeyState,
} from '../testing/state-fakes';

let core: CoreServices;
let keyState: KeyState;
let events: BusEvent[];

const spec: RunSpec = {
  tool: 'chat',
  model: 'openai/gpt-x',
  prompt: 'Summarise   the\nquarterly report',
  settings: { temperature: 0.2 },
};

function usage(partial: Partial<Usage> = {}): Usage {
  return {
    model: 'openai/gpt-x',
    promptTokens: 100,
    completionTokens: 50,
    costUsd: 0.002,
    costEstimated: false,
    latencyMs: 400,
    ...partial,
  };
}

const stored = async (id: string): Promise<RunRecord | undefined> =>
  (await getDb()).get('runs', id);

beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
  ({ core, keyState } = createTestCore());
  events = [];
  for (const type of ['history-changed', 'run-finished', 'stats-changed'] as const) {
    core.bus.on(type, (event) => events.push(event));
  }
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  // Finish leftovers so a later pagehide in this file cannot reach them.
  await Promise.all(core.runs.active().map((run) => run.fail(new Error('test over'))));
});

describe('excerpt', () => {
  it('collapses whitespace and cuts long text at a word boundary', () => {
    expect(excerpt('  a \n b  ')).toBe('a b');
    const long = 'word '.repeat(40);
    const title = excerpt(long);
    expect(title.length).toBeLessThanOrEqual(81);
    expect(title.endsWith('word…')).toBe(true);
    expect(excerpt('x'.repeat(100))).toBe(`${'x'.repeat(80)}…`);
  });
});

describe('begin: gatekeeping order', () => {
  it('throws NoKeyError first', async () => {
    keyState.keys = [];
    keyState.locked = true;
    await expect(core.runs.begin(spec)).rejects.toBeInstanceOf(NoKeyError);
  });

  it('throws KeyLockedError before the free-only check', async () => {
    keyState.locked = true;
    core.settings.update((d) => {
      d.freeOnly = true;
    });
    await expect(core.runs.begin(spec)).rejects.toBeInstanceOf(KeyLockedError);
  });

  it('checks free-only mode on every model of the run', async () => {
    core.settings.update((d) => {
      d.freeOnly = true;
    });
    const error = (await core.runs
      .begin({ ...spec, model: 'a/free:free', models: ['a/free:free', 'b/paid', 'c/paid'] })
      .catch((e: unknown) => e)) as FreeOnlyError;
    expect(error).toBeInstanceOf(FreeOnlyError);
    expect(error.models).toEqual(['b/paid', 'c/paid']);
    await expect(
      core.runs.begin({ ...spec, model: 'a/free:free', models: ['openrouter/free'] }),
    ).resolves.toBeDefined();
  });

  it('does not write anything when a check fails', async () => {
    keyState.locked = true;
    await expect(core.runs.begin(spec)).rejects.toThrow();
    expect(await (await getDb()).count('runs')).toBe(0);
    expect(core.settings.get().models.recent).toEqual([]);
    expect(events).toEqual([]);
  });

  it('uses the key override, then the tool binding', async () => {
    keyState.keys.push({ ...keyState.keys[0]!, id: 'k2', name: 'Sandbox' });
    core.settings.update((d) => {
      d.tools.chat = { keyId: 'k2' };
    });
    expect((await core.runs.begin(spec)).keyId).toBe('k2');
    expect((await core.runs.begin({ ...spec, keyId: 'k1' })).keyId).toBe('k1');
  });
});

describe('begin: bookkeeping', () => {
  it('creates a running record with an excerpt title and announces it', async () => {
    const run = await core.runs.begin({ ...spec, groupId: 'g1' });
    expect(await stored(run.id)).toEqual<RunRecord>({
      id: run.id,
      tool: 'chat',
      status: 'running',
      model: 'openai/gpt-x',
      models: ['openai/gpt-x'],
      keyId: 'k1',
      keyName: 'Work',
      startedAt: expect.any(Number) as number,
      finishedAt: null,
      latencyMs: null,
      title: 'Summarise the quarterly report',
      prompt: spec.prompt!,
      settings: { temperature: 0.2 },
      output: null,
      error: null,
      usage: {
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        latencyMsTotal: 0,
        costEstimated: false,
        byModel: {},
      },
      meta: {},
      starred: false,
      groupId: 'g1',
    });
    expect(events).toEqual([{ type: 'history-changed', ids: [run.id] }]);
    expect(core.runs.active()).toEqual([run]);
  });

  it('prefers a given title, and falls back to the tool name without a prompt', async () => {
    const titled = await core.runs.begin({ ...spec, title: '  Arena: round 1 ' });
    expect((await stored(titled.id))?.title).toBe('Arena: round 1');
    const blank = await core.runs.begin({ tool: 'image-generation', model: 'm', prompt: '  ' });
    expect((await stored(blank.id))?.title).toBe('Image generation');
  });

  it('adds the prompt to Recent with the tool settings', async () => {
    await core.runs.begin(spec);
    const recent = await core.prompts.list('chat', 'recent');
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ text: spec.prompt, settings: { temperature: 0.2 } });
  });

  it('skips Recent when recording is off', async () => {
    core.settings.update((d) => {
      d.data.recordRecentPrompts = false;
    });
    await core.runs.begin(spec);
    expect(await core.prompts.list('chat', 'recent')).toEqual([]);
  });

  it('keeps recent models unique, most recent first, capped at 20', async () => {
    core.settings.update((d) => {
      d.models.recent = Array.from({ length: 20 }, (_, i) => `m/${i}`);
    });
    await core.runs.begin({ ...spec, model: 'm/5', models: ['m/new'] });
    const recent = core.settings.get().models.recent;
    expect(recent.slice(0, 3)).toEqual(['m/5', 'm/new', 'm/0']);
    expect(recent).toHaveLength(20);
    expect(new Set(recent).size).toBe(20);
  });

  it('gives parallel runs distinct start times', async () => {
    const runs = await Promise.all([1, 2, 3].map(() => core.runs.begin(spec)));
    const starts = await Promise.all(runs.map(async (r) => (await stored(r.id))?.startedAt));
    expect(new Set(starts).size).toBe(3);
  });
});

describe('handle: usage', () => {
  it('totals usage overall and by model, with a sticky costEstimated flag', async () => {
    const run = await core.runs.begin(spec);
    const seen: number[] = [];
    const off = run.onUsage((t) => seen.push(t.requests));
    run.addUsage(usage());
    run.addUsage(usage({ model: 'other/m', costUsd: 0.01, costEstimated: true }));
    off();
    run.addUsage(usage());

    expect(seen).toEqual([1, 2]);
    expect(run.totals).toEqual({
      requests: 3,
      promptTokens: 300,
      completionTokens: 150,
      costUsd: expect.closeTo(0.014) as number,
      latencyMsTotal: 1200,
      costEstimated: true,
      byModel: {
        'openai/gpt-x': {
          requests: 2,
          promptTokens: 200,
          completionTokens: 100,
          costUsd: 0.004,
          latencyMsTotal: 800,
        },
        'other/m': {
          requests: 1,
          promptTokens: 100,
          completionTokens: 50,
          costUsd: 0.01,
          latencyMsTotal: 400,
        },
      },
    });
  });

  it('returns a copy of the totals', async () => {
    const run = await core.runs.begin(spec);
    run.totals.requests = 99;
    expect(run.totals.requests).toBe(0);
  });
});

describe('handle: checkpoints', () => {
  it('writes at most once per interval, keeping the latest partial output', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const run = await core.runs.begin(spec);

    await run.checkpoint({ output: 'a' });
    expect((await stored(run.id))?.output).toBe('a');

    const second = run.checkpoint({ output: 'ab' });
    const third = run.checkpoint({ output: 'abc', meta: { turns: 3 } });
    expect(third).toBe(second);
    await settle();
    expect((await stored(run.id))?.output).toBe('a');

    await vi.advanceTimersByTimeAsync(CHECKPOINT_INTERVAL_MS);
    await third;
    const record = await stored(run.id);
    expect(record?.output).toBe('abc');
    expect(record?.meta).toEqual({ turns: 3 });
    expect(record?.status).toBe('running');
  });

  it('settles a pending checkpoint with the final write', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const run = await core.runs.begin(spec);
    await run.checkpoint({ output: 'a' });
    const pending = run.checkpoint({ output: 'partial' });
    const record = await run.finish({ output: 'done' });
    await pending;
    expect(record.output).toBe('done');
    await vi.advanceTimersByTimeAsync(CHECKPOINT_INTERVAL_MS * 2);
    await settle();
    expect((await stored(run.id))?.output).toBe('done');
  });

  it('keeps checkpointed output when finish has none', async () => {
    const run = await core.runs.begin(spec);
    await run.checkpoint({ output: 'transcript so far', meta: { a: 1 } });
    const record = await run.finish({ meta: { b: 2 } });
    expect(record.output).toBe('transcript so far');
    expect(record.meta).toEqual({ a: 1, b: 2 });
  });
});

describe('handle: finish and fail', () => {
  it('writes the final record, rolls up stats and announces the result', async () => {
    const run = await core.runs.begin(spec);
    run.addUsage(usage());
    events.length = 0;
    const record = await run.finish({ output: 'Report summary', meta: { pages: 3 } });

    expect(record).toMatchObject({
      status: 'ok',
      output: 'Report summary',
      error: null,
      meta: { pages: 3 },
      usage: { requests: 1, costUsd: 0.002 },
    });
    expect(record.finishedAt).toBeGreaterThanOrEqual(record.startedAt);
    expect(record.latencyMs).toBe(record.finishedAt! - record.startedAt);
    expect(await stored(run.id)).toEqual(record);
    expect(events).toEqual([
      { type: 'stats-changed' },
      { type: 'history-changed', ids: [run.id] },
      { type: 'run-finished', id: run.id, tool: 'chat', status: 'ok' },
    ]);
    expect(await core.stats.monthSpend()).toBeCloseTo(0.002);
    expect(core.runs.active()).toEqual([]);
  });

  it('is idempotent across finish and fail', async () => {
    const run = await core.runs.begin(spec);
    const first = run.finish({ output: 'one' });
    const second = run.finish({ output: 'two' });
    const third = run.fail(new Error('late'));
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect((await first).output).toBe('one');
    run.addUsage(usage());
    expect(run.totals.requests).toBe(0);
    expect(await core.stats.modelSummary('openai/gpt-x')).toMatchObject({ runs: 1 });
  });

  it('records AbortError as aborted', async () => {
    const run = await core.runs.begin(spec);
    const record = await run.fail(new DOMException('stop', 'AbortError'));
    expect(record).toMatchObject({ status: 'aborted', error: null });
  });

  it('aborts its signal with an AbortError and records the reason', async () => {
    const run = await core.runs.begin(spec);
    run.abort('Stopped by budget');
    expect(run.signal.aborted).toBe(true);
    expect((run.signal.reason as DOMException).name).toBe('AbortError');
    const record = await run.fail(run.signal.reason);
    expect(record).toMatchObject({ status: 'aborted', error: 'Stopped by budget' });
  });

  it('records other errors with a user-safe message', async () => {
    const run = await core.runs.begin(spec);
    const record = await run.fail(new ApiError('Unauthorized', 401));
    expect(record).toMatchObject({
      status: 'error',
      error: 'OpenRouter rejected the key. Check it in Settings → Keys.',
    });
    expect((await core.stats.rows({ from: '2000-01-01', to: '2999-12-31' }))[0]).toMatchObject({
      errors: 1,
      runs: 1,
    });
  });

  it('caps the output at 500 000 characters', async () => {
    const run = await core.runs.begin(spec);
    const record = await run.finish({ output: 'x'.repeat(OUTPUT_CAP + 10) });
    expect(record.output).toHaveLength(OUTPUT_CAP);
    expect(record.meta).toMatchObject({ outputTruncated: true });
  });

  it('keeps a star set while the run was going', async () => {
    const run = await core.runs.begin(spec);
    await core.history.setStarred(run.id, true);
    expect((await run.finish()).starred).toBe(true);
  });

  it('does not recreate a run deleted while running, but still counts its spend', async () => {
    const run = await core.runs.begin(spec);
    run.addUsage(usage({ costUsd: 0.5 }));
    await core.history.remove([run.id]);
    await run.checkpoint({ output: 'x' });
    await run.finish();
    expect(await stored(run.id)).toBeUndefined();
    expect(await core.stats.monthSpend()).toBeCloseTo(0.5);
  });
});

describe('page unload and reattach', () => {
  it('aborts active runs on pagehide and records them as aborted', async () => {
    const run = await core.runs.begin(spec);
    window.dispatchEvent(new Event('pagehide'));
    expect(run.signal.aborted).toBe(true);
    await until(async () => (await stored(run.id))?.status === 'aborted');
    expect((await stored(run.id))?.error).toBe('The page was closed.');
  });

  it('leaves a run with an open job running so it can be reattached', async () => {
    const run = await core.runs.begin({ ...spec, tool: 'video-studio' });
    await core.jobs.add({
      tool: 'video-studio',
      type: 'video',
      payload: {},
      keyId: 'k1',
      runId: run.id,
    });
    window.dispatchEvent(new Event('pagehide'));
    expect(run.signal.aborted).toBe(true);
    await settle(200);
    expect((await stored(run.id))?.status).toBe('running');
  });

  it('reattaches a running record in a new page and finishes it', async () => {
    const first = await core.runs.begin(spec);
    first.addUsage(usage());
    await first.checkpoint({ output: 'part', meta: { videoJobIds: ['j1'] } });

    const reloaded = createTestCore().core; // a new page on the same database
    const handle = (await reloaded.runs.reattach(first.id)) as RunHandle;
    expect(handle).not.toBeNull();
    expect(handle).toMatchObject({ id: first.id, tool: 'chat', keyId: 'k1' });
    expect(handle.totals.requests).toBe(1);
    expect(await reloaded.runs.reattach(first.id)).toBe(handle);
    expect(reloaded.runs.active()).toEqual([handle]);

    handle.addUsage(usage({ costUsd: 0.3 }));
    const record = await handle.finish({ meta: { done: true } });
    expect(record).toMatchObject({
      status: 'ok',
      output: 'part',
      meta: { videoJobIds: ['j1'], done: true },
      usage: { requests: 2 },
    });
  });

  it('returns null for unknown or finished runs', async () => {
    expect(await core.runs.reattach('nope')).toBeNull();
    const run = await core.runs.begin(spec);
    await run.finish();
    expect(await createTestCore().core.runs.reattach(run.id)).toBeNull();
  });
});
