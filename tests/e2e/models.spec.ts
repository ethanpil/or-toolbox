/**
 * Stage 2 gate: the Models page. Search (and the `?q=` deep link), filters, sorting, cards and table views,
 * favorites, recently used, the comparison tray and dialog, your own stats per model, refresh, and axe in both
 * themes. The catalog is the recorded fixture of 55 models (more than one page of 48).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../mock/index.ts';
import { seedApp } from './app.ts';
import { indexReads, makeStats, recordIndexReads, seedDb, utcDayAgo } from './seed.ts';
import { expectNoSeriousA11yViolations, watchForProblems } from './support.ts';

const catalog = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'openrouter', 'models.json'), 'utf8'),
) as { data: { id: string }[] };
const TOTAL = catalog.data.length;

const cards = (page: Page) => page.getByTestId('model-card');
const count = (page: Page) => page.getByTestId('models-count');
const card = (page: Page, id: string) =>
  page.locator(`[data-testid="model-card"][data-model-id="${id}"]`);

test.beforeEach(async ({ context, mock }) => {
  await seedApp(context);
  mock.json('GET', '/api/v1/models', { data: catalog.data, total_count: TOTAL });
});

/** Loads the page and waits for the catalog (cards, or rows in the remembered table view). */
async function open(page: Page, path = 'models/'): Promise<void> {
  await page.goto(path);
  await expect(page.getByTestId('page-title')).toHaveText('Models');
  await expect(count(page)).toContainText('models');
  await expect(
    page
      .getByTestId('models-list')
      .locator('[data-model-id], [data-testid="models-empty"]')
      .first(),
  ).toBeVisible();
}

test('lists the catalog a page at a time and shows more on request', async ({ page, context }) => {
  // Without IntersectionObserver the button is the only way (and the test is not racing the auto-load).
  await context.addInitScript(() => {
    (window as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
  });
  const problems = await watchForProblems(page);
  await open(page);
  await expect(count(page)).toHaveText(`${TOTAL} models`);
  await expect(cards(page)).toHaveCount(48);
  await page.getByTestId('models-more').click();
  await expect(cards(page)).toHaveCount(TOTAL);
  await expect(page.getByTestId('models-more')).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('the rest of the list loads by itself when the end scrolls into view', async ({ page }) => {
  await open(page);
  await expect(cards(page)).toHaveCount(48);
  await page.getByTestId('models-more').scrollIntoViewIfNeeded();
  await expect(cards(page)).toHaveCount(TOTAL);
});

test('a card shows name, copyable id, provider, badges, price and context', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
  await open(page, 'models/?q=gpt-6.1-sol');
  const sol = card(page, 'openai/gpt-6.1-sol');
  await expect(sol).toContainText('openai/gpt-6.1-sol');
  await expect(sol.getByTestId('model-price')).toHaveText('$2.00 in · $10.00 out per 1M tokens');
  await expect(sol).toContainText('1.1M tokens');
  await expect(sol).toContainText('Vision');
  await expect(sol.getByTestId('free-badge')).toHaveCount(0);
  await sol.getByTestId('model-copy').click();
  await expect(
    page.getByTestId('toast').filter({ hasText: 'Copied openai/gpt-6.1-sol' }),
  ).toBeVisible();
});

test('only :free models get the Free badge, and media models show their unit', async ({ page }) => {
  await open(page, 'models/?q=free');
  await expect(card(page, 'qwen/qwen3.8-27b:free').getByTestId('free-badge')).toBeVisible();
  await expect(card(page, 'qwen/qwen3.8-27b:free').getByTestId('model-price')).toHaveText('Free');
  await open(page, 'models/?q=veo');
  const veo = card(page, 'google/veo-3.1');
  await expect(veo.getByTestId('free-badge')).toHaveCount(0);
  await expect(veo.getByTestId('model-price')).toHaveText('Billed per second of video');
});

test('the price is shown in the unit each model is billed in', async ({ page }) => {
  await open(page, 'models/?q=flux.2-pro');
  await expect(card(page, 'black-forest-labs/flux.2-pro').getByTestId('model-price')).toHaveText(
    '≈ $0.031 per image',
  );
  await open(page, 'models/?q=kokoro');
  await expect(card(page, 'hexgrad/kokoro-82m').getByTestId('model-price')).toHaveText(
    '$0.62 per 1M characters',
  );
  // A chat model with audio tokens: the token price, then the audio price on a line of its own.
  await open(page, 'models/?q=openai/gpt-audio');
  const audio = card(page, 'openai/gpt-audio');
  await expect(audio.getByTestId('model-price')).toHaveText('$2.50 in · $10.00 out per 1M tokens');
  await expect(audio.getByTestId('model-price-extra')).toHaveText(
    'Audio: $32.00 in · $64.00 out per 1M tokens',
  );
  await open(page, 'models/?q=gemini-3.1-flash-image');
  await expect(
    card(page, 'google/gemini-3.1-flash-image').getByTestId('model-price-extra'),
  ).toHaveText('Image output: ≈ $0.25 per image');
});

test('?q= pre-fills the search, and typing keeps the address in step', async ({ page }) => {
  await open(page, 'models/?q=kokoro');
  await expect(page.getByTestId('models-search')).toHaveValue('kokoro');
  await expect(cards(page)).toHaveCount(1);
  await expect(card(page, 'hexgrad/kokoro-82m')).toBeVisible();
  await expect(count(page)).toHaveText(`1 of ${TOTAL} models match`);

  await page.getByTestId('models-search').fill('whisper');
  await expect(card(page, 'openai/whisper-1')).toBeVisible();
  await expect(page).toHaveURL(/[?&]q=whisper/);

  await page.getByTestId('models-search').fill('');
  await expect(page).not.toHaveURL(/[?&]q=/);
  await expect(count(page)).toHaveText(`${TOTAL} models`);
});

test('search with no match shows an empty state that resets', async ({ page }) => {
  await open(page, 'models/?q=zzzzqqqq');
  await expect(page.getByTestId('models-empty')).toBeVisible();
  await page.getByTestId('models-empty').getByRole('button', { name: 'Reset filters' }).click();
  await expect(count(page)).toHaveText(`${TOTAL} models`);
  await expect(page.getByTestId('models-search')).toHaveValue('');
});

test('filters: capability, modality, provider, free only, price and context', async ({ page }) => {
  await open(page);

  await page.getByTestId('models-capability').selectOption('video');
  await expect(cards(page)).toHaveCount(5);
  await page.getByTestId('models-capability').selectOption('music');
  await expect(cards(page)).toHaveCount(2);
  await page.getByTestId('models-reset').click();
  await expect(count(page)).toHaveText(`${TOTAL} models`);

  await page.getByTestId('models-output').selectOption('speech');
  await expect(card(page, 'hexgrad/kokoro-82m')).toBeVisible();
  await page.getByTestId('models-input').selectOption('audio');
  await expect(cards(page)).toHaveCount(0);
  await page.getByTestId('models-reset').click();

  await page.getByTestId('models-provider').selectOption('qwen');
  await expect(cards(page)).toHaveCount(2);
  await page.getByTestId('models-free-only').check();
  await expect(cards(page)).toHaveCount(1);
  await expect(card(page, 'qwen/qwen3.8-27b:free')).toBeVisible();
  await expect(page.getByTestId('models-reset')).toBeVisible();
  await page.getByTestId('models-reset').click();

  // Max price compares input plus output per 1M tokens: gpt-6.1-sol is $12.
  await page.getByTestId('models-capability').selectOption('vision');
  await page.getByTestId('models-max-price').fill('11');
  await expect(card(page, 'qwen/qwen3.8-omni-flash')).toBeVisible();
  await expect(card(page, 'openai/gpt-6.1-sol')).toHaveCount(0);
  await page.getByTestId('models-max-price').fill('12');
  await expect(card(page, 'openai/gpt-6.1-sol')).toBeVisible();
  await page.getByTestId('models-reset').click();

  await page.getByTestId('models-min-context').selectOption('1000000');
  await expect(card(page, 'anthropic/claude-sonnet-5.5')).toBeVisible();
  await expect(card(page, 'hexgrad/kokoro-82m')).toHaveCount(0);
});

test('sorts by name, price and context', async ({ page }) => {
  await open(page);
  const ids = () =>
    cards(page).evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-model-id')));

  await page.getByTestId('models-sort').selectOption('context');
  expect((await ids())[0]).toBe('openrouter/auto');

  await page.getByTestId('models-sort').selectOption('price');
  // Free first, and every free card before the first priced one.
  const list = await ids();
  const firstPriced = list.findIndex(
    (id) => id && !id.endsWith(':free') && id !== 'openrouter/free',
  );
  expect(
    list.slice(0, firstPriced).every((id) => id?.endsWith(':free') || id === 'openrouter/free'),
  ).toBe(true);

  await page.getByTestId('models-sort').selectOption('name');
  const names = await cards(page).locator('h3').allTextContents();
  expect(names).toEqual(
    [...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
  );
});

test('a price limit says how many models it hides because they are not billed per token', async ({
  page,
}) => {
  await open(page);
  const note = page.getByTestId('models-price-note');
  await expect(note).toBeHidden();
  await page.getByTestId('models-max-price').fill('1');
  await expect(note).toBeVisible();
  await expect(note).toContainText('compares per-token prices');
  await expect(note).toContainText('billed per image, hour of audio, character or request');
  // Only video models: all 5 are billed per second, so all 5 are hidden.
  await page.getByTestId('models-capability').selectOption('video');
  await expect(note).toContainText('5 models');
  await expect(page.getByTestId('models-empty')).toBeVisible();
  await page.getByTestId('models-max-price').fill('');
  await expect(note).toBeHidden();
});

test('sorting by price keeps the units apart: free, then per token, then the other units', async ({
  page,
}) => {
  await open(page);
  await page.getByTestId('models-sort').selectOption('price');
  await page.getByTestId('models-more').scrollIntoViewIfNeeded();
  await expect(cards(page)).toHaveCount(TOTAL);
  const prices = await cards(page).evaluateAll((nodes) =>
    nodes.map((node) => node.querySelector('[data-testid="model-price"]')?.textContent ?? ''),
  );
  const tokens = (text: string) => text.endsWith('per 1M tokens');
  const lastToken = prices.map(tokens).lastIndexOf(true);
  const firstOther = prices.findIndex((text) => text !== 'Free' && !tokens(text));
  expect(prices[0]).toBe('Free');
  expect(lastToken).toBeGreaterThan(0);
  // Every per-token price comes before the first price in another unit.
  expect(lastToken).toBeLessThan(firstOther);
});

test('expiring models carry a warning badge', async ({ page }) => {
  await open(page, 'models/?q=laguna');
  const badge = card(page, 'poolside/laguna-s-2.1:free').getByTestId('expiry-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toContainText(/Expires Oct 31, 2026|Expired/);
  await expect(page.getByTestId('expiry-badge')).toHaveCount(1);
});

test('favorites persist, filter and update in place', async ({ page }) => {
  await open(page, 'models/?q=kokoro');
  const star = card(page, 'hexgrad/kokoro-82m').getByTestId('model-star');
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  await expect(star).toBeFocused();

  const saved = await page.evaluate(
    () =>
      (
        JSON.parse(localStorage.getItem('ortoolbox:settings') ?? '{}') as {
          models?: { favorites?: string[] };
        }
      ).models?.favorites,
  );
  expect(saved).toEqual(['hexgrad/kokoro-82m']);

  await open(page);
  await page.getByTestId('models-fav-only').check();
  await expect(cards(page)).toHaveCount(1);
  await expect(card(page, 'hexgrad/kokoro-82m').getByTestId('model-star')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Removing the last favorite while "Favorites only" is on empties the list.
  await card(page, 'hexgrad/kokoro-82m').getByTestId('model-star').click();
  await expect(page.getByTestId('models-empty')).toBeVisible();
});

test('recently used models come first as a strip that searches for them', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('models-recent')).toBeHidden();
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('ortoolbox:settings') ?? '{}') as Record<
      string,
      unknown
    >;
    settings['models'] = {
      favorites: [],
      recent: ['openai/whisper-1', 'hexgrad/kokoro-82m', 'gone/model'],
    };
    localStorage.setItem('ortoolbox:settings', JSON.stringify(settings));
  });
  await open(page);
  const strip = page.getByTestId('models-recent');
  await expect(strip).toBeVisible();
  // The model that is not in the catalog is left out.
  await expect(strip.getByTestId('recent-model')).toHaveCount(2);
  await strip.getByTestId('recent-model').first().click();
  await expect(page.getByTestId('models-search')).toHaveValue('openai/whisper-1');
  await expect(card(page, 'openai/whisper-1')).toBeVisible();
});

test('table view lists the same models, and the choice is remembered', async ({ page }) => {
  await open(page);
  await page.getByTestId('models-view-table').click();
  await expect(page.getByTestId('models-table')).toBeVisible();
  await expect(page.getByTestId('model-row')).toHaveCount(48);
  await expect(page.getByTestId('models-view-table')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('models-search').fill('whisper');
  await expect(page.getByTestId('model-row')).toHaveCount(1);
  const row = page.getByTestId('model-row');
  await expect(row).toContainText('openai/whisper-1');
  await expect(row.getByTestId('model-price')).toHaveText('$0.36 per hour of audio');

  await open(page);
  await expect(page.getByTestId('models-table')).toBeVisible();
  await page.getByTestId('models-view-cards').click();
  await expect(page.getByTestId('models-grid')).toBeVisible();
});

test('one read of the ledger serves every card: no card asks for its own model', async ({
  page,
  context,
}) => {
  await recordIndexReads(context);
  await open(page);
  await expect(cards(page).first().getByTestId('model-usage')).toHaveText('Not used yet');
  const reads = await indexReads(page);
  expect(reads.filter((index) => index === 'stats.model')).toEqual([]);
  expect(reads.filter((index) => index === 'stats.day').length).toBeLessThanOrEqual(2);
});

test('your own stats count requests for a model that was only a second model, and mark estimates', async ({
  page,
}) => {
  await open(page, 'models/?q=kokoro');
  await seedDb(page, {
    stats: [
      makeStats(utcDayAgo(1), {
        model: 'hexgrad/kokoro-82m',
        tool: 'bot-to-bot',
        runs: 0,
        requests: 3,
        costUsd: 0.03,
        latencyMsTotal: 1500,
      }),
    ],
  });
  const usage = card(page, 'hexgrad/kokoro-82m').getByTestId('model-usage');
  await expect(usage).toHaveText('3 requests · avg 500 ms · $0.03');
  await seedDb(page, {
    stats: [
      makeStats(utcDayAgo(2), {
        model: 'hexgrad/kokoro-82m',
        tool: 'text-to-speech',
        runs: 1,
        requests: 1,
        costUsd: 0.01,
        estimatedUsd: 0.01,
        latencyMsTotal: 500,
      }),
    ],
  });
  await expect(usage).toHaveText('1 run · avg 500 ms · ≈ $0.04');
});

test('your own stats appear on the cards of models you used', async ({ page }) => {
  await open(page, 'models/?q=kokoro');
  await expect(card(page, 'hexgrad/kokoro-82m').getByTestId('model-usage')).toHaveText(
    'Not used yet',
  );
  await seedDb(page, {
    stats: [
      makeStats(utcDayAgo(1), {
        model: 'hexgrad/kokoro-82m',
        tool: 'text-to-speech',
        runs: 2,
        requests: 2,
        costUsd: 0.04,
        latencyMsTotal: 3000,
      }),
      makeStats(utcDayAgo(2), {
        model: 'hexgrad/kokoro-82m',
        tool: 'text-to-speech',
        runs: 1,
        requests: 1,
        costUsd: 0.01,
        latencyMsTotal: 1500,
      }),
    ],
  });
  // A live update: stats changed while the page is open.
  await expect(card(page, 'hexgrad/kokoro-82m').getByTestId('model-usage')).toHaveText(
    '3 runs · avg 1.5 s · $0.05',
  );
});

test.describe('comparison', () => {
  /** Finds the model by its id (the list is paged) and ticks its Compare box. */
  const pick = async (page: Page, id: string) => {
    await page.getByTestId('models-search').fill(id);
    await card(page, id).getByTestId('model-compare').check();
  };

  test('select two to four models, compare side by side', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('compare-tray')).toBeHidden();
    await pick(page, 'openai/gpt-6.1-sol');
    await expect(page.getByTestId('compare-tray')).toBeVisible();
    await expect(page.getByTestId('compare-open')).toBeDisabled();
    await pick(page, 'qwen/qwen3.8-27b:free');
    await expect(page.getByTestId('compare-open')).toBeEnabled();
    await expect(page.getByTestId('compare-chip')).toHaveCount(2);

    await page.getByTestId('compare-open').click();
    const dialog = page.getByTestId('compare-dialog');
    await expect(dialog).toBeVisible();
    const table = dialog.getByTestId('compare-table');
    await expect(table.getByRole('columnheader', { name: /OpenAI: GPT/ })).toBeVisible();
    const row = (label: string) => table.getByRole('row', { name: new RegExp(`^${label}`) });
    await expect(row('Input, per 1M tokens')).toContainText('$2.00');
    await expect(row('Input, per 1M tokens')).toContainText('Free');
    await expect(row('Context window')).toContainText('1.1M context');
    await expect(row('Context window')).toContainText('262K context');
    await expect(row('Provider')).toContainText('openai');
    await expect(table.getByRole('rowheader', { name: 'tools' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).last().click();
    await expect(dialog).toHaveCount(0);
  });

  test('four is the limit; the rest are disabled until one is removed', async ({ page }) => {
    await open(page);
    for (const id of [
      'openai/gpt-6.1-sol',
      'qwen/qwen3.8-27b:free',
      'hexgrad/kokoro-82m',
      'openai/whisper-1',
    ]) {
      await pick(page, id);
    }
    await expect(page.getByTestId('compare-chip')).toHaveCount(4);
    await page.getByTestId('models-search').fill('veo');
    await expect(card(page, 'google/veo-3.1').getByTestId('model-compare')).toBeDisabled();
    await page.getByTestId('models-search').fill('gpt-6.1-sol');
    await expect(card(page, 'openai/gpt-6.1-sol').getByTestId('model-compare')).toBeEnabled();

    await page.getByTestId('compare-chip').first().getByRole('button').click();
    await expect(page.getByTestId('compare-chip')).toHaveCount(3);
    await expect(card(page, 'openai/gpt-6.1-sol').getByTestId('model-compare')).not.toBeChecked();
    await page.getByTestId('models-search').fill('veo');
    await expect(card(page, 'google/veo-3.1').getByTestId('model-compare')).toBeEnabled();

    await page.getByTestId('compare-clear').click();
    await expect(page.getByTestId('compare-tray')).toBeHidden();
  });

  test('the selection survives a filter change and works from the table', async ({ page }) => {
    await open(page);
    await pick(page, 'openai/gpt-6.1-sol');
    await page.getByTestId('models-search').fill('kokoro');
    await expect(cards(page)).toHaveCount(1);
    await expect(page.getByTestId('compare-chip')).toHaveCount(1);
    await page.getByTestId('models-view-table').click();
    await page.getByTestId('model-row').getByTestId('model-compare').check();
    await expect(page.getByTestId('compare-chip')).toHaveCount(2);
    await page.getByTestId('compare-open').click();
    await expect(page.getByTestId('compare-table')).toContainText('Kokoro');
  });
});

test('Refresh fetches the catalog again and says when it was updated', async ({ page, mock }) => {
  await open(page);
  await expect(page.getByTestId('models-updated')).toContainText('Updated');
  const before = mock.calls('/api/v1/models').length;
  await page.getByTestId('models-refresh').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Model list updated' })).toBeVisible();
  expect(mock.calls('/api/v1/models').length).toBe(before + 1);
  await expect(page.getByTestId('models-refresh')).toBeEnabled();
});

test('a catalog that cannot be loaded offers to try again', async ({ page, mock }) => {
  mock.json('GET', '/api/v1/models', { error: { code: 404, message: 'gone' } }, { status: 404 });
  await page.goto('models/');
  await expect(page.getByTestId('models-error')).toBeVisible({ timeout: 30_000 });
  mock.json('GET', '/api/v1/models', { data: catalog.data });
  await page.getByTestId('models-error').getByRole('button', { name: 'Try again' }).click();
  await expect(cards(page).first()).toBeVisible({ timeout: 30_000 });
});

test.describe('accessibility', () => {
  test('cards, table and the comparison dialog pass axe in light and dark', async ({ page }) => {
    test.slow(); // six axe passes over 48 cards
    await page.emulateMedia({ colorScheme: 'light' });
    await open(page);
    await card(page, 'openai/gpt-6.1-sol').getByTestId('model-compare').check();
    await card(page, 'qwen/qwen3.8-27b:free').getByTestId('model-compare').check();
    await expectNoSeriousA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark');
    await expectNoSeriousA11yViolations(page);

    await page.getByTestId('models-view-table').click();
    await expect(page.getByTestId('models-table')).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'light');
    await expectNoSeriousA11yViolations(page);

    await page.getByTestId('compare-open').click();
    await expect(page.getByTestId('compare-dialog')).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoSeriousA11yViolations(page);
  });

  test('works with the keyboard: search, filters, favorite, compare', async ({ page }) => {
    await open(page, 'models/?q=kokoro');
    const star = card(page, 'hexgrad/kokoro-82m').getByTestId('model-star');
    await star.focus();
    await page.keyboard.press('Enter');
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    const box = card(page, 'hexgrad/kokoro-82m').getByTestId('model-compare');
    await box.focus();
    await page.keyboard.press('Space');
    await expect(box).toBeChecked();
    await expect(page.getByTestId('compare-chip')).toHaveCount(1);
  });
});

test.describe('target sizes and phones', () => {
  const size = (locator: Locator) =>
    locator.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return { width: box.width, height: box.height };
    });
  const overflow = (page: Page) =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );

  test('the copy button and the comparison chip button are at least 24 × 24 px', async ({
    page,
  }) => {
    await open(page, 'models/?q=kokoro');
    const copy = await size(card(page, 'hexgrad/kokoro-82m').getByTestId('model-copy'));
    expect(copy.width).toBeGreaterThanOrEqual(24);
    expect(copy.height).toBeGreaterThanOrEqual(24);
    await card(page, 'hexgrad/kokoro-82m').getByTestId('model-compare').check();
    const close = await size(page.getByTestId('compare-chip').getByRole('button'));
    expect(close.width).toBeGreaterThanOrEqual(24);
    expect(close.height).toBeGreaterThanOrEqual(24);
    // The table view's copy button too.
    await page.getByTestId('models-view-table').click();
    const rowCopy = await size(page.getByTestId('model-row').getByTestId('model-copy'));
    expect(rowCopy.width).toBeGreaterThanOrEqual(24);
    expect(rowCopy.height).toBeGreaterThanOrEqual(24);
  });

  test('nothing makes the page scroll sideways on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.getByTestId('models-view-table').click();
    await expect(page.getByTestId('models-table')).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.getByTestId('model-row').nth(0).getByTestId('model-compare').check();
    await page.getByTestId('model-row').nth(1).getByTestId('model-compare').check();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.getByTestId('compare-open').click();
    await expect(page.getByTestId('compare-table')).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});
