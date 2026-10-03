import { describe, expect, it } from 'vitest';
import { ApiError, BudgetBlockedError, NetworkError } from '../../core/errors';
import { wasPresented } from '../feedback/errors';
import { batchSummary, batchTitle, isFatalError, runItems, type ItemStatus } from './batch';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('runItems', () => {
  it('runs at most `concurrency` items at once, in order, and reports each status', async () => {
    let running = 0;
    let peak = 0;
    const log: string[] = [];
    const result = await runItems({
      items: ['a', 'b', 'c', 'd'],
      concurrency: 2,
      signal: new AbortController().signal,
      work: async (item) => {
        running++;
        peak = Math.max(peak, running);
        await tick();
        running--;
        return item.toUpperCase();
      },
      onItem: (outcome, index) => log.push(`${index}:${outcome.status}`),
    });
    expect(peak).toBe(2);
    expect(result.outcomes.map((o) => [o.status, o.value])).toEqual([
      ['done', 'A'],
      ['done', 'B'],
      ['done', 'C'],
      ['done', 'D'],
    ]);
    expect(log.slice(0, 2)).toEqual(['0:running', '1:running']);
    expect(log.filter((entry) => entry.endsWith('done'))).toHaveLength(4);
    expect(result).toMatchObject({ done: 4, failed: 0, stopped: 0 });
  });

  it('keeps going after an item fails', async () => {
    const result = await runItems({
      items: [1, 2, 3],
      concurrency: 1,
      signal: new AbortController().signal,
      work: (n) => (n === 2 ? Promise.reject(new NetworkError()) : Promise.resolve(n)),
    });
    expect(result.outcomes.map((o) => o.status)).toEqual(['done', 'failed', 'done']);
    expect(result.outcomes[1]?.error).toBeInstanceOf(NetworkError);
    expect(result).toMatchObject({ done: 2, failed: 1, stopped: 0 });
  });

  it('stops scheduling after a fatal error and rethrows it, unmarked', async () => {
    const fatal = new ApiError('Insufficient credits', 402);
    const error = await runItems({
      items: [1, 2, 3],
      concurrency: 1,
      signal: new AbortController().signal,
      work: (n) => (n === 1 ? Promise.reject(fatal) : Promise.resolve(n)),
    }).catch((e: unknown) => e);
    expect(error).toBe(fatal);
    expect(wasPresented(fatal)).toBe(false);
    const budget = new BudgetBlockedError({ verdict: 'block', reasons: [] });
    expect(isFatalError(budget)).toBe(true);
    expect(isFatalError(new NetworkError())).toBe(false);
  });

  it('marks the rest stopped after a fatal error', async () => {
    const outcomes = new Map<number, ItemStatus>();
    await runItems({
      items: [1, 2, 3],
      concurrency: 1,
      signal: new AbortController().signal,
      work: (n) => (n === 1 ? Promise.reject(new ApiError('No auth', 401)) : Promise.resolve(n)),
      onItem: (outcome, index) => {
        outcomes.set(index, outcome.status);
      },
    }).catch(() => undefined);
    expect([...outcomes.entries()].sort()).toEqual([
      [0, 'failed'],
      [1, 'stopped'],
      [2, 'stopped'],
    ]);
  });

  it('rethrows the abort reason; running and queued items end stopped', async () => {
    const controller = new AbortController();
    const statuses = new Map<number, ItemStatus>();
    const pending = runItems({
      items: [1, 2, 3, 4],
      concurrency: 2,
      signal: controller.signal,
      work: (_n, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason as Error));
        }),
      onItem: (outcome, index) => statuses.set(index, outcome.status),
    });
    await tick();
    const reason = new DOMException('Stopped by the user.', 'AbortError');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect([...statuses.values()]).toEqual(['stopped', 'stopped', 'stopped', 'stopped']);
  });

  it('when every item failed, throws the last error marked as shown (the items show it)', async () => {
    const last = new NetworkError();
    const error = await runItems({
      items: [1, 2],
      concurrency: 1,
      signal: new AbortController().signal,
      work: (n) => Promise.reject(n === 2 ? last : new NetworkError()),
    }).catch((e: unknown) => e);
    expect(error).toBe(last);
    expect(wasPresented(last)).toBe(true);
  });

  it('runs nothing for no items', async () => {
    const result = await runItems({
      items: [],
      concurrency: 3,
      signal: new AbortController().signal,
      work: () => Promise.reject(new Error('never')),
    });
    expect(result).toMatchObject({ outcomes: [], done: 0, failed: 0, stopped: 0 });
  });
});

describe('batchTitle and batchSummary', () => {
  it('names the first file and counts the others once each', () => {
    expect(batchTitle(['a.pdf'])).toBe('a.pdf');
    expect(batchTitle(['a.pdf', 'a.pdf', 'b.png', 'c.pdf'], { retry: true })).toBe(
      'Retry: a.pdf and 2 more files',
    );
    expect(batchTitle(['a.pdf', 'b.pdf'], { noun: 'document' })).toBe('a.pdf and 1 more document');
  });

  it('says how much was done', () => {
    expect(batchSummary({ done: 4, failed: 0, stopped: 0 }, 'page')).toBe('Done · 4 pages');
    expect(batchSummary({ done: 3, failed: 1, stopped: 0 }, 'page')).toBe(
      'Done · 3 of 4 pages; 1 failed',
    );
    expect(batchSummary({ done: 1, failed: 0, stopped: 2 }, 'page')).toBe(
      'Stopped · 1 of 3 pages done',
    );
  });
});
