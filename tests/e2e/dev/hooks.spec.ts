/**
 * Shell behaviour that needs a state no built tool can produce yet: a result that was not downloaded (leave
 * guard), a run in progress, and a run that crosses a budget rule (budget confirmation). The spec imports the
 * page's own core from /src, which only the dev server serves, so it runs in `npm run e2e:dev` and no test
 * hook ships in the bundles. Run: `npm run e2e:dev -- tests/e2e/dev --project=chromium`.
 */
import type { Page } from '@playwright/test';
import type { CoreServices } from '../../../src/core/types';
import { basePath } from '../../../vite-plugins/site.ts';
import { expect, test } from '../../mock/index.ts';
import { seedApp, TEST_KEY_ID } from '../app.ts';
import { watchForProblems } from '../support.ts';

declare global {
  interface Window {
    __core?: CoreServices;
  }
}

/** Puts the page's own core (the module instance the app uses) on `window.__core`. */
async function exposeCore(page: Page): Promise<void> {
  await page.evaluate(async (base) => {
    const module = (await import(/* @vite-ignore */ `${base}src/core/index.ts`)) as {
      getCore: () => CoreServices;
    };
    window.__core = module.getCore();
  }, basePath());
}

async function addResults(page: Page, kinds: ('image' | 'video')[]): Promise<void> {
  await page.evaluate((list) => {
    for (const kind of list) {
      window.__core!.results.add({
        tool: 'image-generation',
        kind,
        name: kind === 'image' ? 'cat.png' : 'cat.mp4',
        blob: new Blob([kind], { type: kind === 'image' ? 'image/png' : 'video/mp4' }),
      });
    }
  }, kinds);
}

test.describe('leave guard', () => {
  test.beforeEach(async ({ context }) => {
    await seedApp(context, { key: true });
  });

  test('asks before leaving with results that were not downloaded', async ({ page }) => {
    const problems = await watchForProblems(page);
    await page.goto('tools/image-generation/');
    await expect(page.getByTestId('page-title')).toHaveText('Image generation');
    await exposeCore(page);
    await addResults(page, ['image', 'video']);

    await page.getByRole('link', { name: 'Models', exact: true }).click();
    const guard = page.getByTestId('leave-guard');
    await expect(guard).toBeVisible();
    await expect(page.getByTestId('leave-guard-list')).toHaveText(
      '1 image and 1 video not downloaded',
    );
    await expect(page.getByTestId('leave-guard-stay')).toBeFocused();
    await page.getByTestId('leave-guard-stay').click();
    await expect(guard).toHaveCount(0);
    await expect(page).toHaveURL(/\/tools\/image-generation\/$/);

    await page.getByRole('link', { name: 'Models', exact: true }).click();
    await page.getByTestId('leave-guard-leave').click();
    await expect(page).toHaveURL(/\/models\/$/);
    expect(problems).toEqual([]);
  });

  test('Download all saves everything, then the way is clear', async ({ page }) => {
    await page.goto('tools/image-generation/');
    await expect(page.getByTestId('page-title')).toHaveText('Image generation');
    await exposeCore(page);
    await addResults(page, ['image']);
    await page.getByRole('link', { name: 'History', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByTestId('leave-guard-download').click();
    expect((await download).suggestedFilename()).toBe('cat.png');
    await expect(page.getByTestId('leave-guard')).toContainText('Nothing will be lost');
    await page.getByTestId('leave-guard-leave').click();
    await expect(page).toHaveURL(/\/history\/$/);
  });

  test('guards palette navigation too, and counts runs in progress', async ({ page }) => {
    await page.goto('tools/chat/');
    await expect(page.getByTestId('page-title')).toHaveText('Chat');
    await exposeCore(page);
    // A run that has begun and not finished (no request is made).
    await page.evaluate(async () => {
      await window.__core!.runs.begin({ tool: 'chat', model: 'test/text-model', estimateUsd: 0 });
    });
    await page.keyboard.press('Control+k');
    await page.getByTestId('palette-input').fill('privacy');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('leave-guard-list')).toHaveText('1 run in progress');
    await page.getByTestId('leave-guard-stay').click();
    await expect(page).toHaveURL(/\/tools\/chat\/$/);
  });
});

test.describe('budget confirmation', () => {
  test.beforeEach(async ({ context }) => {
    await seedApp(context, { key: true, settings: { budgets: { mode: 'warn', perRunUsd: 0.1 } } });
  });

  /** Starts a run estimated at $0.50 (over the $0.10 per-run threshold) and finishes it if allowed. */
  const begin = (page: Page) =>
    page.evaluate(async () => {
      try {
        const run = await window.__core!.runs.begin({
          tool: 'chat',
          model: 'test/text-model',
          estimateUsd: 0.5,
          prompt: 'A long essay',
        });
        await run.finish({ output: 'done' });
        return { ok: true, code: null };
      } catch (error) {
        return { ok: false, code: (error as { code?: string }).code ?? null };
      }
    });

  test('Cancel stops the run before anything is sent or recorded', async ({ page, mock }) => {
    await page.goto('tools/chat/');
    await expect(page.getByTestId('page-title')).toHaveText('Chat');
    await exposeCore(page);
    const result = begin(page);
    const dialog = page.getByTestId('budget-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('budget-reasons')).toContainText('Per-run threshold');
    await expect(page.getByTestId('budget-estimate')).toHaveText('≈ $0.50');
    await expect(dialog).toContainText('test/text-model');
    await expect(page.getByTestId('budget-cancel')).toBeFocused();
    await page.getByTestId('budget-cancel').click();

    expect(await result).toEqual({ ok: false, code: 'cancelled' });
    expect(await page.evaluate(async () => (await window.__core!.history.query({})).length)).toBe(
      0,
    );
    expect(mock.calls('/api/v1/chat/completions')).toHaveLength(0);
    await expect(page.getByTestId('error-toast')).toHaveCount(0);
  });

  test('Run anyway lets the run start', async ({ page }) => {
    await page.goto('tools/chat/');
    await expect(page.getByTestId('page-title')).toHaveText('Chat');
    await exposeCore(page);
    const result = begin(page);
    await page.getByTestId('budget-confirm').click();
    expect(await result).toEqual({ ok: true, code: null });
    const runs = await page.evaluate(() => window.__core!.history.query({}));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ keyId: TEST_KEY_ID, status: 'ok', prompt: 'A long essay' });
  });
});
