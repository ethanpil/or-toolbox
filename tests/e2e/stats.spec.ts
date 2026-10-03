/**
 * Stage 2 gate: the Stats page. KPI tiles and charts computed from seeded ledger rows, the date range (presets
 * and custom), stacking by tool or model, colours that follow the entity, the table twin of every chart, the
 * breakdown tables, the budget and key sections, the empty state, the lazy chart chunk, theme changes, and axe
 * in both themes.
 *
 * Seeded rows (days ago; free = a :free model):
 *   0  chat  test/text-model       3 requests, 2 runs, $0.30
 *   0  chat  qwen/qwen3.8-27b:free 4 requests, 3 runs, free
 *   1  ocr   test/ocr              1 request,  1 run (failed), $0.05
 *   5  image-generation test/img   1 request,  1 run, $0.20
 *   8  chat  test/text-model       2 requests, 2 runs, $0.10
 *  20  chat  test/text-model      10 requests, 8 runs (2 failed), $1.00
 *  45  ocr   test/ocr              5 requests, 5 runs, $2.00
 */
import type { Page } from '@playwright/test';
import type { StatsRow } from '../../src/core/types';
import { expect, test } from '../mock/index.ts';
import { seedApp } from './app.ts';
import { makeStats, seedDb, utcDayAgo } from './seed.ts';
import { expectNoSeriousA11yViolations, watchForProblems } from './support.ts';

const ROWS: StatsRow[] = [
  makeStats(utcDayAgo(0), {
    tool: 'chat',
    model: 'test/text-model',
    runs: 2,
    requests: 3,
    promptTokens: 3000,
    completionTokens: 1200,
    costUsd: 0.3,
    latencyMsTotal: 6000,
  }),
  makeStats(utcDayAgo(0), {
    tool: 'chat',
    model: 'qwen/qwen3.8-27b:free',
    free: true,
    runs: 3,
    requests: 4,
    promptTokens: 800,
    completionTokens: 400,
    costUsd: 0,
    latencyMsTotal: 2000,
  }),
  makeStats(utcDayAgo(1), {
    tool: 'ocr',
    model: 'test/ocr',
    runs: 1,
    errors: 1,
    requests: 1,
    promptTokens: 500,
    completionTokens: 200,
    costUsd: 0.05,
    latencyMsTotal: 2000,
  }),
  makeStats(utcDayAgo(5), {
    tool: 'image-generation',
    model: 'test/img',
    runs: 1,
    requests: 1,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0.2,
    latencyMsTotal: 4000,
  }),
  makeStats(utcDayAgo(8), {
    tool: 'chat',
    model: 'test/text-model',
    runs: 2,
    requests: 2,
    promptTokens: 400,
    completionTokens: 100,
    costUsd: 0.1,
    latencyMsTotal: 2000,
  }),
  makeStats(utcDayAgo(20), {
    tool: 'chat',
    model: 'test/text-model',
    runs: 8,
    errors: 2,
    requests: 10,
    promptTokens: 10000,
    completionTokens: 5000,
    costUsd: 1,
    latencyMsTotal: 20000,
  }),
  makeStats(utcDayAgo(45), {
    tool: 'ocr',
    model: 'test/ocr',
    runs: 5,
    requests: 5,
    promptTokens: 2000,
    completionTokens: 1000,
    costUsd: 2,
    latencyMsTotal: 10000,
  }),
];

const BUDGETS = {
  budgets: { mode: 'warn', perRunUsd: 0.1, monthlyUsd: 20, perKeyMonthlyUsd: { 'key-test': 10 } },
};

const kpi = (page: Page, id: string) => page.getByTestId(`kpi-${id}-value`);

test.beforeEach(async ({ context }) => {
  await seedApp(context, { key: true, settings: BUDGETS });
});

/** Seeds the ledger through a cheap page, then opens Stats. */
async function openStats(page: Page, rows: StatsRow[] = ROWS): Promise<void> {
  await page.goto('privacy/');
  await expect(page.getByTestId('page-title')).toHaveText('Privacy');
  await seedDb(page, { stats: rows });
  await page.goto('stats/');
  await expect(page.getByTestId('page-title')).toHaveText('Stats');
  await expect(page.getByTestId('stats-range-30d')).toHaveAttribute('aria-pressed', 'true');
}

/** True when the canvas has drawn at least one visible pixel. */
const isDrawn = (page: Page, testId: string): Promise<boolean> =>
  page.getByTestId(testId).evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    const context = canvas.getContext('2d');
    if (!context || canvas.width === 0 || canvas.height === 0) return false;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 0) return true;
    return false;
  });

test('shows the KPI tiles for the default 30 days, computed from the ledger', async ({ page }) => {
  const problems = await watchForProblems(page);
  await openStats(page);
  await expect(page.getByTestId('stats-range-label')).toContainText('30 days, UTC');
  await expect(kpi(page, 'spend')).toHaveText('$1.65');
  await expect(kpi(page, 'requests')).toHaveText('21');
  await expect(kpi(page, 'runs')).toHaveText('17');
  await expect(kpi(page, 'errors')).toHaveText('18%');
  await expect(page.getByTestId('kpi-errors')).toContainText('3 of 17 runs failed');
  await expect(kpi(page, 'latency')).toHaveText('1.7 s');
  await expect(kpi(page, 'free')).toHaveText('19% free');
  await expect(page.getByTestId('kpi-free')).toContainText('4 free · 17 paid requests');
  await expect(page.getByTestId('kpi-free-split')).toHaveAccessibleName(
    '19% of requests were free, 81% paid',
  );
  expect(problems).toEqual([]);
});

test('switching the range recomputes everything', async ({ page }) => {
  await openStats(page);

  await page.getByTestId('stats-range-7d').click();
  await expect(page.getByTestId('stats-range-7d')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('stats-range-30d')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('stats-range-label')).toContainText('7 days, UTC');
  await expect(kpi(page, 'spend')).toHaveText('$0.55');
  await expect(kpi(page, 'requests')).toHaveText('9');
  await expect(kpi(page, 'runs')).toHaveText('7');
  await expect(kpi(page, 'errors')).toHaveText('14%');
  await expect(kpi(page, 'latency')).toHaveText('1.6 s');
  await expect(kpi(page, 'free')).toHaveText('44% free');
  // Compared with the 7 days before (only the $0.10 run of 8 days ago).
  await expect(page.getByTestId('kpi-spend')).toContainText('+450% vs the 7 days before');

  await page.getByTestId('stats-range-90d').click();
  await expect(kpi(page, 'spend')).toHaveText('$3.65');
  await expect(kpi(page, 'requests')).toHaveText('26');
  await expect(kpi(page, 'runs')).toHaveText('22');
  await expect(kpi(page, 'free')).toHaveText('15% free');

  await page.getByTestId('stats-range-month').click();
  await expect(page.getByTestId('stats-range-month')).toHaveAttribute('aria-pressed', 'true');
  // Today's rows are always in this month.
  await expect(page.getByTestId('kpi-requests')).toBeVisible();
  expect(Number(await kpi(page, 'requests').textContent())).toBeGreaterThanOrEqual(7);
});

test('the chosen preset is remembered', async ({ page }) => {
  await openStats(page);
  await page.getByTestId('stats-range-90d').click();
  await expect(kpi(page, 'spend')).toHaveText('$3.65');
  await page.reload();
  await expect(page.getByTestId('stats-range-90d')).toHaveAttribute('aria-pressed', 'true');
  await expect(kpi(page, 'spend')).toHaveText('$3.65');
});

test('a custom range takes two UTC days, and refuses a wrong one', async ({ page }) => {
  await openStats(page);
  await expect(page.getByTestId('stats-custom')).toBeHidden();
  await page.getByTestId('stats-range-custom').click();
  await expect(page.getByTestId('stats-custom')).toBeVisible();

  // Reversed.
  await page.getByTestId('stats-from').fill(utcDayAgo(0));
  await page.getByTestId('stats-to').fill(utcDayAgo(3));
  await page.getByTestId('stats-apply').click();
  await expect(page.getByTestId('stats-range-error')).toHaveText(
    'The start day must not be after the end day.',
  );
  await expect(kpi(page, 'spend')).toHaveText('$1.65');

  // Only the run of 20 days ago.
  await page.getByTestId('stats-from').fill(utcDayAgo(21));
  await page.getByTestId('stats-to').fill(utcDayAgo(19));
  await page.getByTestId('stats-apply').click();
  await expect(page.getByTestId('stats-range-error')).toBeHidden();
  await expect(page.getByTestId('stats-range-custom')).toHaveAttribute('aria-pressed', 'true');
  await expect(kpi(page, 'spend')).toHaveText('$1.00');
  await expect(kpi(page, 'requests')).toHaveText('10');
  await expect(kpi(page, 'errors')).toHaveText('25%');
  await expect(kpi(page, 'free')).toHaveText('0% free');
});

test.describe('charts', () => {
  test('draw spend, requests and tokens from the rows, with a legend', async ({ page }) => {
    await openStats(page);
    for (const id of ['chart-spend', 'chart-requests', 'chart-tokens']) {
      await expect(page.getByTestId(`${id}-canvas`)).toHaveAttribute('data-rendered', 'true');
      await expect.poll(() => isDrawn(page, `${id}-canvas`)).toBe(true);
    }
    // Spend per tool: chat, image generation and OCR (ordered by spend).
    await expect(page.getByTestId('chart-spend-legend-item')).toHaveText([
      'Chat',
      'Image generation',
      'OCR',
    ]);
    await expect(page.getByTestId('chart-spend-canvas')).toHaveAttribute('data-series', '3');
    // Requests include the free chat model's calls, ordered by requests.
    await expect(page.getByTestId('chart-requests-legend-item')).toHaveText([
      'Chat',
      'Image generation',
      'OCR',
    ]);
    await expect(page.getByTestId('chart-tokens-legend-item')).toHaveText([
      'Tokens in',
      'Tokens out',
    ]);
    // The text alternative is the canvas's accessible name.
    await expect(page.getByTestId('chart-spend-canvas')).toHaveAttribute(
      'aria-label',
      /^Spend per day by tool, .*: \$1\.65 over 5 active days\. Busiest day .* with \$1\.00\. Largest series Chat with \$1\.40\./,
    );
  });

  test('stack by model, and toggle a series in the legend', async ({ page }) => {
    await openStats(page);
    await page.getByTestId('stats-stack-model').click();
    await expect(page.getByTestId('stats-stack-model')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('chart-spend-legend-item')).toHaveText([
      'test/text-model',
      'test/img',
      'test/ocr',
    ]);
    // The free model has requests but no spend.
    await expect(page.getByTestId('chart-requests-legend-item')).toHaveText([
      'test/text-model',
      'qwen/qwen3.8-27b:free',
      'test/img',
      'test/ocr',
    ]);

    const first = page.getByTestId('chart-spend-legend-item').first();
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    await first.click();
    await expect(first).toHaveAttribute('aria-pressed', 'false');
    await first.click();
    await expect(first).toHaveAttribute('aria-pressed', 'true');
  });

  test('colours follow the entity: the range does not repaint the survivors', async ({ page }) => {
    await openStats(page);
    const slotOf = (name: string) =>
      page
        .getByTestId('chart-spend-legend-item')
        .filter({ hasText: name })
        .locator('.or-swatch')
        .getAttribute('data-slot');
    // OCR spent the most over all time ($2.05), so it holds slot 1; chat is second.
    const chat30 = await slotOf('Chat');
    const image30 = await slotOf('Image generation');
    expect(chat30).toBe('2');
    expect(image30).toBe('3');
    expect(await slotOf('OCR')).toBe('1');

    // Only chat spent in the last 20 days: it keeps its colour although it is now the only series.
    await page.getByTestId('stats-range-custom').click();
    await page.getByTestId('stats-from').fill(utcDayAgo(21));
    await page.getByTestId('stats-to').fill(utcDayAgo(19));
    await page.getByTestId('stats-apply').click();
    await expect(kpi(page, 'spend')).toHaveText('$1.00');
    // One series needs no legend box.
    await expect(page.getByTestId('chart-spend-legend-item')).toHaveCount(0);

    // Widen to 7 days: chat, image generation and OCR are back with the same colours.
    await page.getByTestId('stats-range-7d').click();
    await expect(page.getByTestId('chart-spend-legend-item')).toHaveCount(3);
    expect(await slotOf('Chat')).toBe(chat30);
    expect(await slotOf('Image generation')).toBe(image30);
  });

  test('the table view has the same numbers as the chart', async ({ page }) => {
    await openStats(page);
    const toggle = page.getByTestId('chart-spend-table-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('chart-spend-table')).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('chart-spend-canvas')).toBeHidden();

    const table = page.getByTestId('chart-spend-table');
    await expect(table).toBeVisible();
    await expect(table.getByRole('columnheader')).toHaveText([
      'Day',
      'Chat',
      'Image generation',
      'OCR',
      'Total',
    ]);
    // One row per day with spend, oldest first: 20, 8, 5, 1 and 0 days ago.
    const body = table.locator('tbody tr');
    await expect(body).toHaveCount(5);
    await expect(body.first()).toContainText('$1.00');
    await expect(body.last().getByRole('cell')).toHaveText(['$0.30', '$0.00', '$0.00', '$0.30']);

    await page.getByTestId('chart-requests-table-toggle').click();
    await expect(page.getByTestId('chart-requests-table').locator('tbody tr')).toHaveCount(5);

    await page.getByTestId('chart-tokens-table-toggle').click();
    const tokens = page.getByTestId('chart-tokens-table');
    await expect(tokens.locator('tbody tr').first().getByRole('cell')).toHaveText([
      '13,400',
      '6,300',
      '19,700',
    ]);
    await expect(tokens.locator('tbody tr').first().getByRole('rowheader')).toHaveText(
      'test/text-model',
    );

    await toggle.click();
    await expect(page.getByTestId('chart-spend-canvas')).toBeVisible();
    await expect(page.getByTestId('chart-spend-canvas')).toHaveAttribute('data-rendered', 'true');
  });

  test('the chart library loads only when there is something to draw', async ({ page }) => {
    const chartRequests: string[] = [];
    page.on('request', (request) => {
      if (/stats-charts|chart\.js/.test(request.url())) chartRequests.push(request.url());
    });
    await openStats(page, []);
    await expect(page.getByTestId('stats-empty-state')).toBeVisible();
    // Give a wrongly eager import time to show.
    await page.waitForLoadState('networkidle');
    expect(chartRequests).toEqual([]);

    await seedDb(page, { stats: ROWS });
    await expect(page.getByTestId('chart-spend-canvas')).toHaveAttribute('data-rendered', 'true');
    expect(chartRequests.length).toBeGreaterThan(0);
  });

  test('follows the theme without a reload', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openStats(page);
    await expect(page.getByTestId('chart-spend-canvas')).toHaveAttribute('data-rendered', 'true');
    await expect.poll(() => isDrawn(page, 'chart-spend-canvas')).toBe(true);
    const pixels = () =>
      page
        .getByTestId('chart-spend-canvas')
        .evaluate((node) => (node as HTMLCanvasElement).toDataURL());
    const swatch = () =>
      page
        .getByTestId('chart-spend-legend-item')
        .first()
        .locator('.or-swatch')
        .evaluate((node) => getComputedStyle(node).backgroundColor);
    // The bars grow for a moment; wait until the picture stops changing.
    const settled = async (): Promise<string> => {
      let previous = await pixels();
      for (let attempt = 0; attempt < 20; attempt++) {
        await page.waitForTimeout(250);
        const next = await pixels();
        if (next === previous) return next;
        previous = next;
      }
      return previous;
    };
    const lightPixels = await settled();
    const lightSwatch = await swatch();

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark');
    await expect.poll(pixels).not.toBe(lightPixels);
    expect(await swatch()).not.toBe(lightSwatch);

    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'light');
    await expect.poll(pixels).toBe(lightPixels);
  });
});

test('breakdown tables list tools, models (with tokens, latency, error rate) and keys', async ({
  page,
}) => {
  await openStats(page);
  const tools = page.getByTestId('breakdown-tools-row');
  await expect(tools).toHaveCount(3);
  // Biggest spender first.
  await expect(tools.first()).toContainText('Chat');
  await expect(tools.first()).toContainText('$1.40');
  await expect(tools.first()).toContainText('85%');

  const models = page.getByTestId('breakdown-models-row');
  await expect(models).toHaveCount(4);
  const text = models.filter({ hasText: 'test/text-model' });
  await expect(text).toContainText('15');
  await expect(text).toContainText('$1.40');
  await expect(text).toContainText('13.4K');
  await expect(text).toContainText('6.3K');
  await expect(text).toContainText('1.9 s');
  // 2 of 12 runs failed: flagged with an icon and a text label, not by colour alone.
  await expect(text.locator('[data-high="true"]')).toContainText('17%');
  await expect(text.locator('[data-high="true"]')).toContainText('(high)');
  const ocr = models.filter({ hasText: 'test/ocr' });
  await expect(ocr.locator('[data-high="true"]')).toContainText('100%');
  await expect(models.filter({ hasText: 'qwen/qwen3.8-27b:free' })).toContainText('$0.00');

  const keys = page.getByTestId('breakdown-keys-row');
  await expect(keys).toHaveCount(1);
  await expect(keys).toContainText('Test key');
  await expect(keys).toContainText('21');
});

test.describe('budget and balances', () => {
  test('month spend against the monthly budget, free requests today and the key balance', async ({
    page,
    mock,
  }) => {
    mock.json('GET', '/api/v1/key', {
      data: {
        label: 'sk-or-v1-tes...000',
        limit: 5,
        limit_remaining: 4.5,
        usage: 0.5,
        is_free_tier: false,
        free_model_daily_requests: { used: 12, limit: 50, remaining: 38 },
      },
    });
    await openStats(page);
    const month = page.getByTestId('budget-month');
    await expect(month).toBeVisible();
    await expect(page.getByTestId('budget-month-spend')).toHaveText(/^\$\d/);
    await expect(page.getByTestId('budget-month-limit')).toContainText(
      'of your $20.00 monthly budget',
    );
    const meter = page.getByTestId('budget-month-meter');
    await expect(meter).toHaveAttribute('role', 'meter');
    await expect(meter).toHaveAccessibleName('Monthly budget used');
    await expect(month).toContainText('Budget mode: Warn');

    // Today's :free requests from the ledger, and OpenRouter's own counter.
    await expect(page.getByTestId('free-today')).toHaveText('4');
    await expect(page.getByTestId('free-remote')).toContainText('12 of 50');

    const key = page.getByTestId('budget-key-row');
    await expect(key).toHaveCount(1);
    await expect(key).toContainText('Test key');
    await expect(key.getByTestId('balance')).toContainText('$4.50 left');
    await expect(key.getByTestId('balance')).toContainText('of $5.00');
    // The per-key monthly limit of $10.
    await expect(key).toContainText('of $10.00');
  });

  test('without a budget it says so and links to Settings', async ({ page }) => {
    await openStats(page);
    await page.evaluate(() => {
      const settings = JSON.parse(localStorage.getItem('ortoolbox:settings') ?? '{}') as {
        budgets?: Record<string, unknown>;
      };
      settings.budgets = {
        mode: 'disabled',
        perRunUsd: 0.1,
        monthlyUsd: null,
        perKeyMonthlyUsd: {},
      };
      localStorage.setItem('ortoolbox:settings', JSON.stringify(settings));
    });
    await page.reload();
    const month = page.getByTestId('budget-month');
    await expect(month).toContainText('No monthly budget is set');
    await expect(month).toContainText('Limits are not enforced');
    await expect(month.getByRole('link', { name: 'Set one in Settings' })).toHaveAttribute(
      'href',
      /settings\/#budgets$/,
    );
  });

  test('a key whose balance cannot be read still shows its spend', async ({ page, mock }) => {
    mock.json('GET', '/api/v1/key', { error: { code: 401, message: 'No auth' } }, { status: 401 });
    await openStats(page);
    const key = page.getByTestId('budget-key-row');
    await expect(key.getByTestId('balance-error')).toHaveText('Unavailable');
    await expect(key).toContainText('Test key');
  });
});

test.describe('without data', () => {
  test('a first visit shows a friendly empty state and still the budget section', async ({
    page,
  }) => {
    const problems = await watchForProblems(page);
    await openStats(page, []);
    await expect(page.getByTestId('stats-empty-state')).toContainText('No numbers yet');
    await expect(page.getByRole('link', { name: 'Pick a tool' })).toHaveAttribute(
      'href',
      /\/or-toolbox\/$/,
    );
    await expect(page.getByTestId('stats-dashboard')).toBeHidden();
    await expect(page.getByTestId('budget-month')).toBeVisible();
    await expect(page.getByTestId('budget-month-spend')).toHaveText('$0.00');
    expect(problems).toEqual([]);
  });

  test('a range without runs shows zeros and empty charts, not an error', async ({ page }) => {
    await openStats(page);
    await page.getByTestId('stats-range-custom').click();
    await page.getByTestId('stats-from').fill(utcDayAgo(40));
    await page.getByTestId('stats-to').fill(utcDayAgo(30));
    await page.getByTestId('stats-apply').click();
    await expect(kpi(page, 'spend')).toHaveText('$0.00');
    await expect(kpi(page, 'requests')).toHaveText('0');
    await expect(kpi(page, 'errors')).toHaveText('—');
    await expect(kpi(page, 'latency')).toHaveText('—');
    await expect(page.getByTestId('chart-spend')).toContainText('No spend in this period.');
    await expect(page.getByTestId('chart-spend-canvas')).toBeHidden();
    await expect(page.getByTestId('chart-tokens')).toContainText(
      'No tokens were used in this period.',
    );
  });

  test('rows that arrive while the page is open are drawn', async ({ page }) => {
    await openStats(page, []);
    await expect(page.getByTestId('stats-empty-state')).toBeVisible();
    await seedDb(page, { stats: [ROWS[0]!] });
    await expect(page.getByTestId('stats-empty-state')).toHaveCount(0);
    await expect(kpi(page, 'spend')).toHaveText('$0.30');
    await expect(page.getByTestId('chart-spend-canvas')).toHaveAttribute('data-rendered', 'true');
  });
});

test.describe('accessibility', () => {
  test('the dashboard passes axe in light and dark, as charts and as tables', async ({ page }) => {
    test.slow();
    await page.emulateMedia({ colorScheme: 'light' });
    await openStats(page);
    await expect(page.getByTestId('chart-tokens-canvas')).toHaveAttribute('data-rendered', 'true');
    await expect(page.getByTestId('budget-key-row')).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark');
    await expectNoSeriousA11yViolations(page);

    for (const id of ['chart-spend', 'chart-requests', 'chart-tokens']) {
      await page.getByTestId(`${id}-table-toggle`).click();
    }
    await expect(page.getByTestId('chart-spend-table')).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'light');
    await expectNoSeriousA11yViolations(page);
  });

  test('the empty state passes axe in both themes', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openStats(page, []);
    await expect(page.getByTestId('stats-empty-state')).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark');
    await expectNoSeriousA11yViolations(page);
  });

  test('works with the keyboard: range, stack, legend and table view', async ({ page }) => {
    await openStats(page);
    const week = page.getByTestId('stats-range-7d');
    await week.focus();
    await page.keyboard.press('Enter');
    await expect(week).toHaveAttribute('aria-pressed', 'true');
    await expect(kpi(page, 'spend')).toHaveText('$0.55');
    const stack = page.getByTestId('stats-stack-model');
    await stack.focus();
    await page.keyboard.press('Space');
    await expect(stack).toHaveAttribute('aria-pressed', 'true');
    const toggle = page.getByTestId('chart-spend-table-toggle');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('chart-spend-table')).toBeVisible();
    await expect(toggle).toBeFocused();
  });
});
