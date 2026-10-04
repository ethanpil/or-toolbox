/**
 * Stage 4 gate, Text-to-speech: a 10,000-word text read in parts against mocked speech responses (real MP3 from
 * tests/fixtures/media/speech.mp3, and generated raw PCM as Gemini TTS sends it), joined into one file whose
 * decoded length is the sum of the parts' lengths, with nothing lost or added at the seams. Also: voice
 * previews are cached, Stop keeps the parts already made, both download formats, and axe in both themes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, MEDIA_FIXTURES_DIR, type OpenRouterMock, test } from '../mock/index.ts';
import { seedApp } from './app.ts';
import { expectNoSeriousA11yViolations, watchForProblems } from './support.ts';

const SPEECH_MP3 = readFileSync(join(MEDIA_FIXTURES_DIR, 'speech.mp3'));
const CATALOG = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, '../fixtures/openrouter/models.json'), 'utf8'),
  ) as { data: { id: string; architecture: { output_modalities: string[] } }[] }
).data.filter((model) => model.architecture.output_modalities.includes('speech'));
const PREVIEW_TEXT = 'Hello! This is how I sound when I read your text aloud.';
const RATE = 24000;

interface SpeechBody {
  model: string;
  input: string;
  voice?: string;
  response_format?: string;
}

/** 125 paragraphs of ten eight-word sentences: exactly 10,000 words, about 62,000 characters. */
const TEN_THOUSAND_WORDS = Array.from({ length: 125 }, (_, p) =>
  Array.from(
    { length: 10 },
    (_, s) => `Paragraph ${p + 1} sentence ${s + 1} has exactly eight words.`,
  ).join(' '),
).join('\n\n');

/** Paragraphs of about 900 characters: each one a request of its own. */
const paragraphs = (count: number): string =>
  Array.from({ length: count }, (_, p) =>
    Array.from(
      { length: 15 },
      (_, s) => `Part ${p + 1}, sentence ${s + 1} is about sixty characters long.`,
    ).join(' '),
  ).join('\n\n');

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();

function mockCatalog(mock: OpenRouterMock): void {
  mock.json('GET', '/api/v1/models', { data: CATALOG });
  // The priciest endpoint is what estimates use: Kokoro on Together at $4 per million characters (§0).
  mock.json('GET', /^\/api\/v1\/models\/.+\/endpoints$/, {
    data: {
      endpoints: [
        { name: 'DeepInfra', provider_name: 'DeepInfra', pricing: { prompt: '0.00000062' } },
        { name: 'Together', provider_name: 'Together', pricing: { prompt: '0.000004' } },
      ],
    },
  });
}

const mp3Answer = { body: SPEECH_MP3, headers: { 'content-type': 'audio/mpeg' } };

/** One second-ish of a 440 Hz tone as raw 16-bit PCM at 24 kHz, `samples` long. */
function pcm(samples: number): Buffer {
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    out.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * 440 * i) / RATE)), i * 2);
  }
  return out;
}

/** Decoded length in samples (at 24 kHz) of the newest result's audio, and of an MP3 given as base64. */
async function decodedLengths(
  page: Page,
  segmentBase64: string | null,
): Promise<{ result: number; segment: number }> {
  return page.evaluate(
    async ({ base64, rate }) => {
      const decode = async (bytes: ArrayBuffer): Promise<number> =>
        (await new OfflineAudioContext(1, 1, rate).decodeAudioData(bytes)).length;
      const audio = document.querySelector<HTMLAudioElement>('[data-testid="tts-player"] audio')!;
      const result = await decode(await (await fetch(audio.src)).arrayBuffer());
      const segment = base64
        ? await decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer)
        : 0;
      return { result, segment };
    },
    { base64: segmentBase64, rate: RATE },
  );
}

async function download(page: Page, extension: 'mp3' | 'wav'): Promise<Buffer> {
  await page.getByTestId('tts-download').click();
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId(`export-${extension}`).click(),
  ]);
  expect(file.suggestedFilename()).toMatch(new RegExp(`^speech-.*\\.${extension}$`));
  return readFileSync(await file.path());
}

test.describe('Text-to-speech', () => {
  test.setTimeout(300_000);

  test('gate: 10,000 words from MP3 parts, joined as WAV with no gaps', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, {
      key: true,
      settings: { tools: { 'text-to-speech': { options: { format: 'wav' } } } },
    });
    mockCatalog(mock);
    mock.respond('POST', '/api/v1/audio/speech', () => mp3Answer);
    const problems = await watchForProblems(page);
    await page.goto('tools/text-to-speech/');

    await expect(page.getByTestId('tts-voice').locator('option')).toHaveCount(54);
    await page.getByTestId('tool-prompt').fill(TEN_THOUSAND_WORDS);
    await expect(page.getByTestId('tts-counts')).toContainText('10,000 words');
    // 62,000-odd characters at $4 per million characters.
    await expect(page.getByTestId('cost-estimate-value')).toHaveText(/^≈ \$0\.2[45]$/);
    await page.getByTestId('run-button').click();
    // About $0.25 is above the default $0.10 per-run threshold: the run asks first, with that estimate.
    const dialog = page.getByTestId('budget-dialog');
    await expect(dialog.getByTestId('budget-estimate')).toContainText(/\$0\.2[45]/);
    await dialog.getByTestId('budget-confirm').click();
    await expect(page.getByTestId('tts-result')).toBeVisible({ timeout: 240_000 });

    const calls = mock.calls('/api/v1/audio/speech');
    const bodies = calls.map((call) => call.body as SpeechBody);
    expect(bodies.length).toBeGreaterThan(55);
    for (const body of bodies) {
      expect(body).toMatchObject({
        model: 'hexgrad/kokoro-82m',
        voice: 'af_alloy',
        response_format: 'mp3',
      });
      expect(body.input.length).toBeLessThanOrEqual(1000);
    }
    // Every word was sent once, in order (requests run three at a time, so they arrive in any order).
    const ordered = [...bodies].sort(
      (a, b) =>
        Number(/^Paragraph (\d+) sentence (\d+)/.exec(a.input)?.slice(1).join('.') ?? 0) -
        Number(/^Paragraph (\d+) sentence (\d+)/.exec(b.input)?.slice(1).join('.') ?? 0),
    );
    expect(flat(ordered.map((body) => body.input).join(' '))).toBe(flat(TEN_THOUSAND_WORDS));

    // The joined audio is exactly the parts back to back: not a sample lost or added at any seam.
    const { result, segment } = await decodedLengths(page, SPEECH_MP3.toString('base64'));
    const seams = bodies.length - 1;
    console.info(
      `TTS gate (MP3 parts → WAV): ${bodies.length} parts of ${segment} samples; joined ${result} samples, expected ${segment * bodies.length}`,
    );
    expect(Math.abs(result - segment * bodies.length)).toBeLessThanOrEqual(seams * 0.002 * RATE);
    expect(result).toBe(segment * bodies.length);
    await expect(page.getByTestId('tool-status')).toHaveText(
      new RegExp(`^Generated \\d+:\\d\\d of audio, ${bodies.length} parts$`),
    );
    expect(problems).toEqual([]);
  });

  test('gate: raw PCM parts (Gemini TTS) joined as MP3; both downloads; axe in both themes', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, {
      key: true,
      settings: {
        tools: {
          'text-to-speech': { model: 'google/gemini-3.8-flash-tts', options: { format: 'mp3' } },
        },
      },
    });
    mockCatalog(mock);
    const lengths: number[] = [];
    mock.respond('POST', '/api/v1/audio/speech', () => {
      const samples = 9000 + (lengths.length % 7) * 1500;
      lengths.push(samples);
      return {
        body: pcm(samples),
        headers: { 'content-type': `audio/pcm;rate=${RATE};channels=1` },
      };
    });
    const problems = await watchForProblems(page);
    await page.goto('tools/text-to-speech/');
    await expect(page.getByTestId('tts-voice').locator('option')).toHaveCount(30);
    await page.getByTestId('tool-prompt').fill(TEN_THOUSAND_WORDS);
    await expect(page.getByTestId('cost-estimate-value')).toHaveText(/^≈ \$0\.2[45]$/);
    await page.getByTestId('run-button').click();
    // About $0.25 is above the default $0.10 per-run threshold: the run asks first, with that estimate.
    const dialog = page.getByTestId('budget-dialog');
    await expect(dialog.getByTestId('budget-estimate')).toContainText(/\$0\.2[45]/);
    await dialog.getByTestId('budget-confirm').click();
    await expect(page.getByTestId('tts-result')).toBeVisible({ timeout: 240_000 });

    const bodies = mock.calls('/api/v1/audio/speech').map((call) => call.body as SpeechBody);
    expect(bodies.every((body) => body.response_format === 'pcm')).toBe(true);
    const expected = lengths.reduce((sum, value) => sum + value, 0);
    const { result } = await decodedLengths(page, null);
    const seams = lengths.length - 1;
    console.info(
      `TTS gate (PCM parts → MP3): ${lengths.length} parts, ${(expected / RATE).toFixed(3)} s expected; joined MP3 decodes to ${(result / RATE).toFixed(3)} s`,
    );
    // One MP3 encode of the joined samples: within a few milliseconds per seam (the encoder's own padding).
    expect(Math.abs(result - expected) / RATE).toBeLessThanOrEqual(seams * 0.003);

    const mp3 = await download(page, 'mp3');
    expect(mp3.subarray(0, 3).toString('latin1') === 'ID3' || mp3[0] === 0xff).toBe(true);
    const wav = await download(page, 'wav');
    expect(wav.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('latin1')).toBe('WAVE');

    await expectNoSeriousA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoSeriousA11yViolations(page);
    expect(problems).toEqual([]);
  });

  test('a voice preview is made once and then played from memory', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, { key: true });
    mockCatalog(mock);
    mock.respond('POST', '/api/v1/audio/speech', () => mp3Answer);
    const problems = await watchForProblems(page);
    await page.goto('tools/text-to-speech/');
    const voice = page.getByTestId('tts-voice');
    await expect(voice.locator('option')).toHaveCount(54);
    await expect(voice.locator('option').first()).toHaveText('Alloy (American English, female)');
    const note = page.getByTestId('tts-preview-note');
    await expect(note).toHaveText(/^Preview reads one short sentence \(about \$0\.00022\)\.$/);

    const preview = page.getByTestId('tts-preview');
    await preview.click();
    await expect(note).toHaveText('Preview ready: it plays from memory, at no cost.');
    await expect(page.getByTestId('tts-preview-audio')).toBeVisible();
    // The button was never disabled, so focus stayed on it.
    await expect(preview).toBeFocused();
    await expect(preview).toHaveAttribute('aria-disabled', 'false');
    await preview.click();
    await voice.selectOption('bm_george');
    await expect(note).toContainText('Preview reads one short sentence');
    await preview.click();
    await expect(note).toHaveText('Preview ready: it plays from memory, at no cost.');
    await voice.selectOption('af_alloy');
    await expect(note).toHaveText('Preview ready: it plays from memory, at no cost.');
    await preview.click();

    const calls = mock.calls('/api/v1/audio/speech').map((call) => call.body as SpeechBody);
    expect(calls.map((body) => [body.input, body.voice])).toEqual([
      [PREVIEW_TEXT, 'af_alloy'],
      [PREVIEW_TEXT, 'bm_george'],
    ]);
    expect(problems).toEqual([]);
  });

  test('the free Fish model previews for free, with its own voice', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, { key: true, settings: { freeOnly: true } });
    mockCatalog(mock);
    mock.respond('POST', '/api/v1/audio/speech', () => mp3Answer);
    const problems = await watchForProblems(page);
    await page.goto('tools/text-to-speech/');
    await expect(page.getByTestId('model-chip-name')).toHaveText('fish-audio/s2.1-pro-free:free');
    await expect(page.getByTestId('tts-voice')).toHaveText("The model's own voice");
    await expect(page.getByTestId('tts-preview-note')).toHaveText(
      'Preview reads one short sentence (free).',
    );
    await page.getByTestId('tts-preview').click();
    await expect(page.getByTestId('tts-preview-note')).toContainText('plays from memory');
    const [body] = mock.calls('/api/v1/audio/speech').map((call) => call.body as SpeechBody);
    expect(body).toEqual({
      model: 'fish-audio/s2.1-pro-free:free',
      input: PREVIEW_TEXT,
      response_format: 'mp3',
    });
    expect(problems).toEqual([]);
  });

  test('a part that will not decode is found when the join fails, and only it is made again', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, {
      key: true,
      settings: { tools: { 'text-to-speech': { options: { format: 'wav' } } } },
    });
    mockCatalog(mock);
    // An "MP3" that sniffs as one (an ID3 tag) but holds no audio frames.
    const broken = Buffer.concat([
      Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]),
      Buffer.alloc(400),
    ]);
    let brokenSent = false;
    mock.respond('POST', '/api/v1/audio/speech', (call) => {
      if (!brokenSent && (call.body as SpeechBody).input.startsWith('Part 2,')) {
        brokenSent = true;
        return { body: broken, headers: { 'content-type': 'audio/mpeg' } };
      }
      return mp3Answer;
    });
    const problems = await watchForProblems(page);
    await page.goto('tools/text-to-speech/');
    await expect(page.getByTestId('tts-voice').locator('option')).toHaveCount(54);
    await page.getByTestId('tool-prompt').fill(paragraphs(3));
    await page.getByTestId('run-button').click();

    await expect(page.getByTestId('tool-status')).toHaveText(
      'Joining failed: 1 part could not be decoded',
      { timeout: 60_000 },
    );
    const notice = page.getByTestId('tts-notice');
    await expect(notice.getByTestId('tts-failed')).toHaveText(
      'Part 2: its audio could not be decoded',
    );
    await notice.getByTestId('tts-retry').click();
    await expect(page.getByTestId('tts-result')).toBeVisible({ timeout: 60_000 });
    const calls = mock.calls('/api/v1/audio/speech').map((call) => call.body as SpeechBody);
    expect(calls).toHaveLength(4);
    expect(calls[3]?.input).toMatch(/^Part 2,/);
    const { result, segment } = await decodedLengths(page, SPEECH_MP3.toString('base64'));
    expect(result).toBe(segment * 3);
    expect(problems).toEqual([]);
  });

  test('Stop keeps the parts already made; Read aloud makes only the rest and joins them', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, {
      key: true,
      settings: { tools: { 'text-to-speech': { options: { format: 'wav' } } } },
    });
    mockCatalog(mock);
    let slow = true;
    let answered = 0;
    mock.respond('POST', '/api/v1/audio/speech', () => {
      answered += 1;
      return { ...mp3Answer, delayMs: slow && answered > 2 ? 20_000 : 0 };
    });
    // Stop aborts the speech requests in flight.
    const problems = await watchForProblems(page, { allowAborted: ['/api/v1/audio/speech'] });
    await page.goto('tools/text-to-speech/');
    await expect(page.getByTestId('tts-voice').locator('option')).toHaveCount(54);
    await page.getByTestId('tool-prompt').fill(paragraphs(8));
    await expect(page.getByTestId('tts-counts')).toContainText('8 requests');
    await page.getByTestId('run-button').click();
    await expect(page.getByTestId('tool-status')).toHaveText('Reading aloud: 2 of 8 parts');
    await page.getByTestId('stop-button').click();

    await expect(page.getByTestId('tool-status')).toHaveText('Stopped · 2 of 8 parts made');
    const notice = page.getByTestId('tts-notice');
    await expect(notice).toContainText('2 of 8 parts made. 6 not made');
    await expect(page.getByTestId('tts-result')).toHaveCount(0);
    const sent = mock.calls('/api/v1/audio/speech').length;
    expect(sent).toBeLessThanOrEqual(5); // two answered, at most three in flight; nothing started after Stop

    slow = false;
    // Read aloud again with the same text continues: only the six missing parts are paid for.
    await page.getByTestId('run-button').click();
    await expect(page.getByTestId('tts-result')).toBeVisible({ timeout: 120_000 });
    await expect(notice).toBeHidden();
    const retried = mock.calls('/api/v1/audio/speech').slice(sent);
    expect(retried).toHaveLength(6);
    const { result, segment } = await decodedLengths(page, SPEECH_MP3.toString('base64'));
    expect(result).toBe(segment * 8);
    expect(problems).toEqual([]);
  });
});
