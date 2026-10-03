/**
 * Budgets set in Settings take effect on a tool page: Hard stop with a tiny monthly limit blocks a run before
 * anything is sent. No built tool can start a run yet, so the spec starts one through the page's own core
 * (imported from /src, which only the dev server serves; see page-core.ts). Run:
 * `npm run e2e:dev -- tests/e2e/dev --project=chromium`.
 */
import { expect, test } from '../../mock/index.ts';
import { seedApp } from '../app.ts';
import { openWithCore } from './page-core.ts';

test('Hard stop and a tiny monthly limit set in Settings block a run on a tool page', async ({
  page,
  context,
  mock,
}) => {
  await seedApp(context, { key: true });
  await page.goto('settings/#budgets');
  await page.getByTestId('budget-mode-hard').check();
  const monthly = page.getByTestId('budget-monthly');
  await monthly.fill('0.01');
  await monthly.press('Enter');
  await expect(page.getByTestId('budget-monthly-meter-text')).toHaveText(
    '$0.00 of $0.01 · $0.01 left',
  );

  await openWithCore(page, 'tools/chat/', 'Chat');
  const result = await page.evaluate(async () => {
    try {
      await window.__core!.runs.begin({
        tool: 'chat',
        model: 'test/text-model',
        estimateUsd: 0.05,
        prompt: 'Too expensive',
      });
      return null;
    } catch (error) {
      const { code, message } = error as { code?: string; message?: string };
      return { code, message };
    }
  });
  expect(result).toEqual({
    code: 'budget-blocked',
    message: expect.stringContaining('above your $0.01 monthly limit') as unknown as string,
  });
  // Nothing was sent and nothing was recorded.
  expect(mock.calls('/api/v1/chat/completions')).toHaveLength(0);
  expect(await page.evaluate(async () => (await window.__core!.history.query({})).length)).toBe(0);
});
