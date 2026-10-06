import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatUsd } from '.';
import type { BudgetCheck, BudgetMode, BudgetSettings, CoreServices, RunRecord } from '../types';
import { BudgetBlockedError, RunCancelledError } from '../errors';
import { getDb } from '../storage/db';
import { recordRunStats } from '../stats';
import { createTestCore, fakeKey, isolateChannels, resetDb } from '../testing/state-fakes';

let core: CoreServices;

/** Books `costUsd` of spend this month on a key. */
async function spend(keyId: string, costUsd: number): Promise<void> {
  const now = Date.now();
  const run = {
    id: crypto.randomUUID(),
    tool: 'chat',
    status: 'ok',
    model: 'm/paid',
    models: ['m/paid'],
    keyId,
    finishedAt: now,
    usage: {
      byModel: {
        'm/paid': { requests: 1, promptTokens: 0, completionTokens: 0, costUsd, latencyMsTotal: 0 },
      },
    },
  } as unknown as RunRecord;
  await recordRunStats(run, () => false);
}

function setBudgets(patch: Partial<BudgetSettings>): void {
  core.settings.update((draft) => {
    draft.budgets = { ...draft.budgets, ...patch };
  });
}

beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
  core = createTestCore({
    keys: [fakeKey({ id: 'k1', name: 'Work' }), fakeKey({ id: 'k2', name: 'Sandbox' })],
  }).core;
});
afterEach(() => vi.restoreAllMocks());

describe('formatUsd', () => {
  it('shows cents, and two significant digits below a cent', () => {
    expect(formatUsd(0.18)).toBe('$0.18');
    expect(formatUsd(0.1)).toBe('$0.10');
    expect(formatUsd(12.5)).toBe('$12.50');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(0.00045)).toBe('$0.00045');
  });
});

describe('budget rules × modes', () => {
  type Rule = 'per-run' | 'monthly' | 'key-monthly';
  type Expect = Record<BudgetMode, 'ok' | 'confirm' | 'block'>;

  /** Sets up a situation where exactly one rule is exceeded. */
  const exceed: Record<Rule, () => Promise<number>> = {
    'per-run': () => Promise.resolve(0.18),
    monthly: async () => {
      setBudgets({ monthlyUsd: 5 });
      await spend('k2', 4.95);
      return 0.08;
    },
    'key-monthly': async () => {
      setBudgets({ perKeyMonthlyUsd: { k1: 1 } });
      await spend('k1', 0.97);
      await spend('k2', 50); // another key's spend does not count
      return 0.05;
    },
  };

  const table: [Rule, Expect][] = [
    ['per-run', { disabled: 'ok', warn: 'confirm', hard: 'confirm' }],
    ['monthly', { disabled: 'ok', warn: 'confirm', hard: 'block' }],
    ['key-monthly', { disabled: 'ok', warn: 'confirm', hard: 'block' }],
  ];

  for (const [rule, expected] of table) {
    for (const mode of ['disabled', 'warn', 'hard'] as const) {
      it(`${mode}: ${rule} exceeded → ${expected[mode]}`, async () => {
        const estimate = await exceed[rule]();
        setBudgets({ mode });
        const check = await core.budgets.check({ keyId: 'k1', estimateUsd: estimate });
        expect(check.verdict).toBe(expected[mode]);
        if (mode === 'disabled') expect(check.reasons).toEqual([]);
        else expect(check.reasons.map((r) => r.kind)).toEqual([rule]);
      });

      it(`${mode}: ${rule} within limits → ok`, async () => {
        await exceed[rule]();
        setBudgets({ mode });
        const check = await core.budgets.check({ keyId: 'k1', estimateUsd: 0.01 });
        expect(check).toEqual({ verdict: 'ok', reasons: [] });
      });
    }
  }

  it('hard mode blocks when a monthly rule and the per-run rule are both exceeded', async () => {
    setBudgets({ mode: 'hard', monthlyUsd: 1 });
    await spend('k1', 0.95);
    const check = await core.budgets.check({ keyId: 'k1', estimateUsd: 0.2 });
    expect(check.verdict).toBe('block');
    expect(check.reasons.map((r) => r.kind)).toEqual(['per-run', 'monthly']);
  });
});

describe('budget details', () => {
  it('writes specific messages with limits and projections', async () => {
    setBudgets({ monthlyUsd: 5, perKeyMonthlyUsd: { k1: 1 } });
    await spend('k1', 0.9);
    await spend('k2', 4);
    const check = await core.budgets.check({ keyId: 'k1', estimateUsd: 0.18 });
    expect(check.reasons).toEqual([
      {
        kind: 'per-run',
        limitUsd: 0.1,
        projectedUsd: 0.18,
        message: 'This run is estimated at $0.18, above your $0.10 per-run limit.',
      },
      {
        kind: 'monthly',
        limitUsd: 5,
        projectedUsd: expect.closeTo(5.08) as number,
        message:
          "This run would bring this month's spend to $5.08, above your $5.00 monthly limit.",
      },
      {
        kind: 'key-monthly',
        limitUsd: 1,
        projectedUsd: expect.closeTo(1.08) as number,
        message:
          "This run would bring this month's spend on the key “Work” to $1.08, above its $1.00 monthly limit.",
      },
    ]);
  });

  it('skips the per-run rule without an estimate, but still enforces a used-up monthly limit', async () => {
    setBudgets({ mode: 'hard', monthlyUsd: 2 });
    expect((await core.budgets.check({ keyId: 'k1', estimateUsd: null })).verdict).toBe('ok');
    await spend('k1', 2);
    const check = await core.budgets.check({ keyId: 'k1', estimateUsd: null });
    expect(check.verdict).toBe('block');
    expect(check.reasons[0]?.message).toBe(
      'You have spent $2.00 this month, which reaches your $2.00 monthly limit.',
    );
  });

  it('ignores spend from previous months', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.UTC(2026, 8, 20));
      await spend('k1', 10);
      vi.setSystemTime(Date.UTC(2026, 9, 2));
      setBudgets({ mode: 'hard', monthlyUsd: 5 });
      expect((await core.budgets.check({ keyId: 'k1', estimateUsd: 0.05 })).verdict).toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a null per-key limit as no limit', async () => {
    setBudgets({ mode: 'hard', perKeyMonthlyUsd: { k1: null } });
    await spend('k1', 100);
    expect((await core.budgets.check({ keyId: 'k1', estimateUsd: 0.05 })).verdict).toBe('ok');
  });
});

describe('runs.begin applies the verdict', () => {
  const spec = { tool: 'chat', model: 'm/paid', prompt: 'hi', estimateUsd: 0.5 } as const;

  it('asks the confirm handler and proceeds when accepted', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    core.runs.setConfirmHandler(confirm);
    const run = await core.runs.begin(spec);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'confirm' }), {
      kind: 'run',
      spec: expect.objectContaining({ model: 'm/paid' }) as unknown,
    });
    expect(run.keyId).toBe('k1');
  });

  it('throws RunCancelledError and records nothing when the user declines', async () => {
    core.runs.setConfirmHandler(() => Promise.resolve(false));
    await expect(core.runs.begin(spec)).rejects.toBeInstanceOf(RunCancelledError);
    expect(await (await getDb()).count('runs')).toBe(0);
    expect(await core.prompts.list('chat', 'recent')).toEqual([]);
  });

  it('allows a confirm verdict when no handler is registered', async () => {
    await expect(core.runs.begin(spec)).resolves.toMatchObject({ tool: 'chat' });
  });

  it('throws BudgetBlockedError in hard mode, even with a handler that would accept', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    core.runs.setConfirmHandler(confirm);
    setBudgets({ mode: 'hard', monthlyUsd: 0.2 });
    const error = (await core.runs.begin(spec).catch((e: unknown) => e)) as BudgetBlockedError;
    expect(error).toBeInstanceOf(BudgetBlockedError);
    expect(error.check.verdict).toBe('block');
    expect(error.message).toContain('$0.20 monthly limit');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('checks the per-key limit of the key the run resolves to', async () => {
    setBudgets({ mode: 'hard', perKeyMonthlyUsd: { k2: 0.1 } });
    await expect(core.runs.begin({ ...spec, estimateUsd: 0.05 })).resolves.toBeDefined();
    await expect(
      core.runs.begin({ ...spec, estimateUsd: 0.05, keyId: 'k2' }),
    ).resolves.toBeDefined();
    await spend('k2', 0.1);
    await expect(core.runs.begin({ ...spec, estimateUsd: 0.05, keyId: 'k2' })).rejects.toThrow(
      BudgetBlockedError,
    );
  });
});

describe('reservations of running runs', () => {
  const arena = { tool: 'model-arena', model: 'm/paid', prompt: 'which is best?' } as const;

  it('parallel runs each see the others', async () => {
    setBudgets({ mode: 'hard', monthlyUsd: 0.25 });
    const results = await Promise.allSettled(
      [1, 2, 3, 4].map(() => core.runs.begin({ ...arena, estimateUsd: 0.08 })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const [rejected] = results.filter((r) => r.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(BudgetBlockedError);
  });

  it('counts runs that are still running in another tab', async () => {
    setBudgets({ mode: 'hard', monthlyUsd: 0.25 });
    const otherTab = createTestCore({ keys: [fakeKey({ id: 'k1' })] }).core;
    await otherTab.runs.begin({ ...arena, estimateUsd: 0.09 });
    await otherTab.runs.begin({ ...arena, estimateUsd: 0.09 });
    await expect(core.runs.begin({ ...arena, estimateUsd: 0.09 })).rejects.toThrow(
      BudgetBlockedError,
    );
    expect(await core.budgets.check({ keyId: 'k1', estimateUsd: 0.08 })).toMatchObject({
      verdict: 'block',
      reasons: [{ kind: 'monthly', projectedUsd: expect.closeTo(0.26) as number }],
    });
  });

  it('reserves before asking, and releases the reservation when declined', async () => {
    let reservedWhileAsking = 0;
    core.runs.setConfirmHandler(async () => {
      const running = await (await getDb()).getAllFromIndex('runs', 'status', 'running');
      reservedWhileAsking = running.reduce((sum, r) => sum + r.reservedUsd, 0);
      return false;
    });
    await expect(core.runs.begin({ ...arena, estimateUsd: 0.5 })).rejects.toBeInstanceOf(
      RunCancelledError,
    );
    expect(reservedWhileAsking).toBe(0.5);
    expect(await (await getDb()).count('runs')).toBe(0);
    expect(core.runs.active()).toEqual([]);
  });

  it('frees the reservation when the run finishes with its actual cost', async () => {
    setBudgets({ mode: 'hard', monthlyUsd: 0.25 });
    const first = await core.runs.begin({ ...arena, estimateUsd: 0.09 });
    await core.runs.begin({ ...arena, estimateUsd: 0.09 });
    await first.finish(); // cost 0: the 0.09 reservation goes away
    await expect(core.runs.begin({ ...arena, estimateUsd: 0.09 })).resolves.toBeDefined();
  });
});

describe('group approvals', () => {
  const sequence = {
    tool: 'video-studio',
    groupId: 'seq-1',
    label: 'Video sequence: 3 clips',
    models: ['m/paid'],
    runs: 3,
    estimateUsd: 0.45,
  } as const;
  const step = {
    tool: 'video-studio',
    model: 'm/paid',
    estimateUsd: 0.15,
    groupId: 'seq-1',
    useGroupApproval: true,
  } as const;
  const approval = async (groupId = 'seq-1') =>
    (await (await getDb()).get('kv', `meta:group-approval:${groupId}`))?.value;
  const reserved = async (id: string) => (await (await getDb()).get('runs', id))?.reservedUsd;

  it('checks the total once, asks once naming the group, and its runs then ask nothing', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    core.runs.setConfirmHandler(confirm);
    await core.runs.approveGroup(sequence);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(
      {
        verdict: 'confirm',
        reasons: [
          expect.objectContaining({
            kind: 'per-run',
            projectedUsd: 0.45,
            message: 'These runs are estimated at $0.45 together, above your $0.10 per-run limit.',
          }),
        ],
      },
      {
        kind: 'group',
        group: expect.objectContaining({ label: 'Video sequence: 3 clips' }) as unknown,
      },
    );
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await core.runs.begin(step));
    expect(confirm).toHaveBeenCalledOnce();
    // Each still reserves its own estimate.
    for (const run of runs) expect(await reserved(run.id)).toBe(0.15);
  });

  it('a declined or blocked approval stores and reserves nothing; its runs then ask for themselves', async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    core.runs.setConfirmHandler(confirm);
    await expect(core.runs.approveGroup(sequence)).rejects.toBeInstanceOf(RunCancelledError);
    setBudgets({ mode: 'hard', monthlyUsd: 0.4 });
    await expect(core.runs.approveGroup(sequence)).rejects.toBeInstanceOf(BudgetBlockedError);
    expect(await approval()).toBeUndefined();
    expect(await (await getDb()).count('runs')).toBe(0);

    setBudgets({ mode: 'warn', monthlyUsd: null });
    confirm.mockClear();
    await expect(core.runs.begin(step)).rejects.toBeInstanceOf(RunCancelledError);
    expect(confirm).toHaveBeenCalledWith(expect.anything(), {
      kind: 'run',
      spec: expect.objectContaining({ groupId: 'seq-1' }) as unknown,
    });
  });

  it('refuses before asking: no key, a locked key, a paid model or add-on in free-only mode', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    core.runs.setConfirmHandler(confirm);
    core.settings.update((draft) => {
      draft.freeOnly = true;
    });
    await expect(
      core.runs.approveGroup({ ...sequence, models: ['a/b:free', 'm/paid'] }),
    ).rejects.toMatchObject({ code: 'free-only', models: ['m/paid'] });
    await expect(
      core.runs.approveGroup({
        ...sequence,
        models: ['a/b:free'],
        estimateUsd: 0,
        addons: [{ id: 'pdf-engine:mistral-ocr', label: 'Mistral OCR', estimateUsd: 0.06 }],
      }),
    ).rejects.toMatchObject({ code: 'free-only' });
    const locked = createTestCore({ locked: true }).core;
    await expect(locked.runs.approveGroup(sequence)).rejects.toMatchObject({ code: 'locked' });
    const keyless = createTestCore({ keys: [] }).core;
    await expect(keyless.runs.approveGroup(sequence)).rejects.toMatchObject({ code: 'no-key' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('covers its runs up to the approved total and count; a hard block still refuses', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    core.runs.setConfirmHandler(confirm);
    await core.runs.approveGroup({ ...sequence, runs: 2, estimateUsd: 0.3 });
    confirm.mockClear();
    await core.runs.begin(step);
    await core.runs.begin(step);
    expect(confirm).not.toHaveBeenCalled();
    await core.runs.begin(step); // no room left: it asks for itself
    expect(confirm).toHaveBeenCalledOnce();

    await core.runs.approveGroup({ ...sequence, groupId: 'seq-2', estimateUsd: 0.2 });
    confirm.mockClear();
    await core.runs.begin({ ...step, groupId: 'seq-2' });
    await core.runs.begin({ ...step, groupId: 'seq-2' }); // 0.15 + 0.15 > 0.2
    expect(confirm).toHaveBeenCalledOnce();

    // Five runs of 0.15 are still running (0.75 reserved); the third sequence fits the month, then spend arrives.
    setBudgets({ mode: 'hard', monthlyUsd: 2 });
    await core.runs.approveGroup({ ...sequence, groupId: 'seq-3' });
    await spend('k1', 1.2);
    await expect(core.runs.begin({ ...step, groupId: 'seq-3' })).rejects.toBeInstanceOf(
      BudgetBlockedError,
    );
  });

  it('does not cover a re-run outside the approval, another model or another key', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    core.runs.setConfirmHandler(confirm);
    await core.runs.approveGroup(sequence);
    confirm.mockClear();
    await core.runs.begin({ ...step, useGroupApproval: false });
    await core.runs.begin({ ...step, model: 'm/other' });
    await core.runs.begin({ ...step, keyId: 'k2' });
    expect(confirm).toHaveBeenCalledTimes(3);
  });

  it('a run that ends having sent nothing gives its share back', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    core.runs.setConfirmHandler(confirm);
    await core.runs.approveGroup({ ...sequence, runs: 1, estimateUsd: 0.15 });
    confirm.mockClear();
    const first = await core.runs.begin(step);
    await first.fail(new DOMException('Paused.', 'AbortError'));
    await vi.waitFor(async () => expect(await approval()).toMatchObject({ runsLeft: 1 }));
    await core.runs.begin(step);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('holds in other tabs and after a reload, until released', async () => {
    core.runs.setConfirmHandler(() => Promise.resolve(true));
    await core.runs.approveGroup(sequence);
    const otherTab = createTestCore({ keys: [fakeKey({ id: 'k1' })] }).core;
    const confirm = vi.fn().mockResolvedValue(true);
    otherTab.runs.setConfirmHandler(confirm);
    await otherTab.runs.begin(step);
    expect(confirm).not.toHaveBeenCalled();
    await otherTab.runs.releaseGroup('seq-1');
    expect(await approval()).toBeUndefined();
    await core.runs.begin(step).catch(() => undefined);
    await otherTab.runs.begin(step);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('needs no approval for free models: nothing is asked or stored', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    core.runs.setConfirmHandler(confirm);
    setBudgets({ perRunUsd: 0 });
    await core.runs.approveGroup({ ...sequence, models: ['a/b:free'], estimateUsd: 0 });
    expect(confirm).not.toHaveBeenCalled();
    expect(await approval()).toBeUndefined();
  });
});

describe('beginAll', () => {
  const contender = (model: string, estimateUsd: number | null) =>
    ({
      tool: 'model-arena',
      model,
      estimateUsd,
      prompt: 'Which is best?',
      groupId: 'round-1',
    }) as const;

  it('returns the handles in the order of the specs', async () => {
    const models = ['d/four', 'a/one', 'c/three', 'b/two'];
    const runs = await core.runs.beginAll(models.map((model) => contender(model, 0.01)));
    expect(runs.map((run) => run.model)).toEqual(models);
  });

  it('says when part of the total is unknown, and checks the budgets as for an unknown estimate', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    core.runs.setConfirmHandler(confirm);
    const round = [
      contender('a/one', 0.125),
      contender('b/two', 0.125),
      contender('c/three', null),
    ];
    await core.runs.beginAll(round, { label: 'Model arena round: 3 models' });
    expect(confirm.mock.calls[0]![1]).toMatchObject({
      kind: 'group',
      group: { estimateUsd: 0.25, unknownEstimates: 1 },
    });
    expect((confirm.mock.calls[0]![0] as BudgetCheck).reasons[0]?.message).toBe(
      'These runs are estimated at $0.25 together and 1 unknown, above your $0.10 per-run limit.',
    );
    await Promise.all(core.runs.active().map((run) => run.finish()));

    // Hard stop at $1.00 with $0.75 spent: known parts alone reach the limit exactly. With every estimate known
    // the round fits; with one unknown, as for a single unknown estimate, the limit counts as reached.
    setBudgets({ mode: 'hard', monthlyUsd: 1 });
    await spend('k1', 0.75);
    const known = [contender('a/one', 0.125), contender('b/two', 0.125)];
    const begun = await core.runs.beginAll(known, { label: 'Model arena round: 2 models' });
    await Promise.all(begun.map((run) => run.finish()));
    const error = (await core.runs
      .beginAll(round, { label: 'Model arena round: 3 models' })
      .catch((e: unknown) => e)) as BudgetBlockedError;
    expect(error).toBeInstanceOf(BudgetBlockedError);
    expect(error.check.reasons.find((r) => r.kind === 'monthly')?.message).toBe(
      "These runs would bring this month's spend to at least $1.00 (1 unknown), which reaches your $1.00 monthly limit.",
    );
  });

  it('with a label, asks once for the summed total and begins every member without a dialog', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    core.runs.setConfirmHandler(confirm);
    const runs = await core.runs.beginAll(
      [contender('a/one', 0.04), contender('b/two', 0.04), contender('c/three', 0.04)],
      { label: 'Model arena round: 3 models' },
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'confirm' }), {
      kind: 'group',
      group: expect.objectContaining({
        label: 'Model arena round: 3 models',
        models: ['a/one', 'b/two', 'c/three'],
        runs: 3,
        estimateUsd: expect.closeTo(0.12) as number,
      }) as unknown,
    });
    expect(runs.map((run) => run.model)).toEqual(['a/one', 'b/two', 'c/three']);
    const records = await (await getDb()).getAll('runs');
    expect(records.map((r) => [r.groupId, r.reservedUsd])).toEqual([
      ['round-1', 0.04],
      ['round-1', 0.04],
      ['round-1', 0.04],
    ]);
    // The approval served the round only.
    expect(await (await getDb()).get('kv', 'meta:group-approval:round-1')).toBeUndefined();
  });

  it('a refused member withdraws the members already begun: no record, no reservation, no booking', async () => {
    const events: string[] = [];
    for (const type of ['history-changed', 'stats-changed', 'run-finished'] as const) {
      core.bus.on(type, (event) => events.push(event.type));
    }
    setBudgets({ mode: 'hard', monthlyUsd: 0.25 });
    const error = await core.runs
      .beginAll([contender('a/one', 0.1), contender('b/two', 0.1), contender('c/three', 0.1)])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetBlockedError);
    expect(await (await getDb()).count('runs')).toBe(0);
    expect(core.runs.active()).toEqual([]);
    expect(await core.stats.rows({ from: '2000-01-01', to: '2999-12-31' })).toEqual([]);
    expect(await core.prompts.list('model-arena', 'recent')).toEqual([]);
    expect(events).toEqual([]);
    // Nothing is held: the whole round fits again once allowed.
    setBudgets({ monthlyUsd: 0.35 });
    await expect(
      core.runs.beginAll([
        contender('a/one', 0.1),
        contender('b/two', 0.1),
        contender('c/three', 0.1),
      ]),
    ).resolves.toHaveLength(3);
  });

  it('a declined member, or a stop, withdraws the others too', async () => {
    core.runs.setConfirmHandler(() => Promise.resolve(false));
    await expect(
      core.runs.beginAll([contender('a/one', 0.01), contender('b/two', 0.5)]),
    ).rejects.toBeInstanceOf(RunCancelledError);
    expect(await (await getDb()).count('runs')).toBe(0);

    const stop = new AbortController();
    core.runs.setConfirmHandler(() => {
      stop.abort();
      return Promise.resolve(true);
    });
    await expect(
      core.runs.beginAll([contender('a/one', 0.01), contender('b/two', 0.5), contender('c', 0)], {
        signal: stop.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await (await getDb()).count('runs')).toBe(0);
    expect(core.runs.active()).toEqual([]);
  });

  it('aborts its runs when the signal aborts after they began', async () => {
    const stop = new AbortController();
    const runs = await core.runs.beginAll([contender('a/one', 0.01), contender('b/two', 0.01)], {
      signal: stop.signal,
    });
    stop.abort();
    expect(runs.every((run) => run.signal.aborted)).toBe(true);
    await Promise.all(runs.map((run) => run.fail(run.signal.reason)));
  });

  it('aborts its runs when the signal aborted while it announced them (a late Stop is never lost)', async () => {
    const stop = new AbortController();
    // The last await window: after every member began, while the runs are announced.
    const off = core.bus.on('history-changed', () => stop.abort());
    const runs = await core.runs.beginAll([contender('a/one', 0.01), contender('b/two', 0.01)], {
      signal: stop.signal,
      label: 'Model arena round: 2 models',
    });
    off();
    expect(runs.every((run) => run.signal.aborted)).toBe(true);
    await Promise.all(runs.map((run) => run.fail(run.signal.reason)));
    expect(await core.stats.monthSpend()).toBe(0);
  });
});

describe('free runs', () => {
  it('are never blocked or questioned, whatever the spend', async () => {
    setBudgets({ mode: 'hard', monthlyUsd: 1, perRunUsd: 0 });
    await spend('k1', 5);
    const confirm = vi.fn().mockResolvedValue(false);
    core.runs.setConfirmHandler(confirm);
    const free = { tool: 'chat', model: 'a/b:free' } as const;

    await expect(core.runs.begin({ ...free, estimateUsd: 0 })).resolves.toBeDefined();
    await expect(core.runs.begin({ ...free, models: ['openrouter/free'] })).resolves.toBeDefined();
    expect(confirm).not.toHaveBeenCalled();

    await expect(core.runs.begin({ ...free, model: 'm/paid', estimateUsd: 0 })).rejects.toThrow(
      BudgetBlockedError,
    );
    await expect(core.runs.begin({ ...free, models: ['m/paid'], estimateUsd: 0 })).rejects.toThrow(
      BudgetBlockedError,
    );
  });
});

describe('paid add-ons', () => {
  const parser = { id: 'pdf-engine:mistral-ocr', label: 'Mistral OCR', estimateUsd: 0.06 };

  it('count towards the estimate the budgets check and the run reserves', async () => {
    setBudgets({ mode: 'warn', perRunUsd: 0.1 });
    const confirm = vi.fn().mockResolvedValue(true);
    core.runs.setConfirmHandler(confirm);
    const run = await core.runs.begin({
      tool: 'ocr',
      model: 'm/paid',
      estimateUsd: 0.05,
      addons: [parser],
    });
    const [check] = confirm.mock.calls[0] as [
      { reasons: { kind: string; projectedUsd: number }[] },
    ];
    expect(check.reasons[0]?.kind).toBe('per-run');
    expect(check.reasons[0]?.projectedUsd).toBeCloseTo(0.11);
    expect((await (await getDb()).get('runs', run.id))?.reservedUsd).toBeCloseTo(0.11);
    await run.finish();
  });

  it('make a run on a free model go through the budgets', async () => {
    setBudgets({ mode: 'hard', monthlyUsd: 1, perRunUsd: 0 });
    await spend('k1', 5);
    const free = { tool: 'ocr', model: 'a/b:free', estimateUsd: 0 } as const;
    await expect(core.runs.begin({ ...free, addons: [parser] })).rejects.toThrow(
      BudgetBlockedError,
    );
    await expect(
      core.runs.begin({ ...free, addons: [{ ...parser, estimateUsd: 0 }] }),
    ).resolves.toBeDefined();
  });
});

describe('spend reads', () => {
  it('reads the month of stats once per check', async () => {
    setBudgets({ monthlyUsd: 5, perKeyMonthlyUsd: { k1: 1 } });
    await spend('k1', 0.5);
    const rows = vi.spyOn(core.stats, 'rows');
    const monthSpend = vi.spyOn(core.stats, 'monthSpend');
    await core.budgets.check({ keyId: 'k1', estimateUsd: 0.01 });
    expect(rows).toHaveBeenCalledOnce();
    expect(monthSpend).not.toHaveBeenCalled();
  });

  it.each(['warn', 'hard'] as const)(
    'asks for confirmation in %s mode when the spend cannot be read',
    async (mode) => {
      setBudgets({ mode, monthlyUsd: 5 });
      vi.spyOn(core.stats, 'rows').mockRejectedValue(new Error('IndexedDB is broken'));
      const check = await core.budgets.check({ keyId: 'k1', estimateUsd: 0.01 });
      expect(check.verdict).toBe('confirm');
      expect(check.reasons[0]?.message).toBe(
        "This month's spend could not be read, so your monthly limits cannot be checked.",
      );
    },
  );

  it("reads running runs' holds, never their records and outputs", async () => {
    setBudgets({ monthlyUsd: 5, perKeyMonthlyUsd: { k1: 1 }, perRunUsd: 10 });
    const run = await core.runs.begin({ tool: 'chat', model: 'm/paid', estimateUsd: 0.3 });
    run.addUsage({
      model: 'm/paid',
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 0.4,
      costEstimated: false,
      latencyMs: 1,
    });
    await run.checkpoint({ output: 'x'.repeat(400_000) });
    const db = await getDb();
    const indexGetAll = vi.spyOn(IDBIndex.prototype, 'getAll');
    const get = vi.spyOn(IDBObjectStore.prototype, 'get');
    const check = await core.budgets.check({ keyId: 'k1', estimateUsd: 0.7 });
    const readRuns = [
      ...indexGetAll.mock.contexts.map((index) => (index as IDBIndex).objectStore.name),
      ...get.mock.contexts.map((store) => (store as IDBObjectStore).name),
    ].filter((name) => name === 'runs');
    expect(readRuns).toEqual([]);
    // The hold is max(reservation, spend): 0.4 + 0.7 passes the $1 key limit.
    expect(check.reasons.map((reason) => reason.kind)).toEqual(['key-monthly']);
    await run.finish();
    expect(await db.get('kv', `meta:run-hold:${run.id}`)).toBeUndefined();
  });

  it('does not read spend at all without monthly limits', async () => {
    const rows = vi.spyOn(core.stats, 'rows').mockRejectedValue(new Error('broken'));
    expect((await core.budgets.check({ keyId: 'k1', estimateUsd: 0.01 })).verdict).toBe('ok');
    expect(rows).not.toHaveBeenCalled();
  });
});

describe('monthSpend (the Settings meters)', () => {
  it('reads the month once for the total and every key, and counts what running runs hold', async () => {
    await spend('k1', 0.5);
    await spend('k2', 0.25);
    const db = await getDb();
    const row = (await db.getAll('stats')).find((r) => r.keyId === 'k1');
    await db.put('stats', { ...row!, estimatedUsd: 0.2 }); // 0.2 of k1's 0.5 is an estimate
    await core.runs.begin({ tool: 'chat', model: 'm/paid', estimateUsd: 0.3 });

    const rows = vi.spyOn(core.stats, 'rows');
    const month = await core.budgets.monthSpend();
    expect(rows).toHaveBeenCalledOnce();

    expect(month.usd).toBeCloseTo(1.05);
    expect(month.heldUsd).toBeCloseTo(0.3);
    expect(month.estimatedUsd).toBeCloseTo(0.5); // 0.2 estimated cost + 0.3 reserved for the run going now
    expect(month.byKey.get('k1')).toEqual({
      usd: expect.closeTo(0.8) as number,
      estimatedUsd: expect.closeTo(0.5) as number,
    });
    expect(month.byKey.get('k2')).toEqual({ usd: 0.25, estimatedUsd: 0 });
  });

  it('never shows room that a check would refuse', async () => {
    setBudgets({ mode: 'hard', monthlyUsd: 1, perRunUsd: 10 });
    await spend('k1', 0.5);
    await core.runs.begin({ tool: 'chat', model: 'm/paid', estimateUsd: 0.45 });
    const { usd } = await core.budgets.monthSpend();
    expect(usd).toBeCloseTo(0.95); // $0.05 left, as a meter would say
    expect((await core.budgets.check({ keyId: 'k1', estimateUsd: 0.04 })).verdict).toBe('ok');
    expect((await core.budgets.check({ keyId: 'k1', estimateUsd: 0.06 })).verdict).toBe('block');
  });

  it('is zero in an empty month', async () => {
    expect(await core.budgets.monthSpend()).toEqual({
      usd: 0,
      estimatedUsd: 0,
      heldUsd: 0,
      byKey: new Map(),
    });
  });
});
