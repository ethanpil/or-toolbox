import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatUsd } from '.';
import type { BudgetMode, BudgetSettings, CoreServices, RunRecord } from '../types';
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
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'confirm' }),
      expect.objectContaining({ model: 'm/paid' }),
    );
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
