/**
 * Stage 2 gate: first-run onboarding on Home. Paste a key (format-checked, saved, checked with GET /key),
 * optional free-only, pick favourites, try a sample; or skip. Never shown again once finished or skipped.
 */
import { expect, TEST_API_KEY, test } from '../mock/index.ts';
import { watchForProblems } from './support.ts';

test('paste a key, pick favourites and try a sample', async ({ page, mock }) => {
  test.slow(); // the whole first-run journey
  const problems = await watchForProblems(page);
  await page.goto('');
  const wizard = page.getByTestId('onboarding');
  await expect(wizard).toBeVisible();
  await expect(wizard.getByRole('heading', { level: 3 })).toHaveText('Connect OpenRouter');

  // A malformed key is refused before anything is stored.
  await page.getByTestId('key-input').fill('hello');
  await page.getByTestId('key-save').click();
  await expect(page.getByTestId('key-feedback')).toHaveText('OpenRouter keys start with “sk-or-”.');
  await expect(page.getByTestId('key-input')).toHaveClass(/is-invalid/);

  await page.getByTestId('key-input').fill(`  ${TEST_API_KEY}  `);
  await page.getByTestId('key-save').click();
  await expect(page.getByTestId('onboarding-connected')).toContainText('sk-or-…0000');
  await expect(page.getByTestId('key-chip')).toHaveAttribute('aria-label', 'Key: Default');
  const checks = mock.calls('/api/v1/key');
  expect(checks).toHaveLength(1);
  expect(checks[0]?.headers['authorization']).toBe(`Bearer ${TEST_API_KEY}`);

  await page.getByTestId('onboarding-free-only').check();
  await expect(page.getByTestId('free-only-badge')).toBeVisible();
  await page.getByTestId('onboarding-next').click();

  await expect(wizard.getByRole('heading', { level: 3 })).toHaveText('Pick your favourite tools');
  for (const id of ['chat', 'ocr', 'text-to-speech']) {
    const pick = page.getByTestId(`pick-tool-${id}`);
    await pick.click();
    await expect(pick).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(wizard).toContainText('3 picked');
  await page.getByTestId('onboarding-next').click();

  await expect(wizard.getByRole('heading', { level: 3 })).toHaveText('Try a sample');
  await page.getByTestId('try-chat').click();
  await expect(page).toHaveURL(/\/tools\/chat\/$/);
  await expect(page.getByTestId('stub-prompt')).toHaveValue('A sample for Chat.');

  await page.goto('');
  await expect(page.getByTestId('onboarding')).toHaveCount(0);
  // Free-only is on and all three have a free model, so each card says "Free".
  await expect(page.getByTestId('favourites').getByRole('heading', { level: 3 })).toHaveText([
    /^Chat\s*Free$/,
    /^OCR\s*Free$/,
    /^Text-to-speech\s*Free$/,
  ]);
  expect(problems).toEqual([]);
});

test('a key OpenRouter rejects is not kept', async ({ page, mock }) => {
  mock.json(
    'GET',
    '/api/v1/key',
    { error: { message: 'No auth credentials found', code: 401 } },
    { status: 401 },
  );
  await page.goto('');
  await page.getByTestId('key-input').fill(TEST_API_KEY);
  await page.getByTestId('key-save').click();
  await expect(page.getByTestId('key-feedback')).toHaveText(
    'OpenRouter rejected this key. Check that you copied all of it.',
  );
  await expect(page.getByTestId('key-chip')).toHaveText(/Add key/);
});

test('skipping ends onboarding for good', async ({ page }) => {
  await page.goto('');
  await page.getByTestId('onboarding-skip').click();
  await expect(page.getByTestId('onboarding')).toHaveCount(0);
  await expect(page.getByTestId('toast')).toContainText('Setup skipped.');
  await expect(page.getByTestId('home-search')).toBeFocused();
  await page.reload();
  await expect(page.getByTestId('page-title')).toHaveText('ORtoolbox');
  await expect(page.getByTestId('onboarding')).toHaveCount(0);
});

test('finishing without a sample also ends it, and steps can go back', async ({ page }) => {
  await page.goto('');
  await page.getByTestId('onboarding-next').click();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByTestId('onboarding').getByRole('heading', { level: 3 })).toHaveText(
    'Connect OpenRouter',
  );
  await page.getByTestId('onboarding-next').click();
  await page.getByTestId('onboarding-next').click();
  await page.getByTestId('onboarding-finish').click();
  await expect(page.getByTestId('onboarding')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('onboarding')).toHaveCount(0);
});
