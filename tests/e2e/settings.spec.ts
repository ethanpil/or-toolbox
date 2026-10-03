/**
 * Stage 2: the Settings page. Deep links to every section (axe-clean in light and dark), keys (paste, balance,
 * default, remove with Undo), free-only mode, budgets, appearance, the passphrase lock, data deletion, and
 * backup: an export without keys holds no secret, and export with keys → Reset everything → import restores
 * settings and keys (the Stage 1 backup gate, on the real UI).
 *
 * Hard stop blocking a run needs a run, which no built tool can start yet: tests/e2e/dev/settings-budget.spec.ts
 * sets the budget here in the UI and checks `runs.begin` on a tool page (dev server only).
 */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { SETTINGS_SECTIONS } from '../../src/ui/shell/links.ts';
import {
  expect,
  type OpenRouterMock,
  seedLocalStorage,
  TEST_API_KEY,
  test,
} from '../mock/index.ts';
import { seedApp, TEST_KEY_ID, testKeysFile } from './app.ts';
import { expectNoSeriousA11yViolations, watchForProblems } from './support.ts';

const PASSPHRASE = 'correct horse battery staple';
/** PBKDF2 runs 600,000 rounds on purpose; several specs doing it at once on a busy machine need the room. */
const PBKDF2_WAIT = 60_000;

const section = (page: Page, id: string) => page.getByTestId(`settings-section-${id}`);

/** A `GET /key` answer with every field the Keys section shows. */
function mockKeyStatus(mock: OpenRouterMock): void {
  mock.json('GET', '/api/v1/key', {
    data: {
      label: 'sk-or-v1-tes...000',
      limit: 10,
      limit_remaining: 8.75,
      limit_reset: 'monthly',
      usage: 4.5,
      usage_monthly: 1.25,
      is_free_tier: false,
      free_model_daily_requests: { used: 12, limit: 50, remaining: 38 },
    },
  });
}

/** Two unlocked keys: the test key (default) and "Work". */
async function seedTwoKeys(page: Page, settings: Record<string, unknown> = {}): Promise<void> {
  const file = testKeysFile() as { keys: Record<string, unknown>[] };
  file.keys.push({
    ...file.keys[0],
    id: 'key-work',
    name: 'Work',
    colour: '#c2410c',
    masked: 'sk-or-…1111',
    createdAt: 1_760_000_000_000,
    secret: `${TEST_API_KEY.slice(0, -4)}1111`,
  });
  await seedLocalStorage(page.context(), {
    'ortoolbox:settings': {
      onboarding: { completed: true },
      defaultKeyId: TEST_KEY_ID,
      ...settings,
    },
    'ortoolbox:keys': file,
  });
}

test.describe('sections', () => {
  for (const { id, label } of SETTINGS_SECTIONS) {
    test(`#${id} opens from its deep link and passes axe in light and dark`, async ({
      page,
      context,
      mock,
    }) => {
      mockKeyStatus(mock);
      await seedApp(context, { key: true });
      const problems = await watchForProblems(page);
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(`settings/#${id}`);
      await expect(section(page, id)).toBeVisible();
      await expect(page.locator('.or-settings-panel:visible')).toHaveCount(1);
      await expect(page.locator(`section#${id}`)).toBeVisible();
      await expect(page.getByTestId(`settings-nav-${id}`)).toHaveAttribute('aria-current', 'true');
      await expect(section(page, id).getByRole('heading', { level: 2 })).toHaveText(label);
      await page.waitForLoadState('networkidle');
      await expectNoSeriousA11yViolations(page);
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark');
      await expectNoSeriousA11yViolations(page);
      expect(problems).toEqual([]);
    });
  }

  test('no section scrolls sideways at 320 px', async ({ page, context, mock }) => {
    mockKeyStatus(mock);
    await seedApp(context, { key: true });
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('settings/');
    for (const { id } of SETTINGS_SECTIONS) {
      await page.getByTestId(`settings-nav-${id}`).click();
      await expect(section(page, id)).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `horizontal scroll in #${id}`).toBeLessThanOrEqual(0);
    }
  });

  test('the navigation switches sections, moves focus to the heading and follows the hash', async ({
    page,
    context,
  }) => {
    await seedApp(context, { key: true });
    await page.goto('settings/');
    await expect(section(page, 'keys')).toBeVisible();
    await expect(page.getByTestId('settings-nav-keys')).toHaveAttribute('aria-current', 'true');

    await page.getByTestId('settings-nav-budgets').click();
    await expect(page).toHaveURL(/settings\/#budgets$/);
    await expect(section(page, 'budgets')).toBeVisible();
    await expect(section(page, 'keys')).toBeHidden();
    await expect(page.locator('#budgets-title')).toBeFocused();

    // A link from elsewhere on the page (or the palette) changes only the hash.
    await page.evaluate(() => {
      location.hash = '#backup';
    });
    await expect(section(page, 'backup')).toBeVisible();
    await expect(page.locator('#backup-title')).toBeFocused();
    await page.goBack();
    await expect(section(page, 'budgets')).toBeVisible();

    // The skip link's #main is not a section and changes nothing.
    await page.evaluate(() => {
      location.hash = '#main';
    });
    await expect(section(page, 'budgets')).toBeVisible();
  });

  test('the palette opens a section on this page', async ({ page, context }) => {
    await seedApp(context);
    await page.goto('settings/');
    await page.keyboard.press('Control+k');
    await page.getByTestId('palette-input').fill('passphrase lock');
    await page.keyboard.press('Enter');
    await expect(section(page, 'security')).toBeVisible();
    await expect(page.locator('#security-title')).toBeFocused();
  });

  test('changes made in another tab show up live', async ({ page, context }) => {
    await seedApp(context, { key: true });
    await page.goto('settings/#models');
    const other = await context.newPage();
    await other.goto('settings/#models');
    await expect(other.getByTestId('free-only-switch')).not.toBeChecked();

    await page.bringToFront();
    await page.getByTestId('free-only-switch').check();
    await expect(other.getByTestId('free-only-switch')).toBeChecked();
    await expect(other.getByTestId('free-only-impact')).toContainText('cannot run while');

    await page.getByTestId('settings-nav-keys').click();
    await page.getByTestId('key-rename').click();
    await page.getByTestId('prompt-input').fill('Renamed elsewhere');
    await page.getByTestId('rename-key-dialog').getByTestId('dialog-confirm').click();
    await other.getByTestId('settings-nav-keys').click();
    await expect(other.getByTestId('key-name')).toHaveText('Renamed elsewhere');
  });
});

test.describe('keys', () => {
  test('a pasted key shows masked, as default, with its balance', async ({
    page,
    context,
    mock,
  }) => {
    mockKeyStatus(mock);
    await seedApp(context);
    const problems = await watchForProblems(page);
    await page.goto('settings/#keys');
    await expect(page.getByTestId('keys-empty')).toBeVisible();

    await page.getByTestId('key-input').fill('not a key');
    await page.getByTestId('key-save').click();
    await expect(page.getByTestId('key-input')).toHaveClass(/is-invalid/);
    await expect(page.getByTestId('key-feedback')).toHaveText(
      'OpenRouter keys start with “sk-or-”.',
    );

    await page.getByTestId('key-input').fill(TEST_API_KEY);
    await page.getByTestId('key-save').click();
    const row = page.getByTestId('key-row');
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('key-masked')).toHaveText('sk-or-…0000');
    await expect(row.getByTestId('key-default-badge')).toBeVisible();
    await expect(row.getByTestId('key-source')).toHaveText('Pasted');
    await expect(row.getByTestId('key-usage')).toHaveText('$1.25');
    await expect(row.getByTestId('key-limit')).toContainText('$10.00');
    await expect(row.getByTestId('key-limit')).toContainText('resets monthly');
    await expect(row.getByTestId('key-remaining')).toHaveText('$8.75 left');
    await expect(row.getByTestId('key-free-daily')).toHaveText('12 of 50 used');
    // The secret is never put into the page.
    expect(await page.content()).not.toContain(TEST_API_KEY);
    expect(problems).toEqual([]);

    // Refresh asks OpenRouter again; a failure is shown in place.
    const before = mock.calls('/api/v1/key').length;
    mock.error('/api/v1/key', 401);
    await row.getByTestId('key-refresh').click();
    await expect(row.getByTestId('key-balance-error')).toContainText(
      'OpenRouter rejected this key',
    );
    expect(mock.calls('/api/v1/key').length).toBe(before + 1);
  });

  test('make default, rename, and remove with Undo (settings that pointed at it come back)', async ({
    page,
  }) => {
    await seedTwoKeys(page, {
      tools: { chat: { keyId: 'key-work' } },
      budgets: {
        mode: 'warn',
        perRunUsd: 0.1,
        monthlyUsd: null,
        perKeyMonthlyUsd: { 'key-work': 3 },
      },
    });
    await page.goto('settings/#keys');
    const work = page.getByTestId('key-row').filter({ hasText: 'Work' });
    const test1 = page.getByTestId('key-row').filter({ hasText: 'Test key' });
    await expect(test1.getByTestId('key-default-badge')).toBeVisible();

    await work.getByTestId('key-make-default').click();
    await expect(work.getByTestId('key-default-badge')).toBeVisible();
    await expect(test1.getByTestId('key-default-badge')).toHaveCount(0);
    await expect(page.getByTestId('key-chip')).toHaveAttribute('aria-label', 'Key: Work');
    // The toast can sit over this row's buttons, and a pointer resting on it pauses its timer.
    const madeDefault = page.getByTestId('toast').filter({ hasText: 'is now the default key' });
    await madeDefault.getByRole('button', { name: 'Close' }).click();
    await expect(madeDefault).toHaveCount(0);

    await work.getByTestId('key-rename').click();
    await page.getByTestId('prompt-input').fill('Work key');
    await page.getByTestId('rename-key-dialog').getByTestId('dialog-confirm').click();
    const renamed = page.getByTestId('key-row').filter({ hasText: 'Work key' });
    await expect(renamed.getByTestId('key-name')).toHaveText('Work key');

    // Remove asks first.
    await renamed.getByTestId('key-remove').click();
    await page.getByTestId('remove-key-dialog').getByTestId('dialog-cancel').click();
    await expect(page.getByTestId('key-row')).toHaveCount(2);
    await renamed.getByTestId('key-remove').click();
    await page.getByTestId('remove-key-dialog').getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('key-row')).toHaveCount(1);
    await expect(test1.getByTestId('key-default-badge')).toBeVisible();

    await page
      .getByTestId('toast')
      .filter({ hasText: 'removed' })
      .getByTestId('toast-undo')
      .click();
    await expect(page.getByTestId('key-row')).toHaveCount(2);
    await expect(renamed.getByTestId('key-default-badge')).toBeVisible();
    // The pin and the per-key budget the removal cleared are back too.
    await page.getByTestId('settings-nav-tools').click();
    await expect(page.getByTestId('tool-row-chat').getByTestId('tool-key')).toHaveValue('key-work');
    await page.getByTestId('settings-nav-budgets').click();
    await expect(
      page
        .locator('[data-testid="budget-key"][data-key-id="key-work"]')
        .getByTestId('budget-key-limit'),
    ).toHaveValue('3.00');
  });
});

test('free-only mode lists the capabilities and tools it blocks', async ({ page, context }) => {
  await seedApp(context);
  const problems = await watchForProblems(page);
  await page.goto('settings/#models');
  const impact = page.getByTestId('free-only-impact');
  await expect(impact).toContainText(
    'No free model for image generation, speech-to-text, video, music',
  );
  await expect(impact).toContainText('With free-only mode on, these tools could not run');
  await expect(page.getByTestId('free-requests-today')).toHaveText('0 free-model requests');
  await expect(page.getByTestId('default-model-text').getByTestId('default-model-id')).toHaveText(
    'openai/gpt-6-luna',
  );

  await page.getByTestId('free-only-switch').check();
  await expect(impact).toContainText('These tools cannot run while free-only mode is on');
  await expect(page.getByTestId('free-only-blocked-tools')).toContainText('Video studio');
  await expect(
    page.getByTestId('default-model-video').getByTestId('default-model-free'),
  ).toHaveText('No free model: blocked in free-only mode');
  await expect(
    page.getByTestId('default-model-text').getByTestId('default-model-free'),
  ).toContainText('qwen/qwen3.8-27b:free');
  await expect(page.getByTestId('free-only-badge')).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('free-only-switch')).toBeChecked();
  expect(problems).toEqual([]);
});

test('a default model changes with the picker and resets to the shipped one', async ({
  page,
  context,
}) => {
  await seedApp(context);
  await page.goto('settings/#models');
  const row = page.getByTestId('default-model-text');
  await expect(row.getByTestId('default-model-reset')).toBeDisabled();
  await row.getByTestId('default-model-change').click();
  await page.getByTestId('model-option-test/text-model').click();
  await expect(row.getByTestId('default-model-id')).toHaveText('test/text-model');
  await expect(row.getByTestId('default-model-custom')).toBeVisible();
  // The per-tool table shows the new default for tools without a pin.
  await page.getByTestId('settings-nav-tools').click();
  await expect(page.getByTestId('tool-row-chat').getByTestId('tool-model')).toContainText(
    'test/text-model',
  );
  await page.getByTestId('settings-nav-models').click();
  await row.getByTestId('default-model-reset').click();
  await expect(row.getByTestId('default-model-id')).toHaveText('openai/gpt-6-luna');
});

test('budgets: the mode and limits persist, and invalid amounts are refused', async ({
  page,
  context,
}) => {
  await seedApp(context, { key: true });
  await page.goto('settings/#budgets');
  await expect(page.getByTestId('budget-mode-warn')).toBeChecked();
  await expect(page.getByTestId('budget-per-run')).toHaveValue('0.10');

  await page.getByTestId('budget-mode-hard').check();
  const monthly = page.getByTestId('budget-monthly');
  await monthly.fill('0.01');
  await monthly.press('Enter');
  await expect(page.getByTestId('budget-monthly-meter-text')).toHaveText(
    '$0.00 of $0.01 · $0.01 left',
  );

  const perRun = page.getByTestId('budget-per-run');
  await perRun.fill('a lot');
  await perRun.press('Tab');
  await expect(perRun).toHaveClass(/is-invalid/);
  await expect(perRun).toHaveAttribute('aria-invalid', 'true');
  await expect(section(page, 'budgets').locator('.invalid-feedback:visible')).toHaveText(
    'Enter an amount in dollars, like 5 or 0.25.',
  );

  await page.reload();
  await expect(page.getByTestId('budget-mode-hard')).toBeChecked();
  await expect(page.getByTestId('budget-monthly')).toHaveValue('0.01');
  await expect(page.getByTestId('budget-per-run')).toHaveValue('0.10');
  await expect(page.getByTestId('budget-month-spend-value')).toHaveText('$0.00');

  await page.getByTestId('budget-mode-disabled').check();
  await expect(page.getByTestId('budgets-off')).toBeVisible();
});

test('appearance: theme and accent apply live and persist across a reload', async ({
  page,
  context,
}) => {
  await seedApp(context);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('settings/#appearance');
  const html = page.locator('html');
  const primary = (): Promise<string> =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bs-primary').trim(),
    );
  await expect(html).toHaveAttribute('data-bs-theme', 'light');

  await section(page, 'appearance').getByText('Dark', { exact: true }).click();
  await expect(html).toHaveAttribute('data-bs-theme', 'dark');
  await page.getByTestId('accent-preset-teal').click();
  await expect(html).toHaveAttribute('data-accent', '');
  expect(await primary()).toBe('#0f766e');
  await expect(page.getByTestId('accent-value')).toHaveText('#0f766e');
  await section(page, 'appearance').getByText('Compact', { exact: true }).click();
  await expect(html).toHaveAttribute('data-density', 'compact');
  await page.getByTestId('reduced-motion').check();
  await expect(html).toHaveAttribute('data-reduced-motion', '');

  await page.reload();
  await expect(html).toHaveAttribute('data-bs-theme', 'dark');
  expect(await primary()).toBe('#0f766e');
  await expect(page.getByTestId('accent-preset-teal')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('theme-option-dark')).toBeChecked();
  await expect(page.getByTestId('density-compact')).toBeChecked();

  await page.getByTestId('accent-reset').click();
  await expect(html).not.toHaveAttribute('data-accent', '');
  expect(await primary()).toBe('#4f46e5');
  await expect(page.getByTestId('accent-reset')).toBeDisabled();
});

test('passphrase lock: enable, lock now, unlock', async ({ page, context }) => {
  test.slow(); // PBKDF2 at 600,000 rounds, twice
  await seedApp(context, { key: true });
  await page.goto('settings/#security');
  await expect(page.getByTestId('lock-state')).toHaveText('Off');

  await page.getByTestId('lock-new').fill('short');
  await page.getByTestId('lock-enable').click();
  await expect(page.getByTestId('lock-new')).toHaveClass(/is-invalid/);
  await page.getByTestId('lock-new').fill(PASSPHRASE);
  await expect(page.getByTestId('lock-new-strength')).toHaveText('Good');
  await page.getByTestId('lock-confirm').fill('something else');
  await page.getByTestId('lock-enable').click();
  await expect(page.getByTestId('lock-confirm')).toHaveClass(/is-invalid/);

  await page.getByTestId('lock-confirm').fill(PASSPHRASE);
  await page.getByTestId('lock-enable').click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: PBKDF2_WAIT });
  const stored = await page.evaluate(() => localStorage.getItem('ortoolbox:keys') ?? '');
  expect(stored).not.toContain(TEST_API_KEY);
  expect(stored).toContain('"verifier"');

  await page.getByTestId('lock-now').click();
  await expect(page.getByTestId('lock-state')).toHaveText('Locked');
  await expect(page.getByTestId('lock-button')).toHaveAttribute('aria-label', 'Unlock keys');

  await page.getByTestId('lock-unlock').click();
  await page.getByTestId('unlock-passphrase').fill('wrong passphrase');
  await page.getByTestId('unlock-submit').click();
  await expect(page.getByTestId('unlock-error')).toHaveText('Wrong passphrase. Try again.', {
    timeout: PBKDF2_WAIT,
  });
  await page.getByTestId('unlock-passphrase').fill(PASSPHRASE);
  await page.getByTestId('unlock-submit').click();
  await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: PBKDF2_WAIT });

  // Auto-lock: 0–1440 minutes.
  const minutes = page.getByTestId('auto-lock-minutes');
  await expect(minutes).toHaveValue('15');
  await minutes.fill('2000');
  await minutes.press('Enter');
  await expect(minutes).toHaveClass(/is-invalid/);
  await minutes.fill('0');
  await minutes.press('Enter');
  await expect(minutes).not.toHaveClass(/is-invalid/);
});

/** Puts recent prompts and runs for `tool` straight into IndexedDB and tells the page, as the services would. */
async function seedHistory(page: Page, tool: string, prompts: number, runs: number): Promise<void> {
  await page.evaluate(
    async ({ tool, prompts, runs }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('ortoolbox');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('open failed'));
      });
      const tx = db.transaction(['prompts', 'runs'], 'readwrite');
      const now = Date.now();
      for (let i = 0; i < prompts; i++) {
        tx.objectStore('prompts').put({
          id: `p-${tool}-${i}`,
          tool,
          kind: i === 0 ? 'saved' : 'recent',
          name: null,
          text: `Prompt ${i}`,
          settings: {},
          createdAt: now,
          usedAt: now,
        });
      }
      for (let i = 0; i < runs; i++) {
        tx.objectStore('runs').put({
          id: `r-${tool}-${i}`,
          tool,
          status: 'ok',
          model: 'test/text-model',
          models: ['test/text-model'],
          keyId: 'key-test',
          keyName: 'Test key',
          startedAt: now - i,
          finishedAt: now - i,
          latencyMs: 1,
          title: `Run ${i}`,
          prompt: `Run ${i}`,
          settings: {},
          output: 'done',
          error: null,
          usage: {
            requests: 1,
            promptTokens: 1,
            completionTokens: 1,
            costUsd: 0,
            latencyMsTotal: 1,
            costEstimated: false,
            costUnknown: false,
            byModel: {},
          },
          reservedUsd: 0,
          jobId: null,
          meta: {},
          starred: false,
          groupId: null,
        });
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('write failed'));
      });
      db.close();
      const bus = new BroadcastChannel('ortoolbox');
      bus.postMessage({ type: 'prompts-changed', tool });
      bus.postMessage({ type: 'history-changed' });
      bus.close();
    },
    { tool, prompts, runs },
  );
}

test('data: delete one tool’s rows, then delete all with a typed confirmation', async ({
  page,
  context,
}) => {
  await seedApp(context, { key: true });
  const problems = await watchForProblems(page);
  await page.goto('settings/#data');
  const chat = page.getByTestId('data-row-chat');
  await expect(chat.getByTestId('data-recent')).toHaveText('0');
  await expect(page.getByTestId('storage-usage')).not.toContainText('Checking storage');

  await seedHistory(page, 'chat', 3, 2);
  await seedHistory(page, 'ocr', 2, 1);
  await expect(chat.getByTestId('data-recent')).toHaveText('2');
  await expect(chat.getByTestId('data-saved')).toHaveText('1');
  await expect(chat.getByTestId('data-runs')).toHaveText('2');
  await expect(page.getByTestId('data-totals')).toContainText('3');

  await chat.getByTestId('data-delete').click();
  await expect(page.getByTestId('delete-tool-dialog')).toContainText(
    '2 recent prompts, 1 saved prompt and 2 runs',
  );
  await page.getByTestId('delete-tool-dialog').getByTestId('dialog-confirm').click();
  await expect(chat.getByTestId('data-runs')).toHaveText('0');
  await expect(chat.getByTestId('data-delete')).toBeDisabled();
  await expect(page.getByTestId('data-row-ocr').getByTestId('data-runs')).toHaveText('1');

  await page.getByTestId('delete-all').click();
  const dialog = page.getByTestId('delete-all-dialog');
  await expect(dialog).toContainText('your keys, your settings and the spending stats');
  await expect(dialog.getByTestId('dialog-confirm')).toBeDisabled();
  await dialog.getByTestId('typed-confirm-input').fill('delete al');
  await expect(dialog.getByTestId('dialog-confirm')).toBeDisabled();
  await dialog.getByTestId('typed-confirm-input').fill('delete all');
  await dialog.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('data-row-ocr').getByTestId('data-runs')).toHaveText('0');
  await expect(page.getByTestId('data-totals')).toHaveText(/All tools\s*0\s*0\s*0/);

  // Keys and settings are untouched.
  await page.getByTestId('settings-nav-keys').click();
  await expect(page.getByTestId('key-row')).toHaveCount(1);
  expect(problems).toEqual([]);
});

test.describe('backup', () => {
  test('an export without keys contains no key at all', async ({ page, context }) => {
    await seedApp(context, { key: true });
    await page.goto('settings/#backup');
    await expect(page.getByTestId('backup-include-keys')).not.toBeChecked();
    const download = page.waitForEvent('download');
    await page.getByTestId('backup-export').click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^ortoolbox-\d{4}-\d{2}-\d{2}\.ortoolbox\.json$/);
    const text = readFileSync(await file.path(), 'utf8');
    expect(text).not.toContain('sk-or-');
    const backup = JSON.parse(text) as Record<string, unknown>;
    expect(backup).toMatchObject({ format: 'ortoolbox-backup', scope: 'all' });
    expect(backup).not.toHaveProperty('keys');
  });

  test('export with keys, reset everything, import: settings and keys come back', async ({
    page,
    context,
  }) => {
    test.slow(); // two PBKDF2 derivations and a full reset
    await seedApp(context, {
      key: true,
      settings: {
        budgets: { mode: 'hard', perRunUsd: 0.25, monthlyUsd: 20, perKeyMonthlyUsd: {} },
        appearance: {
          theme: 'light',
          accent: '#0f766e',
          density: 'comfortable',
          reducedMotion: false,
        },
        defaultModels: { text: 'test/text-model' },
      },
    });
    const problems = await watchForProblems(page);
    await page.goto('settings/#backup');

    // Export, keys included and encrypted.
    await page.getByTestId('backup-include-keys').check();
    await expect(page.getByTestId('backup-key-fields')).toBeVisible();
    await page.getByTestId('backup-passphrase').fill(PASSPHRASE);
    await page.getByTestId('backup-passphrase-confirm').fill(PASSPHRASE);
    const download = page.waitForEvent('download');
    await page.getByTestId('backup-export').click();
    const saved = await download;
    const text = readFileSync(await saved.path(), 'utf8');
    expect(text).not.toContain(TEST_API_KEY);
    expect(JSON.parse(text)).toHaveProperty('keys.ct');

    // Wipe everything.
    await page.getByTestId('settings-nav-data').click();
    await page.getByTestId('reset-everything').click();
    const reset = page.getByTestId('reset-dialog');
    await expect(reset).toContainText('your keys');
    await reset.getByTestId('typed-confirm-input').fill('reset everything');
    await reset.getByTestId('dialog-confirm').click();
    await expect(
      page.getByTestId('toast').filter({ hasText: 'Everything was reset' }),
    ).toBeVisible();
    await page.getByTestId('settings-nav-keys').click();
    await expect(page.getByTestId('keys-empty')).toBeVisible();
    await page.getByTestId('settings-nav-budgets').click();
    await expect(page.getByTestId('budget-mode-warn')).toBeChecked();

    // Import: the preview first, keys skipped until the passphrase is given.
    await page.getByTestId('settings-nav-backup').click();
    // Under its real name (Playwright keeps the download under a bare id, which the drop zone would refuse).
    await page
      .getByTestId('backup-drop')
      .locator('input[type=file]')
      .setInputFiles({
        name: saved.suggestedFilename(),
        mimeType: 'application/json',
        buffer: Buffer.from(text),
      });
    await expect(page.getByTestId('backup-file')).toContainText('.ortoolbox.json');
    const changes = page.getByTestId('backup-change');
    await expect(changes.filter({ hasText: 'Skip keys' })).toBeVisible();
    await expect(page.getByTestId('backup-passphrase-block')).toBeVisible();

    await page.getByTestId('backup-import-passphrase').fill('not the passphrase');
    await page.getByTestId('backup-preview-button').click();
    await expect(page.getByTestId('backup-import-passphrase')).toHaveClass(/is-invalid/, {
      timeout: PBKDF2_WAIT,
    });
    await expect(page.getByTestId('backup-apply')).toBeDisabled();

    await page.getByTestId('backup-import-passphrase').fill(PASSPHRASE);
    await page.getByTestId('backup-preview-button').click();
    await expect(changes.filter({ hasText: 'Add 1 key' })).toBeVisible({ timeout: PBKDF2_WAIT });
    await page.getByTestId('backup-apply').click();
    await expect(page.getByTestId('backup-restored')).toBeVisible({ timeout: PBKDF2_WAIT });

    // Everything is back, on the live page and after a reload.
    await page.reload();
    await page.getByTestId('settings-nav-keys').click();
    await expect(page.getByTestId('key-row').getByTestId('key-masked')).toHaveText('sk-or-…0000');
    await expect(page.getByTestId('key-row').getByTestId('key-default-badge')).toBeVisible();
    await page.getByTestId('settings-nav-budgets').click();
    await expect(page.getByTestId('budget-mode-hard')).toBeChecked();
    await expect(page.getByTestId('budget-per-run')).toHaveValue('0.25');
    await expect(page.getByTestId('budget-monthly')).toHaveValue('20.00');
    await page.getByTestId('settings-nav-models').click();
    await expect(page.getByTestId('default-model-text').getByTestId('default-model-id')).toHaveText(
      'test/text-model',
    );
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--bs-primary').trim(),
      ),
    ).toBe('#0f766e');
    expect(problems).toEqual([]);
  });
});

/** Downloads a backup with keys from the Backup section; returns its name and text. */
async function exportWithKeys(page: Page): Promise<{ name: string; text: string }> {
  await page.getByTestId('settings-nav-backup').click();
  await page.getByTestId('backup-include-keys').check();
  await page.getByTestId('backup-passphrase').fill(PASSPHRASE);
  await page.getByTestId('backup-passphrase-confirm').fill(PASSPHRASE);
  const download = page.waitForEvent('download');
  await page.getByTestId('backup-export').click();
  const saved = await download;
  return { name: saved.suggestedFilename(), text: readFileSync(await saved.path(), 'utf8') };
}

async function chooseBackup(page: Page, file: { name: string; text: string }): Promise<void> {
  await page
    .getByTestId('backup-drop')
    .locator('input[type=file]')
    .setInputFiles({
      name: file.name,
      mimeType: 'application/json',
      buffer: Buffer.from(file.text),
    });
}

const focusedTestId = (page: Page): Promise<string | null> =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? null);

test.describe('review fixes', () => {
  test('backup: Apply uses only what was previewed; any change asks for a new preview', async ({
    page,
    context,
  }) => {
    test.slow(); // PBKDF2 several times
    await seedApp(context, { key: true });
    await page.goto('settings/#backup');
    const file = await exportWithKeys(page);
    await expect(page.getByTestId('backup-passphrase-strength')).toHaveText('—');

    await chooseBackup(page, file);
    const apply = page.getByTestId('backup-apply');
    await expect(page.getByTestId('backup-change').filter({ hasText: 'Skip keys' })).toBeVisible();
    await expect(apply).toBeEnabled();

    // Typing the passphrase makes the shown preview stale.
    await page.getByTestId('backup-import-passphrase').fill(PASSPHRASE);
    await expect(apply).toBeDisabled();
    await expect(page.getByTestId('backup-stale')).toBeVisible();
    await page.getByTestId('backup-preview-button').click();
    await expect(apply).toBeEnabled({ timeout: PBKDF2_WAIT });
    await expect(page.getByTestId('backup-stale')).toBeHidden();

    // Editing it again, or changing the mode, disables Apply until Preview runs again.
    await page.getByTestId('backup-import-passphrase').fill('something else');
    await expect(apply).toBeDisabled();
    await page.getByTestId('backup-import-passphrase').fill(PASSPHRASE);
    await expect(apply).toBeDisabled();
    await page.getByTestId('backup-preview-button').click();
    await expect(apply).toBeEnabled({ timeout: PBKDF2_WAIT });
    await page.getByTestId('backup-mode-replace').check();
    await expect(apply).toBeDisabled();
  });

  test('backup: Replace lists what it deletes and asks before applying', async ({
    page,
    context,
  }) => {
    test.slow();
    await seedApp(context, { key: true });
    await page.goto('settings/#backup');
    const file = await exportWithKeys(page);
    // Something the backup does not have: Replace would delete it.
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('ortoolbox');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('open failed'));
      });
      const tx = db.transaction('prompts', 'readwrite');
      tx.objectStore('prompts').put({
        id: 'later',
        tool: 'chat',
        kind: 'saved',
        name: 'Made after the backup',
        text: 'x',
        settings: {},
        createdAt: 1,
        usedAt: 1,
      });
      await new Promise<void>((resolve) => {
        tx.oncomplete = () => resolve();
      });
      db.close();
    });

    await chooseBackup(page, file);
    await page.getByTestId('backup-mode-replace').check();
    await page.getByTestId('backup-preview-button').click();
    const destructive = page.getByTestId('backup-destructive');
    await expect(destructive).toBeVisible();
    await expect(destructive).toContainText('Delete 1 saved prompt');

    await page.getByTestId('backup-apply').click();
    const dialog = page.getByTestId('replace-confirm-dialog');
    await expect(dialog).toContainText('Delete 1 saved prompt');
    await expect(dialog).toContainText('runs and jobs that are not in the backup');
    await dialog.getByTestId('dialog-cancel').click();
    await expect(page.getByTestId('backup-restored')).toHaveCount(0);

    await page.getByTestId('backup-apply').click();
    await page.getByTestId('replace-confirm-dialog').getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('backup-restored')).toBeVisible({ timeout: PBKDF2_WAIT });
  });

  test('budgets: per-key labels follow renames', async ({ page, context }) => {
    await seedApp(context, { key: true });
    await page.goto('settings/#budgets');
    const label = page.locator('[data-testid="budget-key"][data-key-id="key-test"] label');
    await expect(label).toHaveText('Test key');
    await page.getByTestId('settings-nav-keys').click();
    await page.getByTestId('key-rename').click();
    await page.getByTestId('prompt-input').fill('Renamed');
    await page.getByTestId('rename-key-dialog').getByTestId('dialog-confirm').click();
    await page.getByTestId('settings-nav-budgets').click();
    await expect(label).toHaveText('Renamed');
  });

  test('Back to the bare URL shows the first section', async ({ page, context }) => {
    await seedApp(context);
    await page.goto('settings/');
    await page.getByTestId('settings-nav-budgets').click();
    await expect(section(page, 'budgets')).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/settings\/$/);
    await expect(section(page, 'keys')).toBeVisible();
    await expect(page.getByTestId('settings-nav-keys')).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('settings-nav-budgets')).not.toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  test('number fields validate as you type, announce the error and keep what you typed', async ({
    page,
    context,
  }) => {
    await seedApp(context);
    await page.goto('settings/#budgets');
    const perRun = page.getByTestId('budget-per-run');
    await perRun.fill('a lot');
    await expect(perRun).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('announcer-assertive')).toContainText(
      'Enter an amount in dollars',
    );
    await perRun.press('Tab');
    // Another change re-syncs the section; the field the user is fixing keeps their text and its error.
    await page.getByTestId('budget-mode-hard').check();
    await expect(perRun).toHaveValue('a lot');
    await expect(perRun).toHaveClass(/is-invalid/);
    await perRun.fill('0,25');
    await expect(perRun).not.toHaveClass(/is-invalid/);
    await perRun.press('Enter');
    await page.reload();
    await expect(page.getByTestId('budget-per-run')).toHaveValue('0.25');
  });

  test('Undo of a key removal works after the keys changed again', async ({ page }) => {
    await seedTwoKeys(page, { tools: { ocr: { keyId: 'key-work' } } });
    await page.goto('settings/#keys');
    const work = page.getByTestId('key-row').filter({ hasText: 'Work' });
    await work.getByTestId('key-remove').click();
    await page.getByTestId('remove-key-dialog').getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('key-row')).toHaveCount(1);
    // The removed row's button is gone: focus lands on the section heading, not the page.
    await expect(page.locator('#keys-title')).toBeFocused();
    // Another change to the keys file after the removal.
    await page.getByTestId('key-no-retention').check();
    await page
      .getByTestId('toast')
      .filter({ hasText: 'removed' })
      .getByTestId('toast-undo')
      .click();
    await expect(page.getByTestId('key-row')).toHaveCount(2);
    await expect(page.getByTestId('key-row').first().getByTestId('key-no-retention')).toBeChecked();
    await expect(page.getByTestId('error-toast')).toHaveCount(0);
    await page.getByTestId('settings-nav-tools').click();
    await expect(page.getByTestId('tool-row-ocr').getByTestId('tool-key')).toHaveValue('key-work');
  });

  test('focus stays on a sensible control after re-renders', async ({ page, context, mock }) => {
    test.slow(); // PBKDF2
    mockKeyStatus(mock);
    await seedApp(context, { key: true });
    await page.goto('settings/#keys');
    await expect(page.getByTestId('key-usage')).toHaveText('$1.25');

    await page.getByTestId('key-refresh').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('key-usage')).toHaveText('$1.25');
    expect(await focusedTestId(page)).toBe('key-refresh');

    // A failed forced refresh never says "updated".
    mock.error('/api/v1/key', 401, undefined, { method: 'GET' });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('key-balance-error')).toBeVisible();
    await expect(page.getByTestId('announcer-polite')).toHaveText(
      'The balance of Test key could not be checked.',
    );
    expect(await focusedTestId(page)).toBe('key-refresh');

    // The lock: the toggle button keeps focus as it flips between Lock now and Unlock.
    await page.getByTestId('settings-nav-security').click();
    await page.getByTestId('lock-new').fill(PASSPHRASE);
    await page.getByTestId('lock-confirm').fill(PASSPHRASE);
    await page.getByTestId('lock-confirm').press('Enter');
    await expect(page.getByTestId('lock-state')).toHaveText('Unlocked', { timeout: PBKDF2_WAIT });
    expect(await focusedTestId(page)).toBe('lock-now');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('lock-state')).toHaveText('Locked');
    expect(await focusedTestId(page)).toBe('lock-unlock');
  });

  test('per-tool delete leaves focus in the table card', async ({ page, context }) => {
    await seedApp(context, { key: true });
    await page.goto('settings/#data');
    await expect(page.getByTestId('data-row-chat').getByTestId('data-recent')).toHaveText('0');
    await seedHistory(page, 'chat', 2, 1);
    const remove = page.getByTestId('data-row-chat').getByTestId('data-delete');
    await expect(remove).toBeEnabled();
    await remove.focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('delete-tool-dialog').getByTestId('dialog-confirm').click();
    await expect(remove).toBeDisabled();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document
              .querySelector('[data-testid="data-per-tool"]')
              ?.contains(document.activeElement) ?? false,
        ),
      )
      .toBe(true);
  });

  test('a mode that cannot be saved does not stay selected', async ({ page, context }) => {
    await seedApp(context);
    await page.goto('settings/#budgets');
    await expect(page.getByTestId('budget-mode-warn')).toBeChecked();
    // Browser storage is full: the next settings write fails as it would at the quota.
    await page.evaluate(() => {
      const original = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem')!.value as (
        this: Storage,
        key: string,
        value: string,
      ) => void;
      Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
        if (key === 'ortoolbox:settings') throw new DOMException('full', 'QuotaExceededError');
        original.call(this, key, value);
      };
    });
    // click(), not check(): the radio is put back at once, which check() would report as a failure.
    await page.getByTestId('budget-mode-hard').click();
    await expect(page.getByTestId('error-toast')).toBeVisible();
    await expect(page.getByTestId('budget-mode-warn')).toBeChecked();
    await expect(page.getByTestId('budget-mode-hard')).not.toBeChecked();
  });

  test('the Reset dialog’s backup link closes it and opens Backup', async ({ page, context }) => {
    await seedApp(context);
    await page.goto('settings/#data');
    await page.getByTestId('reset-everything').click();
    await page.getByTestId('reset-dialog').getByRole('link', { name: 'Download a backup' }).click();
    await expect(page.getByTestId('reset-dialog')).toHaveCount(0);
    await expect(section(page, 'backup')).toBeVisible();
  });

  test('accent presets are at least 24 px', async ({ page, context }) => {
    await seedApp(context);
    await page.goto('settings/#appearance');
    const box = await page.getByTestId('accent-preset-teal').boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(24);
    expect(box?.height).toBeGreaterThanOrEqual(24);
  });
});
