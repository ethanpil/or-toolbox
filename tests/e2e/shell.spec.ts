/**
 * Stage 2 gate: the shell. Keyboard-only walk-through, theme persistence and cross-tab sync, the command
 * palette, and the free-only notice on a tool whose capability has no free model.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '../mock/index.ts';
import { seedApp, tabTo } from './app.ts';
import { watchForProblems } from './support.ts';

const theme = (page: Page) => page.locator('html');

test('keyboard only: Home → palette → a tool → prompts panel → drawer → back', async ({
  page,
  context,
  browserName,
}) => {
  test.slow(); // a long journey; WebKit on a busy machine needs the room
  await seedApp(context);
  const problems = await watchForProblems(page);
  await page.goto('');

  // The first Tab stop is the skip link, and it moves focus to <main>. (WebKit, like Safari by default, keeps
  // links out of the Tab order, so there the link is focused directly.)
  const skip = page.getByRole('link', { name: 'Skip to main content' });
  if (browserName === 'webkit') await skip.focus();
  else await page.keyboard.press('Tab');
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();

  // Ctrl+K opens the palette with focus in its search box; arrows move, Enter opens.
  await page.keyboard.press('Control+k');
  const input = page.getByTestId('palette-input');
  await expect(input).toBeFocused();
  await input.pressSequentially('ocr');
  await expect(page.getByTestId('palette-option-tool:ocr')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(input).toHaveAttribute('aria-activedescendant', /tool_ocr$/);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/tools\/ocr\/$/);
  await expect(page.getByTestId('page-title')).toHaveText('OCR');

  // Prompts panel: open with the keyboard, Escape closes it and focus returns to the button.
  await tabTo(page, 'prompts-button');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('prompts-panel')).toBeVisible();
  await expect(page.getByTestId('prompts-panel')).toContainText('No recent prompts');
  await expect(page.getByTestId('prompts-tab-recent')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('prompts-tab-saved')).toBeFocused();
  await expect(page.getByTestId('prompts-tab-saved')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('prompts-panel')).toBeHidden();
  await expect(page.getByTestId('prompts-button')).toBeFocused();

  // Settings drawer, the same way.
  await tabTo(page, 'drawer-button');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('settings-drawer')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-drawer')).toBeHidden();
  await expect(page.getByTestId('drawer-button')).toBeFocused();

  // And back to Home through the palette.
  await page.keyboard.press('Control+k');
  await page.getByTestId('palette-input').pressSequentially('home');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/or-toolbox\/$/);
  await expect(page.getByTestId('page-title')).toHaveText('ORtoolbox');
  expect(problems).toEqual([]);
});

test('the palette closes with Escape and gives focus back to its button', async ({
  page,
  context,
}) => {
  await seedApp(context);
  await page.goto('privacy/');
  // Opened from the keyboard: WebKit does not focus buttons on click, so a click leaves nothing to return to.
  await page.getByTestId('palette-button').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('palette-input')).toBeFocused();
  await page.getByTestId('palette-input').fill('zzqqxx');
  // Nothing local matches; the catalog search is still offered.
  await expect(page.getByTestId('palette-list').getByRole('option')).toHaveText([
    'Search models for “zzqqxx”',
  ]);
  await page.getByTestId('palette-input').fill('z');
  await expect(page.getByTestId('palette')).toContainText('No results for “z”.');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('palette')).toHaveCount(0);
  await expect(page.getByTestId('palette-button')).toBeFocused();
});

test('Home search filters the tools and Enter opens the best match', async ({ page, context }) => {
  await seedApp(context);
  await page.goto('');
  const search = page.getByTestId('home-search');
  await search.fill('speech');
  const results = page.getByTestId('search-results');
  await expect(results).toBeVisible();
  await expect(results.getByRole('heading', { level: 3 })).toHaveText([
    'Speech-to-text',
    'Text-to-speech',
  ]);
  await expect(page.getByTestId('categories')).toBeHidden();
  await search.press('Enter');
  await expect(page).toHaveURL(/\/tools\/speech-to-text\/$/);
});

test('a starred tool appears in Favorites', async ({ page, context }) => {
  await seedApp(context);
  await page.goto('');
  await expect(page.getByTestId('favorites-empty')).toBeVisible();
  const star = page.getByTestId('category-audio').getByTestId('star-text-to-speech');
  await star.focus();
  await page.keyboard.press('Enter');
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  await expect(star).toBeFocused();
  await expect(page.getByTestId('fav-tool-link-text-to-speech')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('fav-tool-link-text-to-speech')).toBeVisible();
});

test.describe('theme', () => {
  test('the navbar choice persists across pages', async ({ page, context }) => {
    await seedApp(context);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('');
    await expect(theme(page)).toHaveAttribute('data-bs-theme', 'light');
    await page.getByTestId('theme-menu').click();
    await page.getByTestId('theme-dark').click();
    await expect(theme(page)).toHaveAttribute('data-bs-theme', 'dark');
    await expect(page.getByTestId('theme-menu')).toHaveAttribute('aria-label', 'Theme: Dark');

    await page.goto('tools/chat/');
    await expect(theme(page)).toHaveAttribute('data-bs-theme', 'dark');
    await page.goto('privacy/');
    await expect(theme(page)).toHaveAttribute('data-bs-theme', 'dark');
  });

  test('a change in one tab applies live in another', async ({ page, context }) => {
    await seedApp(context);
    await page.emulateMedia({ colorScheme: 'light' });
    const other = await context.newPage();
    await other.emulateMedia({ colorScheme: 'light' });
    await page.goto('');
    await other.goto('tools/ocr/');
    await expect(theme(other)).toHaveAttribute('data-bs-theme', 'light');

    await page.getByTestId('theme-menu').click();
    await page.getByTestId('theme-dark').click();
    await expect(theme(other)).toHaveAttribute('data-bs-theme', 'dark');

    await page.getByTestId('theme-menu').click();
    await page.getByTestId('theme-system').click();
    await expect(theme(other)).toHaveAttribute('data-bs-theme', 'light');
  });

  test('appearance settings apply: accent colour, density and reduced motion', async ({
    page,
    context,
  }) => {
    await seedApp(context, {
      settings: {
        appearance: { theme: 'light', accent: '#0f766e', density: 'compact', reducedMotion: true },
      },
    });
    await page.goto('');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-density', 'compact');
    await expect(html).toHaveAttribute('data-reduced-motion', '');
    await expect(html).toHaveAttribute('data-accent', '');
    const primary = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bs-primary').trim(),
    );
    expect(primary).toBe('#0f766e');
    const runButton = await page.evaluate(async () => {
      const button = document.createElement('button');
      button.className = 'btn btn-primary';
      document.body.append(button);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return getComputedStyle(button).backgroundColor;
    });
    expect(runButton).toBe('rgb(15, 118, 110)');
  });
});

test('free-only mode explains why a tool cannot run when no free model exists', async ({
  page,
  context,
}) => {
  await seedApp(context, { settings: { freeOnly: true } });
  const problems = await watchForProblems(page);
  await page.goto('tools/video-studio/');
  await expect(page.getByTestId('free-only-badge')).toBeVisible();
  const notice = page.getByTestId('free-only-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('No free video model exists');
  await expect(notice.getByRole('link')).toHaveAttribute('href', /settings\/#models$/);
  await expect(page.getByTestId('run-button')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('run-hint')).toHaveText('No model is available in free-only mode.');

  // A capability with a free model swaps to it and says so.
  await page.goto('tools/chat/');
  await expect(page.getByTestId('free-only-notice')).toHaveCount(0);
  await expect(page.getByTestId('model-chip')).toContainText('Free');
  await expect(page.getByTestId('model-note')).toContainText('Free-only mode: using');
  expect(problems).toEqual([]);
});

test('every page has one h1, a skip link and no horizontal scroll at 320 px', async ({
  page,
  context,
}) => {
  await seedApp(context);
  await page.setViewportSize({ width: 320, height: 720 });
  for (const route of ['', 'tools/image-editor/', 'privacy/', 'settings/']) {
    await page.goto(route);
    await expect(page.locator('h1')).toHaveCount(1);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal scroll on /${route}`).toBeLessThanOrEqual(0);
  }
});

test('the sticky Run bar never covers the control that has focus (WCAG 2.4.11)', async ({
  page,
  context,
}) => {
  await seedApp(context, { key: true });
  await page.setViewportSize({ width: 1000, height: 420 }); // the input zone is longer than the window
  await page.goto('tools/data-extractor/');
  await expect(page.getByTestId('page-title')).toHaveText('Data extractor');
  const runner = page.getByTestId('runner');
  await page.getByTestId('tool-prompt').focus();

  /**
   * Whether a bar covers the focused control of the input zone, or null when focus is elsewhere. The browser
   * scrolls the focused control into view (smoothly unless motion is reduced) and the page corrects what a bar
   * still covers once that scroll ends, so the invariant is polled: it must hold once the page has settled.
   */
  const covered = (bar: 'runner' | 'navbar') => (): Promise<boolean | null> =>
    page.evaluate((which) => {
      const active = document.activeElement as HTMLElement | null;
      const input = document.querySelector('[data-testid="tool-input"]');
      const element =
        which === 'runner'
          ? document.querySelector<HTMLElement>('[data-testid="runner"]')
          : document.querySelector<HTMLElement>('.or-navbar');
      if (!active || !input?.contains(active) || !element || element.contains(active)) return null;
      const a = active.getBoundingClientRect();
      const b = element.getBoundingClientRect();
      return which === 'runner'
        ? a.bottom > b.top + 1 && a.top < b.bottom
        : a.top < b.bottom - 1 && a.bottom > b.top;
    }, bar);

  let checked = 0;
  for (let step = 0; step < 40; step++) {
    await page.keyboard.press('Tab');
    if ((await covered('runner')()) === null) continue;
    checked++;
    await expect.poll(covered('runner'), { message: `Tab ${step}` }).toBe(false);
  }
  expect(checked).toBeGreaterThan(3);
  await expect(runner).toBeVisible();

  // Back up with Shift+Tab: the sticky navbar never covers the focused control either.
  let above = 0;
  for (let step = 0; step < 30; step++) {
    await page.keyboard.press('Shift+Tab');
    if ((await covered('navbar')()) === null) continue;
    above++;
    await expect.poll(covered('navbar'), { message: `Shift+Tab ${step}` }).toBe(false);
  }
  expect(above).toBeGreaterThan(3);
});

test('pressing blank space on a tool page does not scroll it (a drag that starts there must survive)', async ({
  page,
  context,
}) => {
  await seedApp(context, { key: true });
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.goto('tools/data-extractor/');
  await expect(page.getByTestId('page-title')).toHaveText('Data extractor');
  // At the end of the page <main> ends above the window's bottom edge, which is where the scroll once happened.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const scrolled = (): Promise<number> => page.evaluate(() => scrollY);
  const before = await scrolled();
  expect(before).toBeGreaterThan(0);
  // A press on blank space focuses <main> (tabindex -1); the "keep the focused control uncovered" scroll must
  // leave that alone. The press is held, as in the first moment of a drag.
  const main = (await page.locator('main').boundingBox())!;
  await page.mouse.move(main.x + 4, 300);
  await page.mouse.down();
  await expect(page.locator('main')).toBeFocused();
  await expect.poll(scrolled, { timeout: 1500 }).toBe(before);
  await page.mouse.up();
});

test('a tool page does not shift while the tool sets itself up (CLS)', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'layout-shift entries are Chromium only');
  await seedApp(context, { key: true });
  await page.addInitScript(() => {
    const shifts: number[] = [];
    (window as unknown as { __shifts: number[] }).__shifts = shifts;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
      })[]) {
        if (!entry.hadRecentInput) shifts.push(entry.value);
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  for (const tool of ['chat', 'data-extractor', 'image-generation']) {
    await page.goto(`tools/${tool}/`);
    await expect(page.getByTestId('tool-prompt')).toBeVisible();
    // The chips and the estimate arrive after setup: the page has shifted as much as it will once they are there.
    await expect(page.getByTestId('model-chip-name')).not.toBeEmpty();
    await expect(page.getByTestId('cost-estimate-value')).not.toBeEmpty();
    const total = await page.evaluate(() =>
      (window as unknown as { __shifts: number[] }).__shifts.reduce((sum, value) => sum + value, 0),
    );
    expect(total, tool).toBeLessThan(0.1); // "good" CLS
  }
});

test('on a phone, toasts float above the Run bar instead of covering Run and Stop', async ({
  page,
  context,
}) => {
  await seedApp(context, { key: true });
  await page.setViewportSize({ width: 375, height: 700 });
  await page.goto('tools/data-extractor/');
  await expect(page.getByTestId('page-title')).toHaveText('Data extractor');
  // A dropped file the tool does not take: the page says so in a toast.
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(['x'], 'archive.zip', { type: 'application/zip' }));
    window.dispatchEvent(
      new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }),
    );
  });
  const toastEl = page.getByTestId('toast').last();
  await expect(toastEl).toContainText('Skipped 1 file');
  const runner = page.getByTestId('runner');
  const toastBox = (await toastEl.boundingBox())!;
  const runnerBox = (await runner.boundingBox())!;
  expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(runnerBox.y + 1);
});

test.describe('a browser that blocks saving', () => {
  test.beforeEach(async ({ context }) => {
    await seedApp(context);
    await context.addInitScript(() => {
      // Web Storage refuses every write, as in a browser with site data blocked.
      const refuse = (): never => {
        throw new DOMException('Access denied', 'SecurityError');
      };
      Storage.prototype.setItem = refuse;
    });
  });

  test('says so once at page start, and keeps saying what to do until closed', async ({ page }) => {
    // A fake clock, so "longer than a plain toast lives" is a fast-forward and not a wait.
    await page.clock.install();
    await page.goto('');
    const notice = page.getByTestId('storage-notice');
    await expect(notice).toContainText('This browser blocks saving');
    await expect(notice).toContainText('Allow site data for this site');
    await expect(page.getByTestId('storage-notice')).toHaveCount(1);
    await page.clock.fastForward(6000); // longer than a plain toast lives
    await expect(notice).toBeVisible();
  });

  test('a setting that cannot be saved says why instead of looking saved', async ({ page }) => {
    await page.goto('settings/#appearance');
    await page.getByTestId('storage-notice').locator('.btn-close').click();
    await page
      .getByTestId('settings-section-appearance')
      .getByText('Dark', { exact: true })
      .click();
    await expect(page.getByTestId('error-toast')).toContainText('This browser blocks saving');
  });
});
