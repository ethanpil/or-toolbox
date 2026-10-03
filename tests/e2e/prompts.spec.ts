/**
 * Stage 2 gate: prompts per tool. Save current, Use, Rename, Copy, Save from Recent, Delete with Undo, Clear
 * recent / saved / all with confirmation and Undo, and live updates across tabs.
 *
 * Recent prompts are written by runs; no tool can run yet, so the specs put them straight into IndexedDB (the
 * schema of src/core/storage/db.ts) and announce the change on the app's bus, as the prompts service would.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '../mock/index.ts';
import { seedApp } from './app.ts';
import { watchForProblems } from './support.ts';

async function seedRecent(page: Page, tool: string, texts: string[]): Promise<void> {
  await page.evaluate(
    async ({ tool, texts }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('ortoolbox');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('open failed'));
      });
      const tx = db.transaction('prompts', 'readwrite');
      texts.forEach((text, index) => {
        const at = Date.now() - index * 60_000;
        tx.objectStore('prompts').put({
          id: `recent-${tool}-${index}`,
          tool,
          kind: 'recent',
          name: null,
          text,
          settings: { temperature: index },
          createdAt: at,
          usedAt: at,
        });
      });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('write failed'));
      });
      db.close();
      const bus = new BroadcastChannel('ortoolbox');
      bus.postMessage({ type: 'prompts-changed', tool });
      bus.close();
    },
    { tool, texts },
  );
}

const panel = (page: Page) => page.getByTestId('prompts-panel');
const entries = (page: Page, kind: 'recent' | 'saved') =>
  page.getByTestId(`prompts-${kind}`).getByTestId('prompt-entry');

async function openPanel(page: Page, kind: 'recent' | 'saved'): Promise<void> {
  if (!(await panel(page).isVisible())) await page.getByTestId('prompts-button').click();
  await expect(panel(page)).toBeVisible();
  await page.getByTestId(`prompts-tab-${kind}`).click();
}

async function answerPrompt(page: Page, value: string): Promise<void> {
  const input = page.getByTestId('prompt-input');
  await expect(input).toBeFocused();
  await input.fill(value);
  await page.getByTestId('prompt-dialog').getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('prompt-dialog')).toHaveCount(0);
}

async function confirm(page: Page): Promise<void> {
  const dialog = page.locator('.modal.show');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('dialog-confirm').click();
  await expect(page.locator('.modal')).toHaveCount(0);
}

test.beforeEach(async ({ context }) => {
  await seedApp(context);
});

test('save the current prompt, use it, rename it, copy it', async ({ page, context }) => {
  test.slow(); // many dialogs in a row
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
  const problems = await watchForProblems(page);
  await page.goto('tools/chat/');
  const prompt = page.getByTestId('tool-prompt');
  await prompt.fill('Summarise the meeting notes');

  await openPanel(page, 'saved');
  await expect(page.getByTestId('prompts-saved')).toContainText('No saved prompts');
  await page.getByTestId('prompts-save-current').click();
  await answerPrompt(page, 'Meeting summary');
  await expect(entries(page, 'saved')).toHaveCount(1);
  await expect(entries(page, 'saved').getByTestId('prompt-name')).toHaveText('Meeting summary');
  await expect(page.getByTestId('prompts-tab-saved')).toHaveAttribute(
    'aria-label',
    'Saved, 1 prompt',
  );

  // Use restores the form and closes the panel.
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  await prompt.fill('Something else');
  await openPanel(page, 'saved');
  await entries(page, 'saved').getByTestId('prompt-use').click();
  await expect(panel(page)).toBeHidden();
  await expect(prompt).toHaveValue('Summarise the meeting notes');

  // Rename.
  await openPanel(page, 'saved');
  await entries(page, 'saved').getByTestId('prompt-rename').click();
  await answerPrompt(page, 'Weekly summary');
  await expect(entries(page, 'saved').getByTestId('prompt-name')).toHaveText('Weekly summary');

  // Copy.
  await entries(page, 'saved').getByTestId('prompt-copy').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Prompt copied.' })).toBeVisible();
  if (test.info().project.name === 'chromium') {
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'Summarise the meeting notes',
    );
  }
  expect(problems).toEqual([]);
});

test('save from Recent, delete with Undo', async ({ page }) => {
  await page.goto('tools/ocr/');
  await openPanel(page, 'recent');
  await seedRecent(page, 'ocr', ['Extract the totals', 'Read the handwriting']);
  await expect(entries(page, 'recent')).toHaveCount(2);
  await expect(entries(page, 'recent').first().getByTestId('prompt-text')).toHaveText(
    'Extract the totals',
  );

  // Use restores the settings saved with a Recent entry too (the stub keeps only the text).
  await entries(page, 'recent').nth(1).getByTestId('prompt-save').click();
  await answerPrompt(page, '');
  await page.getByTestId('prompts-tab-saved').click();
  await expect(entries(page, 'saved')).toHaveCount(1);
  await expect(entries(page, 'saved').getByTestId('prompt-text')).toHaveText(
    'Read the handwriting',
  );

  // Delete asks first; Undo brings it back.
  await page.getByTestId('prompts-tab-recent').click();
  await entries(page, 'recent').first().getByTestId('prompt-delete').click();
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toContainText('Delete this prompt?');
  await dialog.getByTestId('dialog-cancel').click();
  await expect(entries(page, 'recent')).toHaveCount(2);

  await entries(page, 'recent').first().getByTestId('prompt-delete').click();
  await confirm(page);
  await expect(entries(page, 'recent')).toHaveCount(1);
  const toast = page.getByTestId('toast').filter({ hasText: 'Prompt deleted.' });
  await toast.getByTestId('toast-undo').click();
  await expect(entries(page, 'recent')).toHaveCount(2);
  await expect(entries(page, 'recent').first().getByTestId('prompt-text')).toHaveText(
    'Extract the totals',
  );
});

/** OCR with two Recent prompts and one Saved one, the panel open on Recent. */
async function seedBothLists(page: Page): Promise<void> {
  await page.goto('tools/ocr/');
  await openPanel(page, 'recent');
  await seedRecent(page, 'ocr', ['One', 'Two']);
  await expect(entries(page, 'recent')).toHaveCount(2);
  // The panel's backdrop covers the form, so type through the DOM (with the input event a real tool listens to).
  await page.getByTestId('tool-prompt').evaluate((el: HTMLTextAreaElement) => {
    el.value = 'Saved one';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.getByTestId('prompts-save-current').click();
  await answerPrompt(page, 'Kept');
  await expect(entries(page, 'saved')).toHaveCount(1);
}

async function clearAndConfirm(page: Page, which: 'recent' | 'saved' | 'all'): Promise<void> {
  await page.getByTestId('prompts-clear').click();
  await page.getByTestId(`clear-${which}`).click();
  await expect(page.getByTestId('clear-confirm')).toBeVisible();
  await confirm(page);
}

async function undoClear(page: Page): Promise<void> {
  await page
    .getByTestId('toast')
    .filter({ hasText: 'Cleared' })
    .last()
    .getByTestId('toast-undo')
    .click();
}

test('clear recent asks first and can be undone', async ({ page }) => {
  await seedBothLists(page);
  await clearAndConfirm(page, 'recent');
  await expect(entries(page, 'recent')).toHaveCount(0);
  await expect(entries(page, 'saved')).toHaveCount(1);
  await undoClear(page);
  await expect(entries(page, 'recent')).toHaveCount(2);
});

test('clear saved asks first and can be undone', async ({ page }) => {
  await seedBothLists(page);
  await clearAndConfirm(page, 'saved');
  await expect(entries(page, 'saved')).toHaveCount(0);
  await expect(entries(page, 'recent')).toHaveCount(2);
  await undoClear(page);
  await expect(entries(page, 'saved')).toHaveCount(1);
});

test('clear all for this tool asks first, can be undone, and leaves other tools alone', async ({
  page,
}) => {
  await seedBothLists(page);
  await clearAndConfirm(page, 'all');
  await expect(entries(page, 'recent')).toHaveCount(0);
  await expect(entries(page, 'saved')).toHaveCount(0);
  await undoClear(page);
  await expect(entries(page, 'recent')).toHaveCount(2);
  await expect(entries(page, 'saved')).toHaveCount(1);

  // Prompts are per tool: Chat has none of OCR's.
  await page.goto('tools/chat/');
  await openPanel(page, 'recent');
  await expect(entries(page, 'recent')).toHaveCount(0);
});

test('changes in one tab show up live in another', async ({ page, context }) => {
  test.slow(); // two pages at once
  await page.goto('tools/chat/');
  const other = await context.newPage();
  await other.goto('tools/chat/');
  // `other` only watches; every action happens in `page`, brought to the front (WebKit runs no transitions,
  // and so no dialogs, in a background tab). The sync is symmetric, so one direction proves it.
  await other.bringToFront();
  await openPanel(other, 'saved');
  await expect(other.getByTestId('prompts-saved')).toContainText('No saved prompts');

  await page.bringToFront();
  await page.getByTestId('tool-prompt').fill('Shared between tabs');
  await openPanel(page, 'saved');
  await page.getByTestId('prompts-save-current').click();
  await answerPrompt(page, 'From tab one');

  await expect(entries(other, 'saved')).toHaveCount(1);
  await expect(entries(other, 'saved').getByTestId('prompt-name')).toHaveText('From tab one');

  await entries(page, 'saved').getByTestId('prompt-delete').click();
  await confirm(page);
  await expect(entries(other, 'saved')).toHaveCount(0);
  await expect(other.getByTestId('prompts-saved')).toContainText('No saved prompts');
});

test('a note explains when recording recent prompts is off', async ({ page, context }) => {
  await context.addInitScript(() => {
    const raw = localStorage.getItem('ortoolbox:settings');
    const settings = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    localStorage.setItem(
      'ortoolbox:settings',
      JSON.stringify({ ...settings, data: { retentionDays: 90, recordRecentPrompts: false } }),
    );
  });
  await page.goto('tools/chat/');
  await openPanel(page, 'recent');
  await expect(page.getByTestId('recording-off')).toContainText('Recording recent prompts is off');
});

test('the panel keeps its focus trap after a dialog or the palette over it closes', async ({
  page,
}) => {
  await page.goto('tools/chat/');
  await page.getByTestId('tool-prompt').fill('Draft');
  await openPanel(page, 'saved');
  // From the keyboard: WebKit does not focus buttons on click, so a click leaves nothing to return to.
  await page.getByTestId('prompts-save-current').focus();
  await page.keyboard.press('Enter');
  await answerPrompt(page, 'Draft');
  await expect(page.getByTestId('prompts-save-current')).toBeFocused();
  const tabStaysInside = async (): Promise<void> => {
    for (let step = 0; step < 12; step++) {
      await page.keyboard.press('Tab');
      expect(await panel(page).evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
  };
  await tabStaysInside();

  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('palette-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('palette')).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await tabStaysInside();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
});
