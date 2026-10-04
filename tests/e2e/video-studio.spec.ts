/**
 * Video studio against the mocked `/videos` endpoints: text-to-video, first and last frames, Continue from the last
 * frame of an uploaded clip, native extend falling back to Continue for an upload, the frame grabber, an
 * independent sequence three at a time, stopping a join, the free-only notice, keyboard reordering and axe in
 * both themes. The reload, join and spend-cap gate is in video-studio-gate.spec.ts.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '../mock/index.ts';
import { seedApp } from './app.ts';
import { expectNoSeriousA11yViolations, watchForProblems } from './support.ts';
import {
  GROK,
  IMAGE_PATH,
  mockVideoCatalog,
  mockVideoJobs,
  NO_BUDGETS,
  pngSize,
  SEEDANCE_MINI,
  VIDEO_PATH,
  type VideoBody,
} from './video-mocks.ts';

/** Adds the fixture clip to the timeline through the upload zone of "Continue a clip". */
async function upload(page: Page, count = 1): Promise<void> {
  await page.getByTestId('video-mode').selectOption('continue');
  for (let i = 0; i < count; i++) {
    const before = await page.getByTestId('video-clip').count();
    await page.getByTestId('video-upload').locator('input[type="file"]').setInputFiles(VIDEO_PATH);
    await expect(page.getByTestId('video-clip')).toHaveCount(before + 1);
  }
  await expect(page.getByTestId('video-clip-player')).toHaveCount(
    await page.getByTestId('video-clip').count(),
  );
}

const firstFrame = (body: VideoBody | undefined): string | undefined =>
  body?.frame_images?.find((frame) => frame.frame_type === 'first_frame')?.image_url.url;

test.describe('Video studio', () => {
  test.setTimeout(240_000);

  test('text to video: the request, the job, the clip on the timeline and its cost in History', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, { key: true, settings: NO_BUDGETS });
    const jobs = mockVideoJobs(mock, { pendingPolls: 1 });
    mockVideoCatalog(mock);
    const problems = await watchForProblems(page);
    await page.goto('tools/video-studio/');

    // Grok Imagine Video at 480p: $0.05 per second, 5 s by default.
    await expect(page.getByTestId('cost-estimate-value')).toHaveText('≈ $0.25');
    await page.getByTestId('tool-prompt').fill('A fishing boat leaves a quiet harbour at dawn');
    await page.getByTestId('video-duration').selectOption('1');
    await expect(page.getByTestId('cost-estimate-value')).toHaveText('≈ $0.05');

    await page.getByTestId('run-button').click();
    await expect(page.getByTestId('video-clip')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('video-clip-player')).toHaveCount(1);
    const [body] = jobs.submits();
    expect(body).toEqual({
      model: GROK,
      prompt: 'A fishing boat leaves a quiet harbour at dawn',
      duration: 1,
      resolution: '480p',
      aspect_ratio: '16:9',
    });
    await expect(page.getByTestId('video-clip-meta')).toContainText('1.04 s');
    await expect(page.getByTestId('video-jobs').getByText('Done')).toBeVisible();
    await expect(page.getByTestId('video-jobs')).toContainText('On the timeline');

    // Axe on a page with a clip, in both themes, on both tabs.
    await expectNoSeriousA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoSeriousA11yViolations(page);
    const id = await page.getByTestId('video-tab-sequence').getAttribute('id');
    await page.locator(`label[for="${id}"]`).click();
    await expect(page.getByTestId('video-sequence-panel')).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'light' });
    await expectNoSeriousA11yViolations(page);

    // The run booked the completed status's cost.
    await page.goto('history/?tool=video-studio');
    await expect(page.getByText('$0.052').first()).toBeVisible();
    expect(problems).toEqual([]);
  });

  test('first and last frame: both go as frame_images, no references', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, { key: true, settings: NO_BUDGETS });
    const jobs = mockVideoJobs(mock);
    mockVideoCatalog(mock);
    const problems = await watchForProblems(page);
    await page.goto(`tools/video-studio/?model=${encodeURIComponent(SEEDANCE_MINI)}`);

    await page.getByTestId('video-mode').selectOption('first-last');
    await page
      .getByTestId('video-first-reference-drop')
      .locator('input[type="file"]')
      .setInputFiles(IMAGE_PATH);
    await page
      .getByTestId('video-last-reference-drop')
      .locator('input[type="file"]')
      .setInputFiles(IMAGE_PATH);
    await expect(page.getByTestId('video-first-reference')).toHaveCount(1);
    await expect(page.getByTestId('video-last-reference')).toHaveCount(1);
    await page.getByTestId('tool-prompt').fill('The flower opens');
    await page.getByTestId('video-audio').selectOption('off');
    await page.getByTestId('run-button').click();
    await expect(page.getByTestId('video-clip')).toHaveCount(1, { timeout: 60_000 });

    const [body] = jobs.submits();
    expect(body).toMatchObject({
      model: SEEDANCE_MINI,
      prompt: 'The flower opens',
      duration: 5,
      resolution: '480p',
      aspect_ratio: '16:9',
      generate_audio: false,
    });
    expect(body!.input_references).toBeUndefined();
    expect(body!.frame_images?.map((frame) => frame.frame_type)).toEqual([
      'first_frame',
      'last_frame',
    ]);
    for (const frame of body!.frame_images ?? []) {
      expect(frame.image_url.url).toMatch(/^data:image\/jpeg;base64,\/9j\//);
    }
    // A model that takes only a first frame is refused before anything is sent.
    await page.goto(`tools/video-studio/?model=${encodeURIComponent(GROK)}`);
    await page.getByTestId('video-mode').selectOption('first-last');
    await expect(page.getByTestId('video-problem')).toContainText('takes a first frame only');
    expect(problems).toEqual([]);
  });

  test('Continue from the last frame of an uploaded clip; the new clip follows it', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, { key: true, settings: NO_BUDGETS });
    const jobs = mockVideoJobs(mock);
    mockVideoCatalog(mock);
    const problems = await watchForProblems(page);
    await page.goto('tools/video-studio/');
    await upload(page, 2);
    // The upload became the clip to continue; continue the first one instead, from its card.
    await expect(page.getByTestId('video-source')).toHaveValue(/.+/);
    await page.getByTestId('video-clip').first().getByTestId('video-clip-continue').click();
    await expect(page.getByTestId('tool-prompt')).toBeFocused();
    await page.getByTestId('tool-prompt').fill('The camera keeps rising');
    await page.getByTestId('video-duration').selectOption('1');
    // One clip at $0.05 plus its first frame as an image input.
    await expect(page.getByTestId('cost-estimate-value')).toHaveText('≈ $0.052');
    await page.getByTestId('run-button').click();
    await expect(page.getByTestId('video-clip')).toHaveCount(3, { timeout: 60_000 });

    const [body] = jobs.submits();
    expect(body!.prompt).toBe('The camera keeps rising');
    expect(body!.frame_images).toHaveLength(1);
    expect(pngSize(firstFrame(body)!)).toEqual({ width: 544, height: 544 });
    // Right after its source, its repeated first frame left out of the join.
    const second = page.getByTestId('video-clip').nth(1);
    await expect(second.getByTestId('video-clip-meta')).toContainText('Continues the clip before');
    await expect(second.getByTestId('video-drop-first')).toBeChecked();
    await expect(
      page.getByTestId('video-clip').nth(2).getByTestId('video-clip-meta'),
    ).toContainText('Uploaded');
    expect(problems).toEqual([]);
  });

  test('native extend: an upload falls back to Continue; a public link is sent as video', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, { key: true, settings: NO_BUDGETS });
    const jobs = mockVideoJobs(mock);
    mockVideoCatalog(mock);
    const problems = await watchForProblems(page);
    await page.goto(`tools/video-studio/?model=${encodeURIComponent(SEEDANCE_MINI)}`);
    await upload(page);
    await page.getByTestId('video-clip').first().getByTestId('video-clip-extend').click();
    await expect(page.getByTestId('video-mode')).toHaveValue('extend');
    await expect(page.getByTestId('video-notes')).toContainText(
      'continued from its last frame instead',
    );
    await page.getByTestId('video-duration').selectOption('4');
    await page.getByTestId('run-button').click();
    await expect.poll(() => jobs.submits().length).toBe(1);
    const fallback = jobs.submits()[0]!;
    expect(fallback.frame_images?.[0]?.frame_type).toBe('first_frame');
    expect(pngSize(firstFrame(fallback)!)).toEqual({ width: 544, height: 544 });
    expect(fallback.input_references).toBeUndefined();
    // An empty prompt continues the shot.
    expect(fallback.prompt).toMatch(/^Continue the shot/);

    await page.getByTestId('video-extend-url').fill('https://example.com/harbour.mp4');
    await expect(page.getByTestId('video-notes')).toContainText('Native extend');
    await page.getByTestId('run-button').click();
    await expect.poll(() => jobs.submits().length).toBe(2);
    const native = jobs.submits()[1]!;
    expect(native.frame_images).toBeUndefined();
    expect(native.input_references).toEqual([
      { type: 'video_url', video_url: { url: 'https://example.com/harbour.mp4' } },
    ]);
    await expect(page.getByTestId('video-clip')).toHaveCount(3, { timeout: 60_000 });
    expect(problems).toEqual([]);
  });

  test('frame grabber: scrub, save a frame and use it as the first frame', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, { key: true, settings: NO_BUDGETS });
    const jobs = mockVideoJobs(mock);
    mockVideoCatalog(mock);
    const problems = await watchForProblems(page);
    await page.goto('tools/video-studio/');
    await upload(page);
    await page.getByTestId('video-clip-frames').click();
    await expect(page.getByTestId('video-frame-grabber')).toBeVisible();
    await expect(page.getByTestId('video-frames-slider')).toBeFocused();
    // Keyboard: the slider moves frame by frame, at the clip's own 24 fps (read from the file).
    await expect(page.getByTestId('video-frames-time')).toHaveText('Frame 1 of 25 · 0.02 s');
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
    await page.getByTestId('video-frames-next').click();
    await expect(page.getByTestId('video-frames-time')).toHaveText('Frame 8 of 25 · 0.31 s');
    // The last position is the true final frame.
    await page.getByTestId('video-frames-slider').focus();
    await page.keyboard.press('End');
    await expect(page.getByTestId('video-frames-time')).toHaveText('Frame 25 of 25 · 1.02 s');
    for (let i = 0; i < 17; i++) await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('video-frames-time')).toHaveText('Frame 8 of 25 · 0.31 s');
    await page.getByTestId('video-frames-save').click();
    await expect(page.getByTestId('video-frame-result')).toHaveCount(1);
    await expect(page.getByTestId('video-frame-result')).toContainText('Frame 8 (0.31 s)');
    // Close gives focus back to the Frames button that opened it.
    await page.getByTestId('video-frames-close').click();
    await expect(page.getByTestId('video-frame-grabber')).toBeHidden();
    await expect(page.getByTestId('video-clip-frames')).toBeFocused();

    await page.getByTestId('video-frame-first').click();
    await expect(page.getByTestId('video-mode')).toHaveValue('first');
    await expect(page.getByTestId('video-first-reference')).toHaveCount(1);
    await page.getByTestId('tool-prompt').fill('A new shot from this frame');
    await page.getByTestId('run-button').click();
    await expect.poll(() => jobs.submits().length).toBe(1);
    const frame = firstFrame(jobs.submits()[0]);
    expect(pngSize(frame!)).toEqual({ width: 544, height: 544 });
    expect(problems).toEqual([]);
  });

  test('independent sequence: three steps at once, clips in step order whatever order they finish', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, { key: true, settings: NO_BUDGETS });
    const jobs = mockVideoJobs(mock, { held: [1, 2, 3, 4] });
    mockVideoCatalog(mock);
    const problems = await watchForProblems(page);
    await page.goto('tools/video-studio/');
    const id = await page.getByTestId('video-tab-sequence').getAttribute('id');
    await page.locator(`label[for="${id}"]`).click();
    await page.getByTestId('seq-mode-independent').check();
    for (let i = 1; i < 4; i++) await page.getByTestId('seq-add-step').click();
    const prompts = ['Morning', 'Noon', 'Evening', 'Night'];
    for (const [index, prompt] of prompts.entries()) {
      await page.getByTestId('seq-step-prompt').nth(index).fill(prompt);
    }
    await page.getByTestId('seq-style').fill('Watercolour');
    await page.getByTestId('video-duration').selectOption('1');
    await expect(page.getByTestId('seq-estimate')).toHaveText(
      'About $0.20 for 4 clips (≈ $0.05 each).',
    );
    await page.getByTestId('seq-start').click();

    // Three in flight, the fourth waits.
    await expect.poll(() => jobs.submits().length).toBe(3);
    await page.waitForTimeout(1500);
    expect(jobs.submits()).toHaveLength(3);
    expect(jobs.submits().map((body) => body.prompt)).toEqual(
      prompts.slice(0, 3).map((prompt) => `${prompt}\n\nStyle: Watercolour`),
    );
    for (const body of jobs.submits()) expect(body.frame_images).toBeUndefined();
    await expect(page.locator('[data-testid="seq-slot"][data-status="running"]')).toHaveCount(3);

    // They finish out of order: 3, then 1 (the fourth starts), then 4 and 2.
    jobs.release(3);
    await expect(page.getByTestId('video-clip')).toHaveCount(1, { timeout: 60_000 });
    jobs.release(1);
    await expect.poll(() => jobs.submits().length, { timeout: 60_000 }).toBe(4);
    jobs.release(4);
    jobs.release(2);
    await expect(page.locator('[data-testid="seq-slot"][data-status="done"]')).toHaveCount(4, {
      timeout: 120_000,
    });
    const clips = page.getByTestId('video-clip');
    for (let index = 0; index < 4; index++) {
      await expect(clips.nth(index).getByTestId('video-clip-meta')).toContainText(
        `Sequence step ${index + 1}`,
      );
    }
    // Independent clips do not continue each other: nothing to leave out.
    await expect(page.getByTestId('video-drop-first')).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test('a join can be stopped; reordering works from the keyboard', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, { key: true, settings: NO_BUDGETS });
    mockVideoJobs(mock);
    mockVideoCatalog(mock);
    const problems = await watchForProblems(page);
    await page.goto('tools/video-studio/');
    await upload(page, 2);
    const ids = () =>
      page
        .getByTestId('video-clip')
        .evaluateAll((items) => items.map((item) => item.getAttribute('data-clip-id')));
    const [first, second] = await ids();

    // Move down with the button, from the keyboard: focus stays with the moved clip.
    await page.getByTestId('video-clip').first().getByTestId('video-trim-end').focus();
    await page.keyboard.press('Shift+Tab');
    await page.getByTestId('video-clip').first().getByTestId('video-clip-down').focus();
    await page.keyboard.press('Enter');
    await expect.poll(ids).toEqual([second, first]);
    // Focus stays on the same button, now at the end of the list: still focusable, aria-disabled.
    const movedDown = page.locator(`[data-clip-id="${first}"]`).getByTestId('video-clip-down');
    await expect(movedDown).toBeFocused();
    await expect(movedDown).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Enter');
    await expect.poll(ids).toEqual([second, first]);
    // Alt+Arrow Up anywhere in a clip moves it back.
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(ids).toEqual([first, second]);
    await expect(page.locator(`[data-clip-id="${first}"]`).locator(':focus')).toHaveCount(1);

    // Trim the first clip so the join re-encodes (long enough to stop), then stop it.
    await page.getByTestId('video-trim-end').first().fill('0.2');
    await page.getByTestId('video-trim-end').first().blur();
    await page.getByTestId('video-join').click();
    // Focus goes to Stop while it joins, and back to Join after.
    await expect(page.getByTestId('video-join-stop')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('tool-status')).toHaveText('Join stopped.');
    await expect(page.getByTestId('video-join')).toBeVisible();
    await expect(page.getByTestId('video-join')).toBeFocused();
    await expect(page.getByTestId('video-export-result')).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test('a sequence asks one budget question at Start; its steps then run without dialogs of their own', async ({
    page,
    context,
    mock,
  }) => {
    // Default budgets: Warn, $0.10 per run. Each 3 s step ($0.15) is over it; the sequence asks once.
    await seedApp(context, { key: true });
    const jobs = mockVideoJobs(mock, { cost: 0.15 });
    mockVideoCatalog(mock);
    const problems = await watchForProblems(page);
    await page.goto('tools/video-studio/');
    const id = await page.getByTestId('video-tab-sequence').getAttribute('id');
    await page.locator(`label[for="${id}"]`).click();
    for (let i = 1; i < 3; i++) await page.getByTestId('seq-add-step').click();
    for (const [index, prompt] of ['One', 'Two', 'Three'].entries()) {
      await page.getByTestId('seq-step-prompt').nth(index).fill(prompt);
    }
    await page.getByTestId('video-duration').selectOption('3');
    await page.getByTestId('seq-cap').fill('2');
    await page.getByTestId('seq-cap').blur();

    // Declined: nothing is stored or sent.
    await page.getByTestId('seq-start').click();
    const dialog = page.getByTestId('seq-budget-confirm');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('seq-budget-total')).toHaveText(
      'About $0.45 for 3 clips, asked once for the whole sequence.',
    );
    await expect(dialog).toContainText('Spend cap $2.00');
    await dialog.getByTestId('dialog-cancel').click();
    await expect(page.getByTestId('tool-status')).toHaveText('Not started: nothing was sent.');
    await expect(page.getByTestId('seq-progress')).toBeHidden();
    expect(jobs.submits()).toEqual([]);

    // Accepted: three steps, no per-step dialog.
    await page.getByTestId('seq-start').click();
    await page.getByTestId('seq-budget-confirm').getByTestId('dialog-confirm').click();
    await expect(page.locator('[data-testid="seq-slot"][data-status="done"]')).toHaveCount(3, {
      timeout: 120_000,
    });
    await expect(page.getByTestId('budget-dialog')).toHaveCount(0);
    expect(jobs.submits().map((body) => body.prompt)).toEqual(['One', 'Two', 'Three']);
    expect(problems).toEqual([]);
  });

  test('a chained step whose clip is gone pauses with choices instead of sending its prompt alone', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, { key: true, settings: NO_BUDGETS });
    const jobs = mockVideoJobs(mock, { held: [1] });
    mockVideoCatalog(mock);
    const problems = await watchForProblems(page);
    await page.goto('tools/video-studio/');
    const id = await page.getByTestId('video-tab-sequence').getAttribute('id');
    await page.locator(`label[for="${id}"]`).click();
    await page.getByTestId('seq-add-step').click();
    await page.getByTestId('seq-step-prompt').nth(0).fill('First');
    await page.getByTestId('seq-step-prompt').nth(1).fill('Second');
    await page.getByTestId('video-duration').selectOption('1');
    await page.getByTestId('seq-start').click();
    await expect.poll(() => jobs.submits().length).toBe(1);

    // Paused while step 1 is generating; its clip arrives, then is removed from the timeline.
    await page.getByTestId('seq-pause').click();
    await expect(page.getByTestId('seq-resume')).toBeVisible();
    // Steps are editable again while paused.
    await expect(page.getByTestId('seq-step-prompt').nth(1)).toBeEditable();
    jobs.release(1);
    await expect(page.getByTestId('video-clip-player')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('video-clip-remove').click();
    await page.getByTestId('video-remove-confirm').getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('video-clip')).toHaveCount(0);

    await page.getByTestId('seq-resume').click();
    const blocker = page.getByTestId('seq-blocker');
    await expect(blocker).toContainText(
      'Paused before step 2: there is no clip for it to continue.',
      { timeout: 30_000 },
    );
    expect(jobs.submits()).toHaveLength(1);
    await expect(blocker.getByTestId('seq-blocker-rerun-previous')).toBeVisible();
    await blocker.getByTestId('seq-blocker-no-frame').click();
    await expect.poll(() => jobs.submits().length, { timeout: 30_000 }).toBe(2);
    expect(jobs.submits()[1]).toMatchObject({ prompt: 'Second' });
    expect(jobs.submits()[1]!.frame_images).toBeUndefined();
    await expect(page.locator('[data-testid="seq-slot"][data-status="done"]')).toHaveCount(2, {
      timeout: 60_000,
    });
    expect(problems).toEqual([]);
  });

  test('free-only mode: no video model is free, so nothing can be generated', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, { key: true, settings: { ...NO_BUDGETS, freeOnly: true } });
    mockVideoCatalog(mock);
    const problems = await watchForProblems(page);
    await page.goto('tools/video-studio/');
    await expect(page.getByTestId('free-only-notice')).toBeVisible();
    await expect(page.getByTestId('run-button')).toHaveAttribute('aria-disabled', 'true');
    const id = await page.getByTestId('video-tab-sequence').getAttribute('id');
    await page.locator(`label[for="${id}"]`).click();
    await expect(page.getByTestId('seq-start')).toBeDisabled();
    await expect(page.getByTestId('seq-blocked')).toHaveText(
      'No model is available in free-only mode.',
    );
    expect(problems).toEqual([]);
  });
});
