/**
 * App-state helpers for the shell specs: seed settings (onboarding done by default) and, optionally, a stored
 * test key, all in one `seedLocalStorage` call (it seeds once per browser context).
 */
import type { BrowserContext, Page } from '@playwright/test';
import { seedLocalStorage, TEST_API_KEY } from '../mock/index.ts';

export const TEST_KEY_ID = 'key-test';

/** The exact `ortoolbox:keys` file for one unlocked test key. */
export function testKeysFile(): Record<string, unknown> {
  return {
    version: 1,
    keys: [
      {
        id: TEST_KEY_ID,
        name: 'Test key',
        colour: '#0f766e',
        masked: 'sk-or-…0000',
        source: 'pasted',
        createdAt: 1_750_000_000_000,
        noRetention: false,
        secret: TEST_API_KEY,
        enc: null,
      },
    ],
    lock: null,
  };
}

export async function seedApp(
  context: BrowserContext,
  options: { settings?: Record<string, unknown>; key?: boolean } = {},
): Promise<void> {
  await seedLocalStorage(context, {
    'ortoolbox:settings': { onboarding: { completed: true }, ...options.settings },
    ...(options.key ? { 'ortoolbox:keys': testKeysFile() } : {}),
  });
}

/**
 * Presses Tab until the element with `testId` has focus (keyboard-only navigation); fails after `max` presses.
 * Aim it at buttons and fields: WebKit, like Safari's default setting, leaves links out of the Tab order.
 */
export async function tabTo(page: Page, testId: string, max = 40): Promise<void> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    if (focused === testId) return;
  }
  throw new Error(`Tab never reached [data-testid="${testId}"]`);
}
