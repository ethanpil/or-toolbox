/**
 * Speech-to-text against the mocked OpenRouter: a short upload sent as it is (recorded Whisper fixture), a
 * recording from a stubbed microphone, speaker labels through Deepgram's provider option, Stop, the free-only
 * notice (no free transcription model exists), and the Stage 4 gate: a 60-minute recording, synthesised in the
 * page, cut into parts whose mocked transcripts all start at 0, merged with continuous timestamps, with SRT and VTT
 * exports that match the JSON.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, MEDIA_FIXTURES_DIR, type RecordedCall, test } from '../mock/index.ts';
import { seedApp } from './app.ts';
import { expectNoSeriousA11yViolations, watchForProblems } from './support.ts';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'openrouter');
const fixture = (name: string): { response: Record<string, unknown> } =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as { response: Record<string, unknown> };
const SPEECH = join(MEDIA_FIXTURES_DIR, 'speech.mp3');
const PATH = '/api/v1/audio/transcriptions';

const sttModel = (id: string, prompt: string) => ({
  id,
  name: id,
  created: 1750000000,
  description: 'Speech-to-text.',
  context_length: 0,
  architecture: {
    modality: 'audio->transcription',
    input_modalities: ['audio'],
    output_modalities: ['transcription'],
    tokenizer: 'Other',
  },
  pricing: { prompt, completion: '0' },
  top_provider: { context_length: 0, max_completion_tokens: null, is_moderated: false },
  supported_parameters: [],
});
const CATALOG = {
  data: [
    sttModel('openai/whisper-large-v3-turbo', '0.0000033333'),
    sttModel('deepgram/nova-3', '0.0000716666666667'),
  ],
};

interface SttBody {
  model: string;
  input_audio: { data: string; format: string };
  response_format: string;
  timestamp_granularities?: string[];
  language?: string;
  keyterms?: string[];
  diarize?: unknown;
  provider?: { options?: Record<string, unknown> };
}
const bodyOf = (call: RecordedCall): SttBody => call.body as SttBody;

async function download(page: Page, testId: string): Promise<string> {
  await page.getByTestId('stt-download').click();
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId(testId).click(),
  ]);
  return readFileSync(await file.path(), 'utf8');
}

/** Hands a WAV made in the page to the drop zone's file input: `seconds` of 8 s tone bursts every 10 s. */
async function addSynthesisedWav(page: Page, seconds: number, name: string): Promise<void> {
  await page.evaluate(
    ({ seconds, name }) => {
      const rate = 16000;
      const period = new Int16Array(rate * 10);
      for (let i = 0; i < rate * 8; i++) {
        period[i] = Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 440 * i) / rate));
      }
      const periods = Math.ceil(seconds / 10);
      const dataBytes = seconds * rate * 2;
      const header = new DataView(new ArrayBuffer(44));
      const text = (at: number, value: string) => {
        for (let i = 0; i < value.length; i++) header.setUint8(at + i, value.charCodeAt(i));
      };
      text(0, 'RIFF');
      header.setUint32(4, 36 + dataBytes, true);
      text(8, 'WAVE');
      text(12, 'fmt ');
      header.setUint32(16, 16, true);
      header.setUint16(20, 1, true);
      header.setUint16(22, 1, true);
      header.setUint32(24, rate, true);
      header.setUint32(28, rate * 2, true);
      header.setUint16(32, 2, true);
      header.setUint16(34, 16, true);
      text(36, 'data');
      header.setUint32(40, dataBytes, true);
      const parts: BlobPart[] = [header.buffer];
      for (let p = 0; p < periods; p++) {
        const left = seconds * rate - p * rate * 10;
        parts.push(left >= period.length ? period : period.subarray(0, left));
      }
      const file = new File(parts, name, { type: 'audio/wav' });
      const input = document.querySelector<HTMLInputElement>(
        '[data-testid="stt-drop-zone"] input[type=file]',
      )!;
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { seconds, name },
  );
}

/** The tone bursts in a mocked request's 16-bit mono WAV, timed from the part's own start (as a model would). */
function burstsIn(base64: string): { start: number; end: number }[] {
  const bytes = Buffer.from(base64, 'base64');
  let offset = 12;
  let data = -1;
  let size = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    if (id === 'data') {
      data = offset + 8;
      size = Math.min(length, bytes.length - data);
      break;
    }
    offset += 8 + length + (length % 2);
  }
  const rate = bytes.readUInt32LE(24);
  const samples = size / 2;
  const frame = rate / 50;
  const bursts: { start: number; end: number }[] = [];
  let start = -1;
  for (let f = 0; f * frame < samples; f++) {
    let peak = 0;
    for (let i = f * frame; i < Math.min(samples, (f + 1) * frame); i++) {
      peak = Math.max(peak, Math.abs(bytes.readInt16LE(data + 2 * i)));
    }
    const loud = peak > 1000;
    if (loud && start < 0) start = (f * frame) / rate;
    if (!loud && start >= 0) {
      bursts.push({ start, end: (f * frame) / rate });
      start = -1;
    }
  }
  if (start >= 0) bursts.push({ start, end: samples / rate });
  return bursts;
}

const srtTime = (seconds: number, separator: ',' | '.' = ','): string => {
  const total = Math.round(seconds * 1000);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(Math.floor(total / 3600000))}:${two(Math.floor(total / 60000) % 60)}:${two(
    Math.floor(total / 1000) % 60,
  )}${separator}${String(total % 1000).padStart(3, '0')}`;
};

test('a short upload goes as it is: transcript, exports, Send to, light and dark', async ({
  page,
  context,
  mock,
}) => {
  await seedApp(context, { key: true });
  mock.json('GET', '/api/v1/models', CATALOG);
  mock.json('POST', PATH, fixture('audio-transcriptions-verbose.recorded.json').response, {
    headers: { 'x-generation-id': 'gen-stt-1' },
  });
  const problems = await watchForProblems(page);
  await page.goto('tools/speech-to-text/');
  await page.getByTestId('stt-drop-zone').locator('input[type=file]').setInputFiles(SPEECH);
  await expect(page.getByTestId('stt-source-name')).toHaveText('speech.mp3');
  await expect(page.getByTestId('stt-source-meta')).toHaveText('0:03 · 12.9 KB');
  await expect(page.getByTestId('stt-source-plan')).toHaveText('Sent as it is, in one request.');
  await expect(page.getByTestId('cost-estimate')).toHaveAttribute('data-state', 'estimate');
  await expect(page.getByTestId('stt-player').locator('audio')).toHaveCount(1);

  await page.getByTestId('run-button').click();
  const text = page.getByTestId('stt-segment-text');
  await expect(text).toHaveValue('The quick brown fox jumps over the lazy dog.');
  await expect(page.getByTestId('tool-status')).toHaveText('Done · 1 segment');

  const calls = mock.calls(PATH);
  expect(calls).toHaveLength(1);
  const body = bodyOf(calls[0]!);
  expect(body).toMatchObject({
    model: 'openai/whisper-large-v3-turbo',
    input_audio: { format: 'mp3' },
    response_format: 'verbose_json',
    timestamp_granularities: ['segment', 'word'],
  });
  expect(body.input_audio.data).toBe(readFileSync(SPEECH).toString('base64'));
  expect(body.diarize).toBeUndefined();
  expect(body.keyterms).toBeUndefined();

  // Cue lines wrap at 42 characters.
  expect(await download(page, 'export-srt')).toBe(
    '1\n00:00:00,000 --> 00:00:02,760\nThe quick brown fox jumps over the lazy\ndog.\n',
  );
  expect(await download(page, 'export-vtt')).toBe(
    'WEBVTT\n\n00:00:00.000 --> 00:00:02.760\nThe quick brown fox jumps over the lazy\ndog.\n',
  );
  expect(await download(page, 'export-txt')).toBe('The quick brown fox jumps over the lazy dog.');
  const json = JSON.parse(await download(page, 'export-json')) as {
    segments: unknown[];
    words: { word: string; start: number }[];
  };
  expect(json.segments).toEqual([
    { start: 0, end: 2.76, text: 'The quick brown fox jumps over the lazy dog.' },
  ]);
  expect(json.words.map((word) => word.word)).toEqual(
    'The quick brown fox jumps over the lazy dog.'.split(' '),
  );
  expect(json.words[1]!.start).toBe(0.12);

  // The time plays the recording from there.
  await page.getByTestId('stt-seek').click();
  await expect(page.getByTestId('stt-segment')).toHaveAttribute('aria-current', 'true');

  await page.getByTestId('stt-send').click();
  await expect(page.getByTestId('send-to-chat')).toBeVisible();
  await page.getByTestId('send-to-dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('send-to-dialog')).toBeHidden();

  await page.emulateMedia({ colorScheme: 'light' });
  await expectNoSeriousA11yViolations(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark');
  await expectNoSeriousA11yViolations(page);
  await page.screenshot({ path: test.info().outputPath('stt-dark.png'), fullPage: true });
  expect(problems).toEqual([]);
});

/**
 * A stubbed microphone: a tone (or silence) through a real MediaStream, so MediaRecorder records for real in every
 * browser. `window.__mic` lets a test change the named microphones (`devices`, ids `mic-<index>`) and make some
 * refuse to open (`refuse`, as an unplugged device does); `asked` lists the constraints each request used.
 */
async function stubMicrophone(
  context: BrowserContext,
  options: { silent?: boolean } = {},
): Promise<void> {
  await context.addInitScript((silent: boolean) => {
    if (!navigator.mediaDevices) return;
    const mic = {
      devices: ['Desk microphone', 'Headset'],
      refuse: [] as string[],
      asked: [] as unknown[],
    };
    (window as unknown as { __mic: typeof mic }).__mic = mic;
    navigator.mediaDevices.getUserMedia = (constraints) => {
      const audio = constraints?.audio;
      mic.asked.push(audio ?? null);
      const wanted =
        typeof audio === 'object' && audio !== null
          ? (audio.deviceId as { exact?: string } | undefined)?.exact
          : undefined;
      if (wanted && mic.refuse.includes(wanted)) {
        return Promise.reject(
          Object.assign(new Error('Device gone'), { name: 'OverconstrainedError' }),
        );
      }
      const context = new AudioContext();
      const out = context.createMediaStreamDestination();
      if (!silent) {
        // A tone whose level swells three times a second, so every meter reading differs.
        const tone = context.createOscillator();
        const level = context.createGain();
        level.gain.value = 0.5;
        const swell = context.createOscillator();
        swell.frequency.value = 3;
        const depth = context.createGain();
        depth.gain.value = 0.45;
        swell.connect(depth).connect(level.gain);
        tone.connect(level).connect(out);
        tone.start();
        swell.start();
      }
      return Promise.resolve(out.stream);
    };
    navigator.mediaDevices.enumerateDevices = () =>
      Promise.resolve(
        mic.devices.map(
          (label, i) =>
            ({ deviceId: `mic-${i}`, groupId: 'g', kind: 'audioinput', label }) as MediaDeviceInfo,
        ),
      );
  }, options.silent ?? false);
}

/** Skips a test in a browser build without MediaRecorder (Playwright's WebKit on Windows). */
async function needsMediaRecorder(page: Page): Promise<void> {
  test.skip(
    await page.evaluate(() => typeof MediaRecorder === 'undefined'),
    'This browser build has no MediaRecorder',
  );
}

/** The recorder's timer in seconds ("1:05" is 65). */
async function recordedSeconds(page: Page): Promise<number> {
  const text = (await page.getByTestId('stt-record-time').textContent()) ?? '';
  const [minutes = '0', seconds = '0'] = (/^(\d+):(\d\d)/.exec(text) ?? []).slice(1);
  return Number(minutes) * 60 + Number(seconds);
}

/**
 * Waits until sound reaches the recorder: its level meter moves. On a busy machine the stubbed microphone's first
 * audio arrives well after Record, and a recording stopped before it holds nothing ("Nothing was recorded").
 */
async function waitForSound(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page
          .getByTestId('stt-record-level')
          .locator('.or-level-bar')
          .evaluate((bar: HTMLElement) => bar.style.transform),
      { timeout: 30_000 },
    )
    .not.toMatch(/^(scaleX\(0(\.0+)?\))?$/);
}

/**
 * Waits until sound is coming in and at least `seconds` are recorded. Never waits for one exact timer text: under
 * load the timer can move past it between two looks.
 */
async function recordUntil(page: Page, seconds: number): Promise<void> {
  await waitForSound(page);
  await expect
    .poll(() => recordedSeconds(page), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(seconds);
}

/** Dispatches `beforeunload` and says whether the page asked to confirm leaving. */
const leavingAsks = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });

test('a recording from the microphone, paused and resumed, is transcribed', async ({
  page,
  context,
  mock,
}) => {
  await seedApp(context, { key: true });
  mock.json('GET', '/api/v1/models', CATALOG);
  mock.json('POST', PATH, fixture('audio-transcriptions-verbose.recorded.json').response);
  await stubMicrophone(context);
  const problems = await watchForProblems(page);
  await page.goto('tools/speech-to-text/');
  await needsMediaRecorder(page);
  await expect(page.getByTestId('stt-mic')).toBeVisible();
  await page.getByTestId('stt-mic').selectOption('mic-1');

  // By keyboard (WebKit does not focus a clicked button): Record turns into Stop, and focus follows.
  await page.getByTestId('stt-record').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('stt-record-stop')).toBeFocused();
  const time = page.getByTestId('stt-record-time');
  await expect(time).toHaveAttribute('role', 'timer');
  await expect(time).toHaveAttribute('aria-label', 'Recorded time');
  await recordUntil(page, 1);

  await page.getByTestId('stt-record-pause').click();
  await expect(page.getByTestId('stt-record-pause')).toHaveText('Resume');
  await expect(page.getByTestId('run-button')).toHaveAttribute('aria-disabled', 'true');
  // Paused: the timer stands still and the level meter is at rest (its loop is stopped).
  const paused = await recordedSeconds(page);
  await page.waitForTimeout(1500);
  expect(await recordedSeconds(page)).toBe(paused);
  expect(
    await page
      .getByTestId('stt-record-level')
      .locator('.or-level-bar')
      .evaluate((bar: HTMLElement) => bar.style.transform),
  ).toBe('scaleX(0)');
  await page.getByTestId('stt-record-pause').click();
  await recordUntil(page, paused + 1);
  await page.getByTestId('stt-record-stop').focus();
  await page.keyboard.press('Enter');

  const name = page.getByTestId('stt-source-name');
  await expect(name).toHaveText(/^recording-[\d-]+\.(webm|ogg|m4a)$/);
  await expect(page.getByTestId('stt-record')).toBeFocused();
  await expect(page.getByTestId('result-download')).toHaveText('Download recording');
  await expect(page.getByTestId('run-button')).toHaveAttribute('aria-disabled', 'false');
  await page.getByTestId('run-button').click();
  await expect(page.getByTestId('stt-segment-text')).toHaveValue(
    'The quick brown fox jumps over the lazy dog.',
  );
  // The container the browser recorded in is the format sent (WebM in Chromium and Firefox).
  const extension = /\.(\w+)$/.exec((await name.textContent()) ?? '')?.[1];
  const body = bodyOf(mock.calls(PATH)[0]!);
  expect(body.input_audio.format).toBe(extension);
  if (extension === 'webm') {
    expect(Buffer.from(body.input_audio.data, 'base64').subarray(0, 4)).toEqual(
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    );
  }
  expect(problems).toEqual([]);
});

test('a recording in progress is protected from leaving the page', async ({ page, context }) => {
  await seedApp(context, { key: true });
  await stubMicrophone(context);
  const problems = await watchForProblems(page);
  await page.goto('tools/speech-to-text/');
  await needsMediaRecorder(page);
  expect(await leavingAsks(page)).toBe(false);
  await page.getByTestId('stt-record').click();
  await recordUntil(page, 1);
  expect(await leavingAsks(page)).toBe(true);

  // An in-app link: the app's dialog names the recording in progress; staying keeps it going.
  const guard = page.getByTestId('leave-guard');
  await page.getByTestId('history-link').click();
  await expect(guard).toBeVisible();
  await expect(page.getByTestId('leave-guard-list')).toHaveText('A recording in progress');
  await page.getByTestId('leave-guard-stay').click();
  await expect(guard).toBeHidden();
  await expect(page).toHaveURL(/\/tools\/speech-to-text\/$/);
  await expect(page.getByTestId('stt-record-stop')).toBeVisible();
  const before = await recordedSeconds(page);
  await recordUntil(page, before + 1);

  // Stopped, it is a result not yet downloaded, and that is what the dialog names now.
  await page.getByTestId('stt-record-stop').click();
  await expect(page.getByTestId('stt-source-name')).toHaveText(/^recording-/);
  expect(await leavingAsks(page)).toBe(true);
  await page.getByTestId('history-link').click();
  await expect(guard).toBeVisible();
  await expect(page.getByTestId('leave-guard-list')).toContainText('not downloaded');
  await expect(page.getByTestId('leave-guard-list')).not.toContainText('A recording in progress');
  await page.getByTestId('leave-guard-stay').click();
  await expect(page).toHaveURL(/\/tools\/speech-to-text\/$/);
  expect(problems).toEqual([]);
});

test('under Reduced motion the level meter moves four times a second, not every frame', async ({
  page,
  context,
}) => {
  await seedApp(context, { key: true, settings: { appearance: { reducedMotion: true } } });
  await stubMicrophone(context);
  const problems = await watchForProblems(page);
  await page.goto('tools/speech-to-text/');
  await needsMediaRecorder(page);
  await page.getByTestId('stt-record').click();
  await recordUntil(page, 1);
  const updates = await page
    .getByTestId('stt-record-level')
    .locator('.or-level-bar')
    .evaluate(
      (bar) =>
        new Promise<number>((resolve) => {
          let count = 0;
          const observer = new MutationObserver((records) => {
            count += records.length;
          });
          observer.observe(bar, { attributes: true, attributeFilter: ['style'] });
          setTimeout(() => {
            observer.disconnect();
            resolve(count);
          }, 2000);
        }),
    );
  // About eight in two seconds (a frame-paced meter makes over a hundred).
  expect(updates).toBeGreaterThan(0);
  expect(updates).toBeLessThanOrEqual(10);
  await page.getByTestId('stt-record-stop').click();
  await expect(page.getByTestId('stt-source-name')).toHaveText(/^recording-/);
  expect(problems).toEqual([]);
});

test('no signal from the microphone is noticed and announced', async ({ page, context }) => {
  await seedApp(context, { key: true });
  await stubMicrophone(context, { silent: true });
  const problems = await watchForProblems(page);
  await page.goto('tools/speech-to-text/');
  await needsMediaRecorder(page);
  await page.getByTestId('stt-record').click();
  const warning = page.getByTestId('stt-record-silence');
  await expect(warning).toBeVisible({ timeout: 15_000 });
  await expect(warning).toHaveText('No sound detected — check your microphone.');
  await expect(page.getByTestId('announcer-polite')).toHaveText(
    'No sound detected — check your microphone.',
  );
  await page.getByTestId('stt-record-stop').click();
  await expect(warning).toBeHidden();
  expect(problems).toEqual([]);
});

test('the chosen microphone going away falls back to the default one', async ({
  page,
  context,
}) => {
  await seedApp(context, { key: true });
  await stubMicrophone(context);
  const problems = await watchForProblems(page);
  await page.goto('tools/speech-to-text/');
  await needsMediaRecorder(page);
  const picker = page.getByTestId('stt-mic');
  await picker.selectOption('mic-1');

  // The headset is unplugged: the default microphone is used again, and the page says so.
  await page.evaluate(() => {
    (window as unknown as { __mic: { devices: string[] } }).__mic.devices = ['Desk microphone'];
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  });
  const note = page.getByTestId('stt-record-note');
  await expect(note).toHaveText(
    'The chosen microphone is no longer available, so the default microphone is used.',
  );
  await expect(page.getByTestId('announcer-polite')).toHaveText(
    'The chosen microphone is no longer available, so the default microphone is used.',
  );
  // Plugged in again, the picker is back and usable, on the default.
  await page.evaluate(() => {
    (window as unknown as { __mic: { devices: string[] } }).__mic.devices = [
      'Desk microphone',
      'Headset',
    ];
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  });
  await expect(picker).toBeEnabled();
  await expect(picker).toHaveValue('mic-0');

  // Chosen, but it refuses to open (gone between two device lists): Record falls back to the default.
  await picker.selectOption('mic-1');
  await page.evaluate(() => {
    (window as unknown as { __mic: { refuse: string[] } }).__mic.refuse = ['mic-1'];
  });
  await page.getByTestId('stt-record').click();
  await expect(page.getByTestId('stt-record-stop')).toBeVisible();
  await expect(note).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { __mic: { asked: unknown[] } }).__mic.asked),
  ).toEqual([{ deviceId: { exact: 'mic-1' } }, true]);
  await expect(page.getByTestId('stt-record-error')).toBeHidden();
  await recordUntil(page, 1);
  await page.getByTestId('stt-record-stop').click();
  await expect(page.getByTestId('stt-source-name')).toHaveText(/^recording-/);
  expect(problems).toEqual([]);
});

test('a time in the transcript of a recording plays from there', async ({
  page,
  context,
  mock,
}) => {
  await seedApp(context, { key: true });
  mock.json('GET', '/api/v1/models', CATALOG);
  mock.json('POST', PATH, {
    text: 'One. Two. Three.',
    duration: 4,
    segments: [
      { start: 0, end: 1, text: 'One.' },
      { start: 1.5, end: 2.4, text: 'Two.' },
      { start: 2.8, end: 3.5, text: 'Three.' },
    ],
  });
  await stubMicrophone(context);
  const problems = await watchForProblems(page);
  await page.goto('tools/speech-to-text/');
  await needsMediaRecorder(page);
  await page.getByTestId('stt-record').click();
  await recordUntil(page, 4);
  await page.getByTestId('stt-record-stop').click();
  await expect(page.getByTestId('stt-source-name')).toHaveText(/^recording-/);
  await page.getByTestId('run-button').click();
  await expect(page.getByTestId('stt-segment')).toHaveCount(3);

  // MediaRecorder's WebM has no duration in its header (the browser reports Infinity) and no seek index: the
  // player finds the length by seeking to the end and back, and a seek made meanwhile must not be undone by that
  // rewind. Where each seek lands is read when it lands (playback that merely started from 0 and ran on cannot
  // pass), and the last one must be the segment's start.
  const audio = page.getByTestId('stt-player').locator('audio');
  await audio.evaluate((element: HTMLAudioElement) => {
    element.addEventListener('seeked', () => {
      element.dataset['seekedAt'] = String(element.currentTime);
    });
  });
  await page.getByTestId('stt-seek').nth(1).click();
  const landed = async (): Promise<number> =>
    Number((await audio.getAttribute('data-seeked-at')) ?? Number.NaN);
  await expect.poll(async () => Math.abs((await landed()) - 1.5) < 0.1).toBe(true);
  // Nothing rewinds it afterwards: a second later it plays on from there.
  await page.waitForTimeout(1000);
  expect(Math.abs((await landed()) - 1.5)).toBeLessThan(0.1);
  expect(
    await audio.evaluate((element: HTMLAudioElement) => element.currentTime),
  ).toBeGreaterThanOrEqual(1.4);
  await expect(page.getByTestId('stt-segment').nth(1)).toHaveAttribute('aria-current', 'true');
  expect(problems).toEqual([]);
});

test('speaker labels go through the Deepgram provider option; names apply everywhere', async ({
  page,
  context,
  mock,
}) => {
  await seedApp(context, {
    key: true,
    settings: {
      tools: { 'speech-to-text': { model: 'deepgram/nova-3', options: { diarize: true } } },
    },
  });
  mock.json('GET', '/api/v1/models', CATALOG);
  mock.json(
    'POST',
    PATH,
    fixture('audio-transcriptions-diarize-deepgram-options.recorded.json').response,
  );
  const problems = await watchForProblems(page);
  await page.goto('tools/speech-to-text/');
  await page.getByTestId('tool-prompt').fill('fox, lazy dog');
  await page.getByTestId('stt-drop-zone').locator('input[type=file]').setInputFiles(SPEECH);
  await expect(page.getByTestId('stt-source-name')).toHaveText('speech.mp3');
  await page.getByTestId('run-button').click();
  await expect(page.getByTestId('stt-segment-speaker')).toHaveText('Speaker 1');

  const body = bodyOf(mock.calls(PATH)[0]!);
  expect(body.model).toBe('deepgram/nova-3');
  expect(body.provider?.options).toEqual({ deepgram: { diarize: true } });
  expect(body.diarize).toBeUndefined();
  expect(body.response_format).toBe('verbose_json');
  expect(body.keyterms).toEqual(['fox', 'lazy dog']);

  await page.getByTestId('stt-speaker-name').fill('Narrator');
  await expect(page.getByTestId('stt-segment-speaker')).toHaveText('Narrator');
  expect(await download(page, 'export-srt')).toContain(
    '00:00:00,000 --> 00:00:02,880\nNarrator: The quick brown fox jumps over the lazy\ndog.',
  );
  await page.getByTestId('stt-view-text').click();
  await expect(page.getByTestId('stt-text')).toHaveText(
    'Narrator: The quick brown fox jumps over the lazy dog.',
  );
  await expectNoSeriousA11yViolations(page);

  // The drawer shows the choice as on, and why it works with this model.
  await page.getByTestId('drawer-button').click();
  await expect(page.getByTestId('stt-diarize')).toBeChecked();
  await expect(page.getByTestId('stt-diarize')).toBeEnabled();
  await expect(page.getByTestId('stt-diarize-note')).toContainText('labelled per part');
  expect(problems).toEqual([]);
});

test('Stop ends the parts in flight and keeps what arrived', async ({ page, context, mock }) => {
  await seedApp(context, {
    key: true,
    settings: { tools: { 'speech-to-text': { options: { partMinutes: 1 } } } },
  });
  mock.json('GET', '/api/v1/models', CATALOG);
  let answered = 0;
  mock.respond('POST', PATH, () => ({
    delayMs: answered++ === 0 ? 0 : 30_000,
    body: {
      text: 'First part.',
      segments: [{ start: 0, end: 8, text: 'First part.' }],
      duration: 59,
    },
  }));
  // Stop aborts the transcription requests in flight.
  const problems = await watchForProblems(page, { allowAborted: [PATH] });
  await page.goto('tools/speech-to-text/');
  await addSynthesisedWav(page, 150, 'two-and-a-half-minutes.wav');
  await expect(page.getByTestId('stt-source-plan')).toHaveText(
    'Decoded and cut at pauses into about 3 parts of up to 1:00.',
  );
  await page.getByTestId('run-button').click();
  const parts = page.getByTestId('stt-part');
  await expect(parts).toHaveCount(3);
  await expect(page.locator('[data-testid="stt-part"][data-status="done"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="stt-part"][data-status="running"]')).toHaveCount(2);
  await page.getByTestId('stop-button').click();
  await expect(page.getByTestId('tool-status')).toHaveText('Stopped');
  await expect(page.locator('[data-testid="stt-part"][data-status="stopped"]')).toHaveCount(2);
  await expect(page.getByTestId('stt-segment-text')).toHaveValue('First part.');
  await expect(page.getByTestId('stt-retry-failed')).toHaveText('Retry them');
  expect(mock.calls(PATH)).toHaveLength(3);
  expect(problems).toEqual([]);
});

test('the sample loads a short spoken clip, ready to transcribe', async ({
  page,
  context,
  mock,
}) => {
  await seedApp(context, { key: true });
  mock.json('GET', '/api/v1/models', CATALOG);
  const problems = await watchForProblems(page);
  await page.goto('tools/speech-to-text/?sample=1');
  await expect(page.getByTestId('stt-source-name')).toHaveText('sample-speech.mp3');
  await expect(page.getByTestId('stt-source-meta')).toHaveText('0:03 · 12.9 KB');
  await expect(page.getByTestId('tool-prompt')).not.toHaveValue('');
  expect(problems).toEqual([]);
});

test('free-only mode: no transcription model is free, so the tool says so and cannot run', async ({
  page,
  context,
  mock,
}) => {
  await seedApp(context, { key: true, settings: { freeOnly: true } });
  mock.json('GET', '/api/v1/models', CATALOG);
  const problems = await watchForProblems(page);
  await page.goto('tools/speech-to-text/');
  await expect(page.getByTestId('free-only-notice')).toContainText(
    'This tool cannot run in free-only mode',
  );
  await expect(page.getByTestId('run-button')).toHaveAttribute('aria-disabled', 'true');
  await page.getByTestId('stt-drop-zone').locator('input[type=file]').setInputFiles(SPEECH);
  await expect(page.getByTestId('stt-source-name')).toHaveText('speech.mp3');
  // Run stays focusable but does nothing (aria-disabled; Bootstrap's .disabled takes pointer events away).
  await page.getByTestId('run-button').dispatchEvent('click');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByTestId('stt-segment')).toHaveCount(0);
  expect(mock.calls(PATH)).toHaveLength(0);
  await expectNoSeriousA11yViolations(page);
  expect(problems).toEqual([]);
});

test('Stage 4 gate: a 60-minute recording is cut into parts and merged with continuous timestamps', async ({
  page,
  context,
  mock,
}) => {
  test.setTimeout(15 * 60_000);
  await seedApp(context, { key: true });
  mock.json('GET', '/api/v1/models', CATALOG);
  // Each part's answer is what a model would say about the audio it got: one segment per tone burst, timed
  // from the part's own start (0), never from the recording's.
  const partSeconds: number[] = [];
  mock.respond('POST', PATH, (call) => {
    const audio = bodyOf(call).input_audio;
    const bytes = Buffer.from(audio.data, 'base64');
    const seconds = (bytes.length - 44) / 32000;
    partSeconds.push(seconds);
    const segments = burstsIn(audio.data).map((burst, i) => ({
      id: i,
      start: burst.start,
      end: burst.end,
      text: ` Tone ${i + 1}.`,
    }));
    return {
      body: {
        text: segments.map((segment) => segment.text).join(''),
        language: 'en',
        duration: seconds,
        segments,
        usage: { seconds, cost: seconds * 0.0000033333 },
      },
    };
  });
  const problems = await watchForProblems(page);
  await page.goto('tools/speech-to-text/');
  await addSynthesisedWav(page, 3600, 'meeting-60-minutes.wav');
  await expect(page.getByTestId('stt-source-meta')).toHaveText('1:00:00 · 109.9 MB');
  await expect(page.getByTestId('stt-source-plan')).toContainText('parts of up to 5:00');
  await page.getByTestId('run-button').click();
  await expect(page.getByTestId('tool-status')).toHaveText(/^Done · \d+ parts$/, {
    timeout: 12 * 60_000,
  });

  // Cut into parts no longer than 5 minutes that add up to the hour.
  const parts = await page.getByTestId('stt-part').count();
  expect(parts).toBeGreaterThanOrEqual(12);
  expect(mock.calls(PATH)).toHaveLength(parts);
  for (const seconds of partSeconds) expect(seconds).toBeLessThanOrEqual(300);
  expect(partSeconds.reduce((sum, seconds) => sum + seconds, 0)).toBeCloseTo(3600, 3);

  // One segment per burst, each where the burst is in the recording: offsets added, continuous, monotonic.
  const json = JSON.parse(await download(page, 'export-json')) as {
    duration: number;
    segments: { start: number; end: number; text: string }[];
  };
  expect(json.duration).toBeCloseTo(3600, 3);
  expect(json.segments).toHaveLength(360);
  json.segments.forEach((segment, i) => {
    expect(Math.abs(segment.start - i * 10)).toBeLessThan(0.05);
    expect(Math.abs(segment.end - (i * 10 + 8))).toBeLessThan(0.05);
    if (i > 0) expect(segment.start).toBeGreaterThanOrEqual(json.segments[i - 1]!.end);
  });
  expect(json.segments.at(-1)!.end).toBeGreaterThan(3597.9);

  // SRT and VTT carry exactly those times.
  const srt = (await download(page, 'export-srt')).trimEnd().split('\n\n');
  expect(srt).toHaveLength(360);
  srt.forEach((cue, i) => {
    const segment = json.segments[i]!;
    expect(cue.split('\n')[0]).toBe(String(i + 1));
    expect(cue.split('\n')[1]).toBe(`${srtTime(segment.start)} --> ${srtTime(segment.end)}`);
  });
  expect(srt[0]).toBe('1\n00:00:00,000 --> 00:00:08,000\nTone 1.');
  expect(srt.at(-1)!.split('\n')[1]).toMatch(/^00:59:50,0\d\d --> 00:59:58,0\d\d$/);
  const vtt = (await download(page, 'export-vtt')).trimEnd().split('\n\n');
  expect(vtt[0]).toBe('WEBVTT');
  expect(vtt).toHaveLength(361);
  vtt.slice(1).forEach((cue, i) => {
    const segment = json.segments[i]!;
    expect(cue.split('\n')[0]).toBe(
      `${srtTime(segment.start, '.')} --> ${srtTime(segment.end, '.')}`,
    );
  });
  await expect(page.getByTestId('stt-segment')).toHaveCount(360);
  expect(problems).toEqual([]);
});
