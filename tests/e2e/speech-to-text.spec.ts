/**
 * Speech-to-text against the mocked OpenRouter: a short upload sent as it is (recorded Whisper fixture), a
 * recording from a stubbed microphone, speaker labels through Deepgram's provider option, Stop, the free-only
 * notice (no free transcription model exists), and the Stage 4 gate: a 60-minute recording, synthesised in the
 * page, cut into parts whose mocked transcripts all start at 0, merged with continuous timestamps, with SRT and VTT
 * exports that match the JSON.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
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

/**
 * Accepts the aborted requests the page causes on purpose; everything else still counts:
 * - Stop aborts the transcription requests in flight;
 * - the player's `<audio preload="metadata">` stops reading a large recording's `blob:` URL once it has the
 *   metadata, which Chromium reports as an aborted request.
 */
const withoutAborted = (problems: string[], stopped = false): string[] =>
  problems.filter(
    (problem) =>
      !(stopped && problem.includes(`${PATH} (net::ERR_ABORTED)`)) &&
      !/^request failed: blob:\S+ \(net::ERR_ABORTED\)$/.test(problem),
  );

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

test('a recording from the microphone, paused and resumed, is transcribed', async ({
  page,
  context,
  mock,
}) => {
  await seedApp(context, { key: true });
  mock.json('GET', '/api/v1/models', CATALOG);
  mock.json('POST', PATH, fixture('audio-transcriptions-verbose.recorded.json').response);
  // A microphone that plays a tone, and two named microphones to choose from.
  await context.addInitScript(() => {
    if (!navigator.mediaDevices) return;
    navigator.mediaDevices.getUserMedia = () => {
      const audio = new AudioContext();
      const tone = audio.createOscillator();
      const out = audio.createMediaStreamDestination();
      tone.connect(out);
      tone.start();
      return Promise.resolve(out.stream);
    };
    navigator.mediaDevices.enumerateDevices = () =>
      Promise.resolve(
        ['Desk microphone', 'Headset'].map(
          (label, i) =>
            ({ deviceId: `mic-${i}`, groupId: 'g', kind: 'audioinput', label }) as MediaDeviceInfo,
        ),
      );
  });
  const problems = await watchForProblems(page);
  await page.goto('tools/speech-to-text/');
  test.skip(
    await page.evaluate(() => typeof MediaRecorder === 'undefined'),
    'This browser build has no MediaRecorder',
  );
  await expect(page.getByTestId('stt-mic')).toBeVisible();
  await page.getByTestId('stt-mic').selectOption('mic-1');

  await page.getByTestId('stt-record').click();
  await expect(page.getByTestId('stt-record-stop')).toBeFocused();
  await expect(page.getByTestId('stt-record-time')).toHaveText('0:01');
  await page.getByTestId('stt-record-pause').click();
  await expect(page.getByTestId('stt-record-pause')).toHaveText('Resume');
  await expect(page.getByTestId('run-button')).toHaveAttribute('aria-disabled', 'true');
  await page.getByTestId('stt-record-pause').click();
  await expect(page.getByTestId('stt-record-time')).toHaveText('0:02');
  await page.getByTestId('stt-record-stop').click();

  await expect(page.getByTestId('stt-source-name')).toHaveText(/^recording-[\d-]+\.webm$/);
  await expect(page.getByTestId('stt-record')).toBeFocused();
  await expect(page.getByTestId('result-download')).toHaveText('Download recording');
  await expect(page.getByTestId('run-button')).toHaveAttribute('aria-disabled', 'false');
  await page.getByTestId('run-button').click();
  await expect(page.getByTestId('stt-segment-text')).toHaveValue(
    'The quick brown fox jumps over the lazy dog.',
  );
  const body = bodyOf(mock.calls(PATH)[0]!);
  expect(body.input_audio.format).toBe('webm');
  expect(Buffer.from(body.input_audio.data, 'base64').subarray(0, 4)).toEqual(
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  );
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
  const problems = await watchForProblems(page);
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
  expect(withoutAborted(problems, true)).toEqual([]);
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
  expect(withoutAborted(problems)).toEqual([]);
});
