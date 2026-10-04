/**
 * Stage 4 gate, Music generation: a mocked Lyria stream (keep-alive comments, the timed lyrics, then the whole
 * MP3 as one base64 fragment, as in tests/fixtures/openrouter/music-lyria-*.recorded.sse.txt) becomes a
 * playable MP3 in the player, its lyrics follow playback, and a target length cuts it in the browser. Also:
 * variations side by side with the total estimate, MP3 and WAV downloads, the free-only notice (no music model
 * is free) and axe in both themes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  expect,
  MEDIA_FIXTURES_DIR,
  type OpenRouterMock,
  sseResponse,
  test,
} from '../mock/index.ts';
import { seedApp } from './app.ts';
import { expectNoSeriousA11yViolations, watchForProblems } from './support.ts';

const CATALOG = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, '../fixtures/openrouter/models.json'), 'utf8'),
  ) as { data: { id: string }[] }
).data.filter((model) => model.id.startsWith('google/lyria-'));

/**
 * The song: an ID3v2.3 tag (Lyria's carry a C2PA manifest; here 32 bytes of padding) and four copies of the
 * 3.24 s speech fixture, about 13 seconds of MP3.
 */
const SONG = Buffer.concat([
  Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20]),
  Buffer.alloc(32),
  ...Array.from({ length: 4 }, () => readFileSync(join(MEDIA_FIXTURES_DIR, 'speech.mp3'))),
]);

const LYRICS = [
  '[0.0:3.0] HELLO WORLD, HELLO DAY',
  '[3.2:6.2] SUNSHINE ON THE WAY',
  '[6.4:9.4] LA LA LA, WE SING ALONG',
  '[9.6:12.6] THIS IS OUR LITTLE SONG',
].join('\n');

/** A Lyria stream as recorded: keep-alives, lyrics, one audio fragment, the finish chunk twice (usage last). */
function lyriaStream(cost = 0.04) {
  const base = {
    id: 'gen-1790983685-lyria',
    object: 'chat.completion.chunk',
    created: 1790983685,
    model: 'google/lyria-3-clip-preview',
    provider: 'Google AI Studio',
  };
  const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
    ...base,
    choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: finish }],
  });
  return sseResponse([
    ': OPENROUTER PROCESSING',
    ': OPENROUTER PROCESSING',
    ': OPENROUTER PROCESSING',
    chunk({ content: LYRICS }, null),
    chunk({ content: '', audio: { data: SONG.toString('base64') } }, null),
    chunk({ content: '' }, 'stop'),
    {
      ...chunk({ content: '' }, 'stop'),
      usage: { prompt_tokens: 49, completion_tokens: 71, total_tokens: 120, cost },
    },
  ]);
}

function mockLyria(mock: OpenRouterMock): void {
  mock.json('GET', '/api/v1/models', { data: CATALOG });
  mock.respond('POST', '/api/v1/chat/completions', () => lyriaStream());
}

/** The API client cancels a stream once it has read `[DONE]`; Chromium may report that as an aborted request. */
const STREAM_CANCELS = { allowAborted: ['/api/v1/chat/completions'] };

/** Decoded seconds of the audio in the `index`-th music player on the page. */
function decodedSeconds(page: Page, index = 0): Promise<number> {
  return page.evaluate(async (at) => {
    const audio = document.querySelectorAll<HTMLAudioElement>('[data-testid="music-player"] audio')[
      at
    ]!;
    const bytes = await (await fetch(audio.src)).arrayBuffer();
    return (await new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes)).duration;
  }, index);
}

async function openDrawer(page: Page): Promise<void> {
  await page.getByTestId('drawer-button').click();
  await expect(page.locator('.or-drawer')).toBeVisible();
}

async function closeDrawer(page: Page): Promise<void> {
  const drawer = page.locator('.or-drawer');
  await drawer.locator('.btn-close').click();
  await expect(drawer).toBeHidden();
}

test.describe('Music generation', () => {
  test.setTimeout(240_000);

  test('gate: the stream becomes a playable MP3 with synced lyrics; a target length cuts it', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, { key: true });
    mockLyria(mock);
    const problems = await watchForProblems(page, STREAM_CANCELS);
    await page.goto('tools/music-generation/');
    await expect(page.getByTestId('music-length-clip')).toBeChecked();
    await expect(page.getByTestId('cost-estimate-value')).toHaveText('≈ $0.04');

    await page.getByTestId('tool-prompt').fill('A cheerful jingle for a sunny morning');
    await page.getByTestId('music-genre').fill('Pop');
    await page.getByTestId('music-voice').fill('bright female vocals');
    await page.getByTestId('music-lyrics').click();
    await page.getByTestId('music-tag-verse').click();
    await page.keyboard.type('Hello world, hello day\nSunshine on the way');
    await page.getByTestId('music-tag-chorus').click();
    await page.keyboard.type('La la la, we sing along');
    await expect(page.getByTestId('music-lyrics')).toHaveValue(
      '[Verse]\nHello world, hello day\nSunshine on the way\n\n[Chorus]\nLa la la, we sing along',
    );
    await expect(page.getByTestId('music-lyrics-warnings')).toBeEmpty();

    await page.getByTestId('run-button').click();
    const player = page.getByTestId('music-player');
    await expect(player).toBeVisible({ timeout: 60_000 });
    const [call] = mock.calls('/api/v1/chat/completions');
    expect(call?.body).toMatchObject({
      model: 'google/lyria-3-clip-preview',
      modalities: ['text', 'audio'],
      stream: true,
      messages: [
        {
          role: 'user',
          content:
            'A cheerful jingle for a sunny morning\nGenre: Pop.\nVocals: bright female vocals.\nSing these lyrics:\n[Verse]\nHello world, hello day\nSunshine on the way\n\n[Chorus]\nLa la la, we sing along',
        },
      ],
    });

    // A real, playable MP3 of the whole song.
    const full = await decodedSeconds(page);
    expect(full).toBeGreaterThan(12);
    expect(full).toBeLessThan(14);
    const duration = await player.locator('audio').evaluate(
      (audio: HTMLAudioElement) =>
        new Promise<number>((resolve) => {
          if (audio.readyState >= 1) resolve(audio.duration);
          else
            audio.addEventListener('loadedmetadata', () => resolve(audio.duration), { once: true });
        }),
    );
    expect(duration).toBeGreaterThan(12);
    await expect(page.getByTestId('music-meta')).toHaveText(/^0:1[23] · /);

    // The line being sung is highlighted as the song plays.
    const lines = page.getByTestId('music-lyric-line');
    await expect(lines).toHaveText([
      'HELLO WORLD, HELLO DAY',
      'SUNSHINE ON THE WAY',
      'LA LA LA, WE SING ALONG',
      'THIS IS OUR LITTLE SONG',
    ]);
    await player.locator('audio').evaluate((audio: HTMLAudioElement) => {
      audio.currentTime = 4;
    });
    await expect(lines.nth(1)).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('[data-testid="music-lyric-line"][aria-current]')).toHaveCount(1);
    await player.locator('audio').evaluate((audio: HTMLAudioElement) => {
      audio.currentTime = 10;
    });
    await expect(lines.nth(3)).toHaveAttribute('aria-current', 'true');
    await expect(lines.nth(1)).not.toHaveAttribute('aria-current', 'true');

    // A target length: the next song is cut to 8 seconds in the browser, with a fade-out.
    await openDrawer(page);
    await page.getByTestId('music-target').fill('8');
    await page.getByTestId('music-target').blur();
    await closeDrawer(page);
    await page.getByTestId('run-button').click();
    await expect(page.getByTestId('music-group')).toHaveCount(2);
    await expect(page.getByTestId('music-meta').first()).toHaveText(/^0:08 · cut from 0:1[23] · /, {
      timeout: 180_000,
    });
    const cut = await decodedSeconds(page, 0);
    console.info(
      `Music gate: streamed song ${full.toFixed(3)} s; cut to 8 s → ${cut.toFixed(3)} s`,
    );
    expect(cut).toBeGreaterThan(7.9);
    expect(cut).toBeLessThan(8.15);
    expect(await decodedSeconds(page, 1)).toBeCloseTo(full, 2);
    expect(problems).toEqual([]);
  });

  test('three variations side by side, MP3 and WAV downloads, axe in both themes', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, { key: true });
    mockLyria(mock);
    const problems = await watchForProblems(page, STREAM_CANCELS);
    await page.goto('tools/music-generation/');
    await expect(page.getByTestId('cost-estimate-value')).toHaveText('≈ $0.04');
    await openDrawer(page);
    await page.getByTestId('music-variations').selectOption('3');
    await closeDrawer(page);
    await expect(page.getByTestId('cost-estimate-value')).toHaveText('≈ $0.12');
    await page.getByTestId('music-instrumental').check();
    await page.getByTestId('tool-prompt').fill('Calm piano');

    await page.getByTestId('run-button').click();
    // $0.12 is above the default $0.10 per-run threshold: the run asks first, with the total.
    const confirm = page.getByTestId('budget-dialog');
    await expect(confirm.getByTestId('budget-estimate')).toContainText('$0.12');
    await confirm.getByTestId('budget-confirm').click();
    await expect(page.getByTestId('music-player')).toHaveCount(3, { timeout: 60_000 });
    expect(mock.calls('/api/v1/chat/completions')).toHaveLength(3);
    expect(
      (mock.calls('/api/v1/chat/completions')[0]?.body as { messages: { content: string }[] })
        .messages[0]?.content,
    ).toBe('Calm piano\nInstrumental only, no vocals.');
    const cards = page.getByTestId('music-variation');
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0)).toContainText('Variation 1');
    // Side by side on a desktop width.
    const [first, second] = await Promise.all([
      cards.nth(0).boundingBox(),
      cards.nth(1).boundingBox(),
    ]);
    expect(first && second && Math.abs(first.y - second.y)).toBeLessThan(2);
    expect(first && second && second.x).toBeGreaterThan((first?.x ?? 0) + 100);

    const save = async (extension: 'mp3' | 'wav'): Promise<Buffer> => {
      await cards.nth(1).getByTestId('music-download').click();
      const [file] = await Promise.all([
        page.waitForEvent('download'),
        cards.nth(1).getByTestId(`export-${extension}`).click(),
      ]);
      expect(file.suggestedFilename()).toMatch(new RegExp(`^music-.*-2\\.${extension}$`));
      return readFileSync(await file.path());
    };
    const mp3 = await save('mp3');
    expect(mp3.subarray(0, 3).toString('latin1')).toBe('ID3');
    const wav = await save('wav');
    expect(wav.subarray(0, 4).toString('latin1')).toBe('RIFF');

    await expectNoSeriousA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoSeriousA11yViolations(page);
    expect(problems).toEqual([]);
  });

  test('free-only mode shows the notice: no music model is free', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, { key: true, settings: { freeOnly: true } });
    mockLyria(mock);
    const problems = await watchForProblems(page);
    await page.goto('tools/music-generation/');
    const notice = page.getByTestId('free-only-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('This tool cannot run in free-only mode');
    await expect(page.getByTestId('run-button')).toHaveAttribute('aria-disabled', 'true');
    await expectNoSeriousA11yViolations(page);
    expect(mock.calls('/api/v1/chat/completions')).toHaveLength(0);
    expect(problems).toEqual([]);
  });
});
