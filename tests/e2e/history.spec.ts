/**
 * Stage 2 gate: the History page. The timeline (grouped by day, paged with the `before` cursor), search and
 * filters (`?tool=`), the run detail drawer (`?run=`) with its actions, star, delete with Undo, bulk export and
 * delete, live updates, and axe in both themes. Runs are written straight into IndexedDB (tests/e2e/seed.ts).
 */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { RunRecord } from '../../src/core/types';
import { expect, test } from '../mock/index.ts';
import { seedApp, testKeysFile } from './app.ts';
import { makeRun, makeStats, makeUsage, seedDb, utcDayAgo } from './seed.ts';
import { expectNoSeriousA11yViolations, watchForProblems } from './support.ts';

const DAY_MIN = 24 * 60;

const RUNS: RunRecord[] = [
  makeRun('run-chat-ok', 5, {
    title: 'Summarise invoice',
    prompt: 'Summarise the **invoice** total',
    output: '# Summary\n\nThe total is **$42**.',
    settings: { temperature: 0.3, stream: true, aspectRatio: '16:9', stopSequences: ['END'] },
    usage: makeUsage({
      requests: 2,
      promptTokens: 1500,
      completionTokens: 400,
      costUsd: 0.0223,
      byModel: {
        'test/text-model': {
          requests: 1,
          promptTokens: 1200,
          completionTokens: 340,
          costUsd: 0.0123,
          latencyMsTotal: 1500,
        },
        'test/helper': {
          requests: 1,
          promptTokens: 300,
          completionTokens: 60,
          costUsd: 0.01,
          latencyMsTotal: 500,
        },
      },
    }),
  }),
  makeRun('run-ocr-json', 10, {
    tool: 'ocr',
    model: 'test/ocr',
    models: ['test/ocr'],
    title: 'Scan receipt',
    prompt: 'Extract fields',
    output: '{"total": 42, "items": [1, 2]}',
    settings: { language: 'en' },
  }),
  makeRun('run-chat-error', 20, {
    status: 'error',
    title: 'Broken request',
    prompt: 'Why does this fail?',
    error: 'The provider returned an error.',
    usage: makeUsage({ costUsd: 0, promptTokens: 0, completionTokens: 0, byModel: {} }),
  }),
  makeRun('run-tts-estimated', 30, {
    tool: 'text-to-speech',
    model: 'hexgrad/kokoro-82m',
    models: ['hexgrad/kokoro-82m'],
    title: 'Read aloud',
    usage: makeUsage({ costUsd: 0.002, costEstimated: true, promptTokens: 0, completionTokens: 0 }),
  }),
  makeRun('run-image-unknown', 40, {
    tool: 'image-generation',
    model: 'black-forest-labs/flux.2-klein-4b',
    models: ['black-forest-labs/flux.2-klein-4b'],
    title: 'Poster',
    usage: makeUsage({ costUsd: 0, costUnknown: true, promptTokens: 0, completionTokens: 0 }),
  }),
  makeRun('run-old', 2 * DAY_MIN + 5, { title: 'Old run' }),
];

const rows = (page: Page) => page.getByTestId('history-row');
const row = (page: Page, id: string) =>
  page.locator(`[data-testid="history-row"][data-run-id="${id}"]`);
const drawer = (page: Page) => page.getByTestId('run-drawer');

/** Open and past its slide-in: Escape and focus only act on a settled offcanvas (Bootstrap focuses it at the end). */
const expectDrawerOpen = (page: Page) => expect(drawer(page)).toHaveClass(/\bshow\b/);

async function closeDrawer(page: Page): Promise<void> {
  await expectDrawerOpen(page);
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toBeHidden();
}

test.beforeEach(async ({ context }) => {
  await seedApp(context, { key: true });
});

/** Seeds the database through a cheap page, then opens History (optionally with a query). */
async function openHistory(page: Page, runs: RunRecord[] = RUNS, path = 'history/'): Promise<void> {
  await page.goto('privacy/');
  await expect(page.getByTestId('page-title')).toHaveText('Privacy');
  await seedDb(page, { runs });
  await page.goto(path);
  await expect(page.getByTestId('page-title')).toHaveText('History');
  await expect(page.getByTestId('history-count')).not.toHaveText('Loading history…');
}

test('groups runs by day, and each row shows tool, title, model, status, cost, tokens and latency', async ({
  page,
}) => {
  const problems = await watchForProblems(page);
  await openHistory(page);
  await expect(rows(page)).toHaveCount(RUNS.length);

  const days = page.getByTestId('history-day');
  await expect(days).toHaveCount(2);
  await expect(days.first().getByRole('heading')).toHaveText('Today');
  await expect(days.last().getByRole('heading')).toHaveText(
    /^(\w{3}, \w{3} \d{1,2}|\w{3} \d{1,2}, \d{4})$/,
  );
  await expect(days.first().getByTestId('history-row')).toHaveCount(5);

  const chat = row(page, 'run-chat-ok');
  await expect(chat.getByTestId('run-title')).toHaveText('Summarise invoice');
  await expect(chat).toContainText('Chat');
  await expect(chat).toContainText('test/text-model');
  await expect(chat.getByTestId('run-status')).toHaveText('Done');
  await expect(chat.getByTestId('run-cost')).toHaveText('$0.022');
  await expect(chat).toContainText('1.5K in · 400 out');
  await expect(chat).toContainText('1.5 s');
  await expect(chat.locator('time')).toHaveText(/^\d+ minutes? ago$/);

  await expect(row(page, 'run-ocr-json')).toContainText('OCR');
  await expect(row(page, 'run-chat-error').getByTestId('run-status')).toHaveText('Failed');
  // Estimated and unknown costs are marked, never shown as exact or as zero.
  const estimated = row(page, 'run-tts-estimated').getByTestId('run-cost');
  await expect(estimated).toHaveAttribute('data-note', 'estimated');
  await expect(estimated).toContainText('≈ $0.002');
  const unknown = row(page, 'run-image-unknown').getByTestId('run-cost');
  await expect(unknown).toHaveAttribute('data-note', 'unknown');
  await expect(unknown).toContainText('Unknown');
  expect(problems).toEqual([]);
});

test('Home’s recent runs word their cost as History does: estimated with ≈, unknown never as a number', async ({
  page,
}) => {
  await openHistory(page);
  await page.goto('./');
  const recent = (title: string) =>
    page.getByTestId('recent-run').filter({ has: page.getByText(title, { exact: true }) });
  await expect(recent('Read aloud')).toContainText('≈ $0.002');
  await expect(recent('Poster')).toContainText('Cost unknown');
  await expect(recent('Summarise invoice')).toContainText('$0.022');
});

test.describe('records this build cannot draw', () => {
  // A restored backup or an older build can leave a run with a time no Date holds, or a tool that no longer exists.
  const ODD: RunRecord[] = [
    makeRun('run-odd-time', 1, { title: 'Odd time', startedAt: 1e20, finishedAt: null }),
    makeRun('run-gone-tool', 2, { title: 'Gone tool', tool: 'removed-tool' as RunRecord['tool'] }),
    makeRun('run-fine', 3, { title: 'Fine run' }),
  ];

  test('History lists every run, and Home shows the ones it can open', async ({ page }) => {
    const problems = await watchForProblems(page);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openHistory(page, ODD);
    await expect(rows(page)).toHaveCount(3);
    await expect(row(page, 'run-gone-tool')).toContainText('removed-tool');
    await row(page, 'run-odd-time').getByTestId('run-open').click();
    await expectDrawerOpen(page);
    await expect(page.getByTestId('run-reopen')).toBeVisible();
    await closeDrawer(page);
    await row(page, 'run-gone-tool').getByTestId('run-open').click();
    await expectDrawerOpen(page);
    await expect(page.getByTestId('run-reopen')).toHaveCount(0);
    await closeDrawer(page);

    await page.goto('./');
    const recent = page.getByTestId('recent-run');
    await expect(recent.filter({ hasText: 'Fine run' })).toHaveCount(1);
    await expect(recent.filter({ hasText: 'Odd time' })).toHaveCount(1);
    await expect(recent.filter({ hasText: 'Gone tool' })).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(problems).toEqual([]);
  });

  test('the palette skips a recent run of a removed tool', async ({ page }) => {
    await openHistory(page, ODD);
    await page.goto('./');
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog')).toBeVisible();
    const options = page.getByRole('option');
    await expect(options.filter({ hasText: 'Fine run' })).toHaveCount(1);
    await expect(options.filter({ hasText: 'Odd time' })).toHaveCount(1);
    await expect(options.filter({ hasText: 'Gone tool' })).toHaveCount(0);
  });
});

test('an empty history says so', async ({ page }) => {
  await openHistory(page, []);
  await expect(page.getByTestId('history-empty')).toContainText('No runs yet');
  await expect(page.getByRole('link', { name: 'Pick a tool' })).toBeVisible();
});

test.describe('search and filters', () => {
  test('search matches titles, prompts and outputs', async ({ page }) => {
    await openHistory(page);
    await page.getByTestId('history-search').fill('invoice');
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, 'run-chat-ok')).toBeVisible();
    await expect(page.getByTestId('history-count')).toHaveText('1 run');

    await page.getByTestId('history-search').fill('"total": 42');
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, 'run-ocr-json')).toBeVisible();

    await page.getByTestId('history-search').fill('zzzzqqqq');
    await expect(page.getByTestId('history-empty')).toContainText('No runs match');
    await page.getByTestId('history-empty').getByRole('button', { name: 'Reset filters' }).click();
    await expect(rows(page)).toHaveCount(RUNS.length);
    await expect(page.getByTestId('history-search')).toHaveValue('');
  });

  test('filter by tool keeps ?tool= in the address, and the link opens filtered', async ({
    page,
  }) => {
    await openHistory(page);
    await page.getByTestId('history-tool').selectOption('ocr');
    await expect(rows(page)).toHaveCount(1);
    await expect(page).toHaveURL(/[?&]tool=ocr/);
    await page.getByTestId('history-reset').click();
    await expect(rows(page)).toHaveCount(RUNS.length);
    await expect(page).not.toHaveURL(/tool=/);

    await page.goto('history/?tool=chat');
    await expect(page.getByTestId('history-tool')).toHaveValue('chat');
    await expect(rows(page)).toHaveCount(3);
    await expect(page.getByTestId('history-reset')).toBeVisible();

    // An unknown tool is ignored.
    await page.goto('history/?tool=nope');
    await expect(page.getByTestId('history-tool')).toHaveValue('');
    await expect(rows(page)).toHaveCount(RUNS.length);
  });

  test('filtering by a key that is then removed shows every run again, as the select says', async ({
    page,
  }) => {
    const second = {
      ...(testKeysFile().keys as Record<string, unknown>[])[0],
      id: 'key-two',
      name: 'Second key',
    };
    const keysFile = { ...testKeysFile(), keys: [...(testKeysFile().keys as unknown[]), second] };
    await page.goto('privacy/');
    await page.evaluate(
      (file) => localStorage.setItem('ortoolbox:keys', JSON.stringify(file)),
      keysFile,
    );
    await openHistory(page, [
      makeRun('run-first-key', 5, { title: 'First key run' }),
      makeRun('run-second-key', 6, {
        title: 'Second key run',
        keyId: 'key-two',
        keyName: 'Second key',
      }),
    ]);
    await page.getByTestId('history-key').selectOption('key-two');
    await expect(rows(page)).toHaveCount(1);

    // Another tab removes that key.
    await page.evaluate(() => {
      const file = JSON.parse(localStorage.getItem('ortoolbox:keys')!) as {
        keys: { id: string }[];
      };
      file.keys = file.keys.filter((key) => key.id !== 'key-two');
      localStorage.setItem('ortoolbox:keys', JSON.stringify(file));
      const bus = new BroadcastChannel('ortoolbox');
      bus.postMessage({ type: 'keys-changed' });
      bus.close();
    });
    await expect(page.getByTestId('history-key')).toHaveValue('');
    await expect(rows(page)).toHaveCount(2);
  });

  const routed = makeRun('run-routed', 15, {
    model: 'openrouter/free',
    models: ['openrouter/free', 'acme/routed-model:free'],
    title: 'Routed run',
  });

  test('filter by model: the models of the runs, including the ones behind a router', async ({
    page,
  }) => {
    await openHistory(page, [...RUNS, routed]);
    const options = page.getByTestId('history-model').locator('option');
    await expect(options).toHaveText([
      'Any model',
      'acme/routed-model:free',
      'black-forest-labs/flux.2-klein-4b',
      'hexgrad/kokoro-82m',
      'openrouter/free',
      'test/ocr',
      'test/text-model',
    ]);
    await page.getByTestId('history-model').selectOption('openrouter/free');
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, 'run-routed')).toBeVisible();
    // A model the run used besides its primary one finds it too.
    await page.getByTestId('history-model').selectOption('acme/routed-model:free');
    await expect(row(page, 'run-routed')).toBeVisible();
    await page.getByTestId('history-model').selectOption('test/ocr');
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, 'run-ocr-json')).toBeVisible();
  });

  test('the model filter comes from the runs, not from the spending ledger, and follows deletes', async ({
    page,
  }) => {
    await openHistory(page, [...RUNS, routed]);
    // A model that only the ledger knows (its runs are gone) is not offered.
    await seedDb(page, { stats: [makeStats(utcDayAgo(0), { model: 'ledger/only', runs: 1 })] });
    await page.reload();
    const options = page.getByTestId('history-model').locator('option');
    await expect(options).toHaveCount(7);
    await expect(options.filter({ hasText: 'ledger/only' })).toHaveCount(0);

    // Deleting the routed run takes the models only it used out of the list.
    await row(page, 'run-routed').getByTestId('run-open').click();
    await page.getByTestId('run-delete').click();
    await page.getByTestId('delete-run-dialog').getByTestId('dialog-confirm').click();
    await expect(row(page, 'run-routed')).toHaveCount(0);
    await expect(options.filter({ hasText: 'acme/routed-model:free' })).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(options.filter({ hasText: 'openrouter/free' })).toHaveCount(0);
    await expect(options).toHaveCount(5);
  });

  test('filter by status, starred and date range', async ({ page }) => {
    await openHistory(page);
    await page.getByTestId('history-status').selectOption('error');
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, 'run-chat-error')).toBeVisible();
    await page.getByTestId('history-reset').click();

    await row(page, 'run-ocr-json').getByTestId('run-star').click();
    await page.getByTestId('history-starred').check();
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, 'run-ocr-json')).toBeVisible();
    await page.getByTestId('history-reset').click();

    // From tomorrow on: nothing. From three days ago: everything.
    await page.getByTestId('history-from').fill('2099-01-01');
    await expect(page.getByTestId('history-empty')).toContainText('No runs match');
    await page.getByTestId('history-from').fill('2000-01-01');
    await expect(rows(page)).toHaveCount(RUNS.length);
    await page.getByTestId('history-to').fill('2000-01-02');
    await expect(page.getByTestId('history-empty')).toBeVisible();
  });
});

test.describe('run detail', () => {
  test('?run= opens the drawer with prompt, settings, output, usage and a Reopen link', async ({
    page,
  }) => {
    await openHistory(page, RUNS, 'history/?run=run-chat-ok');
    await expect(drawer(page)).toBeVisible();
    await expect(page.getByTestId('run-drawer-title')).toHaveText('Summarise invoice');
    await expect(page.getByTestId('run-prompt')).toHaveText('Summarise the **invoice** total');

    const settings = page.getByTestId('run-settings');
    await expect(settings).toContainText('Temperature');
    await expect(settings).toContainText('0.3');
    await expect(settings.getByText('Stream', { exact: true })).toBeVisible();
    await expect(settings).toContainText('Yes');
    await expect(settings).toContainText('Aspect ratio');
    await expect(settings).toContainText('16:9');
    await expect(settings).toContainText('Stop sequences');
    await expect(settings).toContainText('END');

    // Text output is rendered as sanitised Markdown.
    const output = page.getByTestId('run-output');
    await expect(output.getByRole('heading', { name: 'Summary' })).toBeVisible();
    await expect(output.locator('strong')).toHaveText('$42');

    await expect(page.getByTestId('run-detail-cost')).toHaveText('$0.022');
    const usage = page.getByTestId('run-usage');
    await expect(usage.locator('tbody tr')).toHaveCount(2);
    await expect(usage).toContainText('test/helper');

    const reopen = page.getByTestId('run-reopen');
    await expect(reopen).toHaveText('Reopen in Chat');
    await expect(reopen).toHaveAttribute('href', /\/tools\/chat\/\?run=run-chat-ok$/);

    await closeDrawer(page);
    await expect(page).not.toHaveURL(/run=/);
  });

  test('JSON output is shown as written, in monospace; errors and missing output are explained', async ({
    page,
  }) => {
    await openHistory(page);
    await row(page, 'run-ocr-json').getByTestId('run-open').click();
    await expect(page).toHaveURL(/[?&]run=run-ocr-json/);
    const json = page.getByTestId('run-output');
    await expect(json.locator('pre, code').first()).toBeVisible();
    await expect(json).toContainText('"total": 42');
    expect(await json.evaluate((node) => node.tagName)).toBe('PRE');
    await closeDrawer(page);

    await row(page, 'run-chat-error').getByTestId('run-open').click();
    await expect(page.getByTestId('run-error')).toContainText('The provider returned an error.');
    await expect(page.getByTestId('run-no-output')).toContainText('No text output was saved');
    await expect(drawer(page).getByTestId('run-status')).toHaveText('Failed');
    await closeDrawer(page);

    await row(page, 'run-image-unknown').getByTestId('run-open').click();
    await expect(page.getByTestId('run-detail-cost')).toHaveText('Unknown');
    await expect(drawer(page)).toContainText('did not report a cost');
  });

  test('an unknown ?run= says so', async ({ page }) => {
    await openHistory(page, RUNS, 'history/?run=does-not-exist');
    await expect(
      page.getByTestId('toast').filter({ hasText: 'no longer in your history' }),
    ).toBeVisible();
    await expect(drawer(page)).toBeHidden();
    await expect(page).not.toHaveURL(/run=/);
  });

  test('opens from the keyboard and returns focus to the row', async ({ page }) => {
    await openHistory(page);
    const open = row(page, 'run-ocr-json').getByTestId('run-open');
    await open.focus();
    await page.keyboard.press('Enter');
    await expect(drawer(page)).toBeVisible();
    await closeDrawer(page);
    await expect(open).toBeFocused();
  });

  test('Re-run with another model picks a model and opens the tool with ?run= and ?model=', async ({
    page,
  }) => {
    await openHistory(page, RUNS, 'history/?run=run-chat-ok');
    await page.getByTestId('run-rerun').click();
    const picker = page.getByTestId('model-picker');
    await expect(picker).toBeVisible();
    await picker.getByTestId('model-option-test/text-model:free').click();
    await expect(page).toHaveURL(/\/tools\/chat\/.*model=test%2Ftext-model%3Afree/);
    await expect(page.getByTestId('page-title')).toHaveText('Chat');
  });

  test('Reopen in tool goes to the tool with the run', async ({ page }) => {
    await openHistory(page, RUNS, 'history/?run=run-ocr-json');
    await page.getByTestId('run-reopen').click();
    await expect(page).toHaveURL(/\/tools\/ocr\//);
    await expect(page.getByTestId('page-title')).toHaveText('OCR');
  });

  test('Copy output and Export JSON', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
    await openHistory(page, RUNS, 'history/?run=run-ocr-json');
    await page.getByTestId('run-copy').click();
    await expect(page.getByTestId('toast').filter({ hasText: 'Output copied' })).toBeVisible();

    const download = page.waitForEvent('download');
    await page.getByTestId('run-export').click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('scan-receipt.json');
    const parsed = JSON.parse(readFileSync((await file.path()) ?? '', 'utf8')) as {
      format: string;
      runs: { id: string }[];
    };
    expect(parsed.format).toBe('ortoolbox-history');
    expect(parsed.runs.map((r) => r.id)).toEqual(['run-ocr-json']);
  });

  test('a run without output cannot be copied', async ({ page }) => {
    await openHistory(page, RUNS, 'history/?run=run-tts-estimated');
    await expect(page.getByTestId('run-copy')).toBeDisabled();
    await expect(page.getByTestId('run-no-output')).toBeVisible();
  });
});

test.describe('star and delete', () => {
  test('star in the list and in the drawer, remembered after a reload', async ({ page }) => {
    await openHistory(page);
    const star = row(page, 'run-chat-ok').getByTestId('run-star');
    await expect(star).toHaveAttribute('aria-pressed', 'false');
    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await expect(star).toBeFocused();

    await page.reload();
    await expect(row(page, 'run-chat-ok').getByTestId('run-star')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await row(page, 'run-chat-ok').getByTestId('run-open').click();
    const detail = page.getByTestId('run-detail-star');
    await expect(detail).toHaveAttribute('aria-pressed', 'true');
    await detail.click();
    await expect(detail).toHaveAttribute('aria-pressed', 'false');
    await closeDrawer(page);
    await expect(row(page, 'run-chat-ok').getByTestId('run-star')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('delete asks first, and Undo brings the run back', async ({ page }) => {
    await openHistory(page);
    await row(page, 'run-ocr-json').getByTestId('run-open').click();
    await page.getByTestId('run-delete').click();
    const dialog = page.getByTestId('delete-run-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Scan receipt');

    // Cancel keeps it.
    await dialog.getByTestId('dialog-cancel').click();
    await expect(dialog).toHaveCount(0);
    await expect(rows(page)).toHaveCount(RUNS.length);

    await page.getByTestId('run-delete').click();
    await page.getByTestId('delete-run-dialog').getByTestId('dialog-confirm').click();
    await expect(row(page, 'run-ocr-json')).toHaveCount(0);
    await expect(rows(page)).toHaveCount(RUNS.length - 1);
    await expect(drawer(page)).toBeHidden();

    const toast = page.getByTestId('toast').filter({ hasText: 'Deleted 1 run' });
    await expect(toast).toBeVisible();
    await toast.getByTestId('toast-undo').click();
    await expect(row(page, 'run-ocr-json')).toBeVisible();
    await expect(rows(page)).toHaveCount(RUNS.length);
    // And it is really back in storage.
    await page.reload();
    await expect(row(page, 'run-ocr-json')).toBeVisible();
  });

  test('a deleted run stays deleted after a reload when not undone', async ({ page }) => {
    await openHistory(page);
    await row(page, 'run-old').getByTestId('run-open').click();
    await page.getByTestId('run-delete').click();
    await page.getByTestId('delete-run-dialog').getByTestId('dialog-confirm').click();
    await expect(row(page, 'run-old')).toHaveCount(0);
    await page.reload();
    await expect(rows(page)).toHaveCount(RUNS.length - 1);
    await expect(row(page, 'run-old')).toHaveCount(0);
  });
});

test.describe('paging and live updates', () => {
  test('loads 40 at a time with the before cursor, without skipping or repeating a run', async ({
    page,
    context,
  }) => {
    await context.addInitScript(() => {
      (window as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
    });
    // 100 runs, a second apart; runs 39 and 40 share the same millisecond right at the first page boundary.
    const base = Date.now() - 3600_000;
    const bulk = Array.from({ length: 100 }, (_, index) =>
      makeRun(`bulk-${String(index).padStart(3, '0')}`, 0, {
        title: `Bulk ${index}`,
        startedAt: base - (index === 40 ? 39 : index) * 1000,
      }),
    );
    await openHistory(page, bulk);
    await expect(rows(page)).toHaveCount(40);
    await expect(page.getByTestId('history-count')).toHaveText('40 runs of 100');

    await page.getByTestId('history-more').click();
    await expect(rows(page)).toHaveCount(80);
    await page.getByTestId('history-more').click();
    await expect(rows(page)).toHaveCount(100);
    await expect(page.getByTestId('history-more')).toHaveCount(0);

    const ids = await rows(page).evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute('data-run-id')),
    );
    expect(new Set(ids).size).toBe(100);
    expect([...ids].sort()).toEqual(bulk.map((r) => r.id).sort());
  });

  test('a new run appears at once, without a reload', async ({ page }) => {
    await openHistory(page);
    await expect(rows(page)).toHaveCount(RUNS.length);
    await seedDb(page, { runs: [makeRun('run-new', 0, { title: 'Brand new run' })] });
    await expect(row(page, 'run-new')).toBeVisible();
    await expect(rows(page).first()).toHaveAttribute('data-run-id', 'run-new');
    await expect(rows(page)).toHaveCount(RUNS.length + 1);
  });

  test('an open run updates when it finishes', async ({ page }) => {
    const running = makeRun('run-live', 1, {
      status: 'running',
      finishedAt: null,
      latencyMs: null,
      title: 'Still going',
    });
    // Written after the page started: at page start, the sweep finalizes runs that no live page owns.
    await openHistory(page, []);
    await seedDb(page, { runs: [running] });
    await expect(row(page, 'run-live').getByTestId('run-status')).toHaveText('Running');
    await row(page, 'run-live').getByTestId('run-open').click();
    await expect(page.getByTestId('run-no-output')).toContainText('Still running');
    await seedDb(page, {
      runs: [
        {
          ...running,
          status: 'ok',
          finishedAt: Date.now(),
          latencyMs: 900,
          output: 'All done now.',
        },
      ],
    });
    await expect(page.getByTestId('run-output')).toContainText('All done now.');
    await expect(page.getByTestId('run-drawer-title')).toHaveText('Still going');
    await expect(drawer(page).getByTestId('run-status')).toHaveText('Done');
  });

  test('a live update of the open run keeps the focus on its Output or Prompt', async ({
    page,
  }) => {
    const run = RUNS[0]!;
    await openHistory(page, RUNS, `history/?run=${run.id}`);
    await expectDrawerOpen(page);
    let starred = run.starred;
    for (const testId of ['run-output', 'run-prompt']) {
      await page.getByTestId(testId).focus();
      // Starred in another tab: the drawer is rebuilt.
      starred = !starred;
      await seedDb(page, { runs: [{ ...run, starred }] });
      await expect(page.getByTestId('run-detail-star')).toHaveAttribute(
        'aria-pressed',
        String(starred),
      );
      await expect(page.getByTestId(testId)).toBeFocused();
    }
  });

  test('a search that cannot read storage shows the error state, not the old list', async ({
    page,
  }) => {
    await openHistory(page);
    await expect(rows(page)).toHaveCount(RUNS.length);
    // Every IndexedDB read fails from now on.
    await page.evaluate(() => {
      IDBDatabase.prototype.transaction = () => {
        throw new DOMException('Storage is gone', 'UnknownError');
      };
    });
    await page.getByTestId('history-search').fill('invoice');
    await expect(page.getByTestId('history-error')).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByTestId('history-count')).toHaveText('History could not be loaded.');
  });
});

test.describe('export and delete in bulk', () => {
  const readRuns = async (page: Page, trigger: () => Promise<void>): Promise<string[]> => {
    const download = page.waitForEvent('download');
    await trigger();
    const file = await download;
    const parsed = JSON.parse(readFileSync((await file.path()) ?? '', 'utf8')) as {
      runs: { id: string }[];
    };
    return parsed.runs.map((r) => r.id);
  };

  test('export all, and export only what the filters match', async ({ page }) => {
    await openHistory(page);
    const all = await readRuns(page, async () => {
      await page.getByTestId('history-menu').click();
      await page.getByTestId('history-export-all').click();
    });
    expect(all).toHaveLength(RUNS.length);

    await page.getByTestId('history-tool').selectOption('chat');
    await expect(rows(page)).toHaveCount(3);
    const filtered = await readRuns(page, async () => {
      await page.getByTestId('history-menu').click();
      await page.getByTestId('history-export-filtered').click();
    });
    expect(filtered.sort()).toEqual(['run-chat-error', 'run-chat-ok', 'run-old']);
  });

  test('delete filtered needs a typed confirmation and can be undone', async ({ page }) => {
    await openHistory(page);
    await page.getByTestId('history-tool').selectOption('chat');
    await expect(rows(page)).toHaveCount(3);

    await page.getByTestId('history-menu').click();
    await page.getByTestId('history-delete-filtered').click();
    const dialog = page.getByTestId('delete-filtered-dialog');
    await expect(dialog).toContainText('3 runs');
    const confirm = dialog.getByTestId('dialog-confirm');
    await expect(confirm).toBeDisabled();
    await dialog.getByTestId('typed-confirm-input').fill('delet');
    await expect(confirm).toBeDisabled();
    await dialog.getByTestId('typed-confirm-input').fill('delete');
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(page.getByTestId('history-empty')).toContainText('No runs match');
    await page.getByTestId('history-reset').click();
    // The other tools' runs are untouched.
    await expect(rows(page)).toHaveCount(RUNS.length - 3);
    await expect(row(page, 'run-ocr-json')).toBeVisible();

    await page
      .getByTestId('toast')
      .filter({ hasText: 'Deleted 3 runs' })
      .getByTestId('toast-undo')
      .click();
    await expect(rows(page)).toHaveCount(RUNS.length);
  });

  test('cancelling the typed confirmation deletes nothing', async ({ page }) => {
    await openHistory(page);
    await page.getByTestId('history-menu').click();
    await page.getByTestId('history-delete-filtered').click();
    const dialog = page.getByTestId('delete-filtered-dialog');
    await expect(dialog).toContainText('All 6 runs');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(rows(page)).toHaveCount(RUNS.length);
  });

  test('with nothing to export or delete it says so', async ({ page }) => {
    await openHistory(page, []);
    await page.getByTestId('history-menu').click();
    await page.getByTestId('history-delete-filtered').click();
    await expect(page.getByTestId('toast').filter({ hasText: 'nothing to delete' })).toBeVisible();
    await page.getByTestId('history-menu').click();
    await page.getByTestId('history-export-all').click();
    await expect(page.getByTestId('toast').filter({ hasText: 'no runs to export' })).toBeVisible();
  });
});

test.describe('accessibility', () => {
  test('the timeline and the drawer pass axe in light and dark', async ({ page }) => {
    test.slow();
    await page.emulateMedia({ colorScheme: 'light' });
    await openHistory(page);
    await expect(rows(page)).toHaveCount(RUNS.length);
    await expectNoSeriousA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark');
    await expectNoSeriousA11yViolations(page);

    await row(page, 'run-chat-ok').getByTestId('run-open').click();
    await expect(drawer(page)).toBeVisible();
    await expect(
      page.getByTestId('run-output').getByRole('heading', { name: 'Summary' }),
    ).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'light');
    await expectNoSeriousA11yViolations(page);
  });
});

test.describe('runs in progress', () => {
  const live = makeRun('run-live', 1, {
    status: 'running',
    finishedAt: null,
    latencyMs: null,
    title: 'Still going',
  });

  /** The stored status of a run, read straight from IndexedDB. */
  const storedStatus = (page: Page, id: string): Promise<string | undefined> =>
    page.evaluate(async (runId) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('ortoolbox');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('open failed'));
      });
      const record = await new Promise<{ status?: string } | undefined>((resolve, reject) => {
        const request = db.transaction('runs').objectStore('runs').get(runId);
        request.onsuccess = () => resolve(request.result as { status?: string } | undefined);
        request.onerror = () => reject(request.error ?? new Error('read failed'));
      });
      db.close();
      return record?.status;
    }, id);

  // Written after the page started, and owned (its run lock held, as the tab running it would): the page's boot
  // sweep finalizes runs that no live page owns, and it runs when the browser is idle, which is 2 s after load
  // where there is no requestIdleCallback (WebKit).
  test.beforeEach(async ({ page }) => {
    await openHistory(page);
    await page.evaluate((id) => {
      void navigator.locks.request(`ortoolbox:run:${id}`, () => new Promise<void>(() => undefined));
    }, live.id);
    await seedDb(page, { runs: [live] });
    await expect(row(page, 'run-live').getByTestId('run-status')).toHaveText('Running');
  });

  test('cannot be deleted one by one', async ({ page }) => {
    await row(page, 'run-live').getByTestId('run-open').click();
    await expect(page.getByTestId('run-delete')).toBeDisabled();
    await expect(page.getByTestId('run-delete-note')).toContainText('still in progress');
    // Other runs can.
    await closeDrawer(page);
    await row(page, 'run-old').getByTestId('run-open').click();
    await expect(page.getByTestId('run-delete')).toBeEnabled();
    await expect(page.getByTestId('run-delete-note')).toHaveCount(0);
  });

  test('are kept by "Delete filtered", and Undo never brings one back or changes it', async ({
    page,
  }) => {
    await page.getByTestId('history-menu').click();
    await page.getByTestId('history-delete-filtered').click();
    const dialog = page.getByTestId('delete-filtered-dialog');
    await expect(dialog).toContainText(`${RUNS.length} runs`);
    await expect(dialog).toContainText('1 run in progress is kept');
    await dialog.getByTestId('typed-confirm-input').fill('delete');
    await dialog.getByTestId('dialog-confirm').click();

    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, 'run-live')).toBeVisible();
    expect(await storedStatus(page, 'run-live')).toBe('running');

    await page
      .getByTestId('toast')
      .filter({ hasText: `Deleted ${RUNS.length} runs` })
      .getByTestId('toast-undo')
      .click();
    await expect(rows(page)).toHaveCount(RUNS.length + 1);
    await expect(row(page, 'run-live').getByTestId('run-status')).toHaveText('Running');
    expect(await storedStatus(page, 'run-live')).toBe('running');
  });

  test('a filter that matches only runs in progress has nothing to delete', async ({ page }) => {
    await page.getByTestId('history-status').selectOption('running');
    await expect(rows(page)).toHaveCount(1);
    await page.getByTestId('history-menu').click();
    await page.getByTestId('history-delete-filtered').click();
    await expect(
      page.getByTestId('toast').filter({ hasText: 'only runs in progress' }),
    ).toBeVisible();
    await expect(page.getByTestId('delete-filtered-dialog')).toHaveCount(0);
  });
});

test.describe('output as stored', () => {
  test('JSON output keeps big integers, overflowing exponents and trailing zeros', async ({
    page,
  }) => {
    const output = '{"id": 12345678901234567890, "big": 1e999, "price": 1.50, "dup": 1, "dup": 2}';
    await openHistory(
      page,
      [makeRun('run-json', 1, { title: 'Exact', output })],
      'history/?run=run-json',
    );
    const json = page.getByTestId('run-output');
    await expect(json).toContainText('"id": 12345678901234567890');
    await expect(json).toContainText('"big": 1e999');
    await expect(json).toContainText('"price": 1.50');
    // Duplicate keys survive too: nothing was parsed and written back.
    await expect(json).toContainText('"dup": 1');
    await expect(json).toContainText('"dup": 2');
    expect(await json.evaluate((node) => node.tagName)).toBe('PRE');
  });
});

test.describe('paging builds only the new rows', () => {
  test('Show more leaves the rows on screen as they are', async ({ page, context }) => {
    await context.addInitScript(() => {
      (window as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
    });
    const base = Date.now() - 3600_000;
    const bulk = Array.from({ length: 90 }, (_, index) =>
      makeRun(`more-${String(index).padStart(3, '0')}`, 0, {
        title: `More ${index}`,
        startedAt: base - index * 1000,
      }),
    );
    await openHistory(page, bulk);
    await expect(rows(page)).toHaveCount(40);
    // Tag the first row and its day section: a rebuild would drop the tags.
    await rows(page)
      .first()
      .evaluate((node) => {
        node.setAttribute('data-mark', 'row');
        node.closest('section')?.setAttribute('data-mark', 'section');
      });
    await page.getByTestId('history-more').click();
    await expect(rows(page)).toHaveCount(80);
    await expect(rows(page).first()).toHaveAttribute('data-mark', 'row');
    await expect(page.getByTestId('history-day').first()).toHaveAttribute('data-mark', 'section');
    // The new rows joined the same day (all 90 runs are within the last hour), not a new section.
    await expect(page.getByTestId('history-day')).toHaveCount(1);
    await expect(page.getByTestId('history-count')).toHaveText('80 runs of 90');
  });
});

test.describe('phones', () => {
  test('the list and the drawer with its usage table do not make the page scroll sideways', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openHistory(page, RUNS, 'history/?run=run-chat-ok');
    await expect(page.getByTestId('run-usage')).toBeVisible();
    const overflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
    expect(await overflow()).toBeLessThanOrEqual(0);
    await closeDrawer(page);
    expect(await overflow()).toBeLessThanOrEqual(0);
  });
});
