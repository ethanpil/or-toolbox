import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawModel, SpeechRequest, SpeechResult } from '../../core/api/types';
import { ApiError, RunCancelledError } from '../../core/errors';
import type * as AudioModule from '../../core/media/audio';
import { parseWav } from '../../core/media/wav';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import type { ApiClient } from '../../core/types';
import { setToolBinding } from '../../ui/settings-actions';
import { createToolTestContext, type ToolTestContext } from '../../ui/tool/testing';
import { getTool } from '../registry';
import { setup } from './tool';

/**
 * stitchAudio needs Web Audio; here it records what it was given and returns a one-second WAV. It fails like
 * the real one when a segment does not decode (`undecodable`), fails `failures` times on request, and with
 * `hold` waits until it is stopped.
 */
const stitched = vi.hoisted(() => ({
  calls: [] as { segments: Blob[]; format: string }[],
  failures: 0,
  hold: false,
}));
/** Blobs of this size stand for audio that sniffs as MP3 but will not decode. */
const UNDECODABLE_SIZE = 5;
vi.mock('../../core/media/stitch', async () => {
  const { encodeWav } = await import('../../core/media/wav');
  const { InvalidInputError } = await import('../../core/errors');
  return {
    stitchAudio: (segments: Blob[], format: string, options: { signal?: AbortSignal } = {}) => {
      stitched.calls.push({ segments, format });
      if (stitched.hold) {
        return new Promise((_, reject) => {
          options.signal?.addEventListener('abort', () =>
            reject(new DOMException('Stopped', 'AbortError')),
          );
        });
      }
      if (segments.some((segment) => segment.size === UNDECODABLE_SIZE)) {
        return Promise.reject(new InvalidInputError('This audio cannot be decoded.'));
      }
      if (stitched.failures > 0) {
        stitched.failures -= 1;
        return Promise.reject(new InvalidInputError('The encoder ran out of memory.'));
      }
      return Promise.resolve(encodeWav([new Float32Array(24000)], 24000));
    },
  };
});
vi.mock('../../core/media/audio', async (original) => {
  const { InvalidInputError } = await import('../../core/errors');
  return {
    ...(await original<typeof AudioModule>()),
    decodeAudio: (blob: Blob) =>
      blob.size === UNDECODABLE_SIZE
        ? Promise.reject(new InvalidInputError('This audio cannot be decoded.'))
        : Promise.resolve({ channels: [new Float32Array(10)], sampleRate: 8000, duration: 0.001 }),
  };
});
const announced = vi.hoisted(() => [] as string[]);
vi.mock('../../ui/feedback/announce', () => ({
  announce: (text: string) => announced.push(text),
}));

const KOKORO: RawModel = {
  id: 'hexgrad/kokoro-82m',
  name: 'Kokoro 82M',
  created: 1,
  context_length: 4096,
  architecture: { input_modalities: ['text'], output_modalities: ['speech'] },
  pricing: { prompt: '0.00000062', completion: '0' },
  supported_voices: ['af_alloy', 'af_heart', 'bm_george', 'zf_xiaobei'],
};
const FISH: RawModel = {
  id: 'fish-audio/s2.1-pro',
  name: 'Fish Audio',
  created: 1,
  context_length: 0,
  architecture: { input_modalities: ['text'], output_modalities: ['speech'] },
  pricing: { prompt: '0.000015', completion: '0' },
  supported_voices: null,
};
const GEMINI: RawModel = {
  id: 'google/gemini-3.8-flash-tts',
  name: 'Gemini TTS',
  created: 1,
  context_length: 32768,
  architecture: { input_modalities: ['text'], output_modalities: ['speech'] },
  pricing: { prompt: '0.0000005', completion: '0.000009' },
  supported_voices: ['Kore', 'Puck'],
};

const mp3Result = (): SpeechResult => ({
  blob: new Blob([new Uint8Array([0xff, 0xfb, 0x90, 0xc4])], { type: 'audio/mpeg' }),
  mimeType: 'audio/mpeg',
  sampleRate: null,
  channels: null,
  generationId: 'gen-tts-1',
});

const undecodableResult = (): SpeechResult => ({
  ...mp3Result(),
  blob: new Blob([new Uint8Array([0xff, 0xfb, 0x90, 0xc4, 0])], { type: 'audio/mpeg' }),
});

/** A tool context whose speech endpoint answers with `speech`, Kokoro priced at $4 per million characters. */
function context(
  speech: ApiClient['speech'],
  options: { modelOverride?: string; models?: () => Promise<RawModel[]> } = {},
) {
  const { models = () => Promise.resolve([KOKORO, GEMINI, FISH]), ...rest } = options;
  return createToolTestContext(getTool('text-to-speech'), {
    ...rest,
    api: {
      speech,
      catalog: {
        models,
        modelEndpoints: () =>
          Promise.resolve([
            { name: 'Together', provider_name: 'Together', pricing: { prompt: '0.000004' } },
          ]),
        imageModels: () => Promise.resolve([]),
        videoModels: () => Promise.resolve([]),
      },
    },
  });
}

const $ = (root: ParentNode, testId: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const $$ = (root: ParentNode, testId: string): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];

/** Text that splits into `parts` requests of about 900 characters. */
const longText = (parts: number): string =>
  Array.from({ length: parts }, (_, p) =>
    Array.from(
      { length: 15 },
      (_, s) => `Part ${p + 1}, sentence ${s + 1} is about sixty characters long.`,
    ).join(' '),
  ).join('\n\n');

let t: ToolTestContext | null = null;
beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
  stitched.calls.length = 0;
  stitched.failures = 0;
  stitched.hold = false;
  announced.length = 0;
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  // jsdom implements neither media playback nor canvas drawing (the waveform).
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLCanvasElement.prototype.getContext = () => null;
});
afterEach(async () => {
  await t?.cleanup();
  t = null;
});

describe('Text-to-speech tool', { timeout: 30_000 }, () => {
  it('round-trips its state and lists the model’s voices by name', async () => {
    t = context(vi.fn());
    const tool = await t.mount(setup);
    const voice = $(t.zones.input, 'tts-voice') as HTMLSelectElement;
    await vi.waitFor(() => expect(voice.options).toHaveLength(4));
    expect(voice.options[0]?.textContent).toBe('Alloy (American English, female)');
    const state = {
      prompt: 'Read this.',
      settings: { voice: 'bm_george', speed: 1.25, format: 'wav' },
    };
    tool.applyState(state);
    expect(tool.getState()).toEqual(state);
    expect(voice.value).toBe('bm_george');
    tool.applyState(tool.getState());
    expect(tool.getState()).toEqual(state);
    // Kokoro takes a speed; the slider is shown.
    expect($(t.zones.drawer, 'tts-speed-field')?.hidden).toBe(false);
  });

  it('estimates from the characters at the priciest endpoint', async () => {
    t = context(vi.fn());
    const tool = await t.mount(setup);
    tool.applyState({ prompt: 'x'.repeat(1000), settings: {} });
    await t.ctx.ui.refreshEstimate();
    expect(t.estimate()).toBeCloseTo(0.004, 6); // 1,000 characters at $4 per million
  });

  it('reads a long text in parts, joins them once and records a short summary', async () => {
    const speech = vi.fn<(body: SpeechRequest) => Promise<SpeechResult>>(() =>
      Promise.resolve(mp3Result()),
    );
    t = context(speech);
    const tool = await t.mount(setup);
    await vi.waitFor(() =>
      expect(($(t!.zones.input, 'tts-voice') as HTMLSelectElement).value).toBe('af_alloy'),
    );
    tool.applyState({
      prompt: longText(5),
      settings: { voice: 'af_heart', speed: 1, format: 'mp3' },
    });
    await t.runners[0]!.trigger();

    expect(speech).toHaveBeenCalledTimes(5);
    for (const [body] of speech.mock.calls) {
      expect(body).toMatchObject({
        model: 'hexgrad/kokoro-82m',
        voice: 'af_heart',
        response_format: 'mp3',
      });
      expect(body.input.length).toBeLessThanOrEqual(1000);
      expect(body).not.toHaveProperty('speed');
    }
    expect(speech.mock.calls.map(([body]) => /^Part (\d+),/.exec(body.input)?.[1])).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
    expect(stitched.calls).toHaveLength(1);
    expect(stitched.calls[0]).toMatchObject({ format: 'mp3' });
    expect(stitched.calls[0]!.segments).toHaveLength(5);

    expect($$(t.zones.output, 'tts-result')).toHaveLength(1);
    expect($(t.zones.output, 'tts-result-meta')?.textContent).toMatch(/^0:01 · Heart/);
    expect(t.core.results.pending()).toHaveLength(1);
    const [record] = await t.core.history.query({ tool: 'text-to-speech' });
    expect(record).toMatchObject({ status: 'ok', output: 'Generated 0:01 of audio, 5 parts' });
    expect(record?.settings).toEqual({ voice: 'af_heart', speed: 1, format: 'mp3' });
  });

  it('wraps raw PCM as WAV at the rate the response names', async () => {
    const pcm = (): SpeechResult => ({
      blob: new Blob([new Uint8Array(4800)], { type: 'audio/pcm' }),
      mimeType: 'audio/pcm',
      sampleRate: 24000,
      channels: 1,
      generationId: null,
    });
    const speech = vi.fn(() => Promise.resolve(pcm()));
    t = context(speech, { modelOverride: 'google/gemini-3.8-flash-tts' });
    const tool = await t.mount(setup);
    tool.applyState({ prompt: 'Hello there.', settings: { format: 'wav' } });
    await vi.waitFor(() =>
      expect(($(t!.zones.input, 'tts-voice') as HTMLSelectElement).value).toBe('Kore'),
    );
    await t.runners[0]!.trigger();
    expect((speech.mock.calls[0] as unknown[] | undefined)?.[0]).toMatchObject({
      response_format: 'pcm',
      voice: 'Kore',
    });
    const segment = stitched.calls[0]!.segments[0]!;
    const info = parseWav(new Uint8Array(await segment.arrayBuffer()));
    expect(info).toMatchObject({ sampleRate: 24000, channels: 1, dataBytes: 4800 });
    // Gemini has no speed setting.
    expect($(t.zones.drawer, 'tts-speed-field')?.hidden).toBe(true);
  });

  it('keeps the parts that worked and retries only the one that failed', async () => {
    let calls = 0;
    const speech = vi.fn((body: SpeechRequest) => {
      calls += 1;
      if (body.input.startsWith('Part 2,') && calls <= 3) {
        return Promise.reject(new ApiError('Provider error', 500, {}));
      }
      return Promise.resolve(mp3Result());
    });
    t = context(speech);
    const tool = await t.mount(setup);
    tool.applyState({ prompt: longText(3), settings: {} });
    await t.runners[0]!.trigger();

    expect(stitched.calls).toHaveLength(0);
    const notice = $(t.zones.output, 'tts-notice')!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain('2 of 3 parts made');
    expect($(notice, 'tts-failed')?.textContent).toContain('Part 2:');
    let [record] = await t.core.history.query({ tool: 'text-to-speech' });
    expect(record?.output).toBe('Made 2 of 3 parts; 1 failed.');

    // The form now says another voice; the retry finishes the parts with the voice they were made in.
    const voice = $(t.zones.input, 'tts-voice') as HTMLSelectElement;
    voice.value = 'bm_george';
    voice.dispatchEvent(new Event('change'));
    $(notice, 'tts-retry')!.click();
    await vi.waitFor(() => expect(stitched.calls).toHaveLength(1));
    expect(speech).toHaveBeenCalledTimes(4);
    expect(speech.mock.calls[3]?.[0]).toMatchObject({ voice: 'af_alloy' });
    expect(speech.mock.calls[3]?.[0].input).toMatch(/^Part 2,/);
    expect(stitched.calls[0]!.segments).toHaveLength(3);
    await vi.waitFor(() => expect($$(t!.zones.output, 'tts-result')).toHaveLength(1));
    expect($(t.zones.output, 'tts-notice')?.hidden).toBe(true);
    [record] = await t.core.history.query({ tool: 'text-to-speech' });
    expect(record).toMatchObject({
      title: 'Retry: 1 part of speech-part-1-sentence-1',
      prompt: '',
    });
    expect(record?.settings).toMatchObject({ voice: 'af_alloy' });
  });

  it('continues the parts already made when Read aloud is pressed again (or Retry replays it)', async () => {
    let fail = true;
    const speech = vi.fn((body: SpeechRequest) =>
      fail && body.input.startsWith('Part 2,')
        ? Promise.reject(new ApiError('Not enough credits', 402, {}))
        : Promise.resolve(mp3Result()),
    );
    t = context(speech);
    const tool = await t.mount(setup);
    tool.applyState({ prompt: longText(3), settings: { format: 'mp3' } });
    // A 402 is fatal: the batch stops and the runner offers Retry, which replays the same (empty) argument.
    await t.runners[0]!.trigger();
    expect(speech).toHaveBeenCalledTimes(3);
    expect($(t.zones.output, 'tts-notice')?.textContent).toContain('2 of 3 parts made');
    // The paid parts live only in this page: leaving asks first.
    expect(t.core.results.holds()).toEqual(['2 paid speech parts not joined yet']);

    fail = false;
    // Only the format changed: the parts are kept, joined into the new format.
    tool.applyState({
      ...tool.getState(),
      settings: { ...tool.getState().settings, format: 'wav' },
    });
    await t.runners[0]!.trigger();
    expect(speech).toHaveBeenCalledTimes(4);
    expect(speech.mock.calls[3]?.[0].input).toMatch(/^Part 2,/);
    expect(stitched.calls).toHaveLength(1);
    expect(stitched.calls[0]).toMatchObject({ format: 'wav' });
    const [record] = await t.core.history.query({ tool: 'text-to-speech' });
    expect(record).toMatchObject({ title: 'Continue: 1 part of speech-part-1-sentence-1' });
    // Joined: nothing is held any more (the take is a result of its own).
    expect(t.core.results.holds()).toEqual([]);

    // Complete: the next Read aloud is a new take, and changed text always starts again.
    tool.applyState({ ...tool.getState(), prompt: longText(2) });
    await t.runners[0]!.trigger();
    expect(speech).toHaveBeenCalledTimes(6);
  });

  it('keeps every part when the join fails, and joins again without making any twice', async () => {
    const speech = vi.fn(() => Promise.resolve(mp3Result()));
    t = context(speech);
    const tool = await t.mount(setup);
    tool.applyState({ prompt: longText(3), settings: {} });
    stitched.failures = 1;
    await t.runners[0]!.trigger();
    expect(speech).toHaveBeenCalledTimes(3);
    expect($$(t.zones.output, 'tts-result')).toHaveLength(0);
    const notice = $(t.zones.output, 'tts-notice')!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain('All 3 parts are made and kept.');
    expect(notice.textContent).toContain('The encoder ran out of memory.');
    expect(t.status()).toBe('Joining failed · every part kept');

    $(notice, 'tts-join')!.click();
    await vi.waitFor(() => expect($$(t!.zones.output, 'tts-result')).toHaveLength(1));
    expect(speech).toHaveBeenCalledTimes(3);
    expect(stitched.calls).toHaveLength(2);
    expect(notice.hidden).toBe(true);
  });

  it('keeps the parts when Stop lands during the join', async () => {
    const speech = vi.fn(() => Promise.resolve(mp3Result()));
    t = context(speech);
    const tool = await t.mount(setup);
    tool.applyState({ prompt: longText(2), settings: {} });
    stitched.hold = true;
    const running = t.runners[0]!.trigger();
    await vi.waitFor(() => expect(stitched.calls).toHaveLength(1));
    t.runners[0]!.stop();
    await running;
    expect(t.status()).toBe('Stopped while joining · all 2 parts kept');
    const notice = $(t.zones.output, 'tts-notice')!;
    expect(notice.textContent).toContain('Joining was stopped.');

    stitched.hold = false;
    // Read aloud with the same text joins what is there: nothing is made again.
    await t.runners[0]!.trigger();
    expect($$(t.zones.output, 'tts-result')).toHaveLength(1);
    expect(speech).toHaveBeenCalledTimes(2);
  });

  it('marks a part that comes back without audio as failed, and retries only that part', async () => {
    let calls = 0;
    const speech = vi.fn((body: SpeechRequest) => {
      calls += 1;
      if (body.input.startsWith('Part 2,') && calls <= 3) {
        return Promise.resolve({ ...mp3Result(), blob: new Blob([], { type: 'audio/mpeg' }) });
      }
      if (body.input.startsWith('Part 3,') && calls <= 3) {
        return Promise.resolve({
          ...mp3Result(),
          blob: new Blob(['{"error":"oops"}'], { type: 'audio/mpeg' }),
        });
      }
      return Promise.resolve(mp3Result());
    });
    t = context(speech);
    const tool = await t.mount(setup);
    tool.applyState({ prompt: longText(3), settings: {} });
    await t.runners[0]!.trigger();
    expect(stitched.calls).toHaveLength(0);
    const failed = $(t.zones.output, 'tts-failed')!.textContent;
    expect(failed).toContain('Part 2: The part came back empty.');
    expect(failed).toContain('Part 3: The part came back without audio.');
    $(t.zones.output, 'tts-retry')!.click();
    await vi.waitFor(() => expect($$(t!.zones.output, 'tts-result')).toHaveLength(1));
    expect(speech).toHaveBeenCalledTimes(5);
  });

  it('finds the part that will not decode when the join fails, and remakes only that one', async () => {
    let calls = 0;
    const speech = vi.fn((body: SpeechRequest) => {
      calls += 1;
      return Promise.resolve(
        body.input.startsWith('Part 2,') && calls <= 3 ? undecodableResult() : mp3Result(),
      );
    });
    t = context(speech);
    const tool = await t.mount(setup);
    tool.applyState({ prompt: longText(3), settings: {} });
    await t.runners[0]!.trigger();
    expect(t.status()).toBe('Joining failed: 1 part could not be decoded');
    expect($(t.zones.output, 'tts-failed')?.textContent).toBe(
      'Part 2: its audio could not be decoded',
    );
    $(t.zones.output, 'tts-retry')!.click();
    await vi.waitFor(() => expect($$(t!.zones.output, 'tts-result')).toHaveLength(1));
    expect(speech).toHaveBeenCalledTimes(4);
    expect(speech.mock.calls[3]?.[0].input).toMatch(/^Part 2,/);
  });

  it('waits for the catalog before reading, so a model with voices always gets one', async () => {
    let answer: (models: RawModel[]) => void = () => undefined;
    const models = new Promise<RawModel[]>((resolve) => (answer = resolve));
    const speech = vi.fn<(body: SpeechRequest) => Promise<SpeechResult>>(() =>
      Promise.resolve(mp3Result()),
    );
    t = context(speech, { models: () => models });
    const tool = await t.mount(setup);
    expect(($(t.zones.input, 'tts-voice') as HTMLSelectElement).disabled).toBe(true);
    tool.applyState({ prompt: 'Hello there.', settings: {} });
    const running = t.runners[0]!.trigger();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(speech).not.toHaveBeenCalled();
    answer([KOKORO, GEMINI, FISH]);
    await running;
    expect(speech.mock.calls[0]?.[0]).toMatchObject({ voice: 'af_alloy' });
  });

  it('leaves out a voice the new model does not list', async () => {
    t = context(vi.fn());
    const tool = await t.mount(setup);
    tool.applyState({ prompt: 'Hi.', settings: { voice: 'bm_george' } });
    await vi.waitFor(() => expect(tool.getState().settings['voice']).toBe('bm_george'));
    setToolBinding(t.ctx, 'text-to-speech', { model: 'fish-audio/s2.1-pro' });
    await vi.waitFor(() =>
      expect($(t!.zones.input, 'tts-voice')?.textContent).toBe("The model's own voice"),
    );
    expect(tool.getState().settings).not.toHaveProperty('voice');
  });

  it('makes a voice preview once and plays it from memory afterwards', async () => {
    const speech = vi.fn<(body: SpeechRequest) => Promise<SpeechResult>>(() =>
      Promise.resolve(mp3Result()),
    );
    t = context(speech);
    await t.mount(setup);
    const voice = $(t.zones.input, 'tts-voice') as HTMLSelectElement;
    await vi.waitFor(() => expect(voice.options).toHaveLength(4));
    const note = $(t.zones.input, 'tts-preview-note')!;
    await vi.waitFor(() => expect(note.textContent).toMatch(/about \$/));
    const button = $(t.zones.input, 'tts-preview') as HTMLButtonElement;

    button.click();
    await vi.waitFor(() => expect(note.textContent).toContain('plays from memory'));
    button.click();
    expect(speech).toHaveBeenCalledTimes(1);
    expect(($(t.zones.input, 'tts-preview-audio') as HTMLAudioElement).hidden).toBe(false);

    voice.value = 'bm_george';
    voice.dispatchEvent(new Event('change'));
    button.click();
    await vi.waitFor(() => expect(speech).toHaveBeenCalledTimes(2));
    expect(speech.mock.calls[1]?.[0]).toMatchObject({ voice: 'bm_george' });
    // Previews are runs of their own, but never Recent prompts.
    await vi.waitFor(async () =>
      expect(await t!.core.history.query({ tool: 'text-to-speech' })).toHaveLength(2),
    );
    expect(await t.core.prompts.list('text-to-speech', 'recent')).toEqual([]);
  });

  it('keeps focus on Preview while it works, says what happens, and reads in the voice’s language', async () => {
    let answer: (result: SpeechResult) => void = () => undefined;
    const speech = vi.fn<(body: SpeechRequest) => Promise<SpeechResult>>(
      () => new Promise((resolve) => (answer = resolve)),
    );
    t = context(speech);
    await t.mount(setup);
    const voice = $(t.zones.input, 'tts-voice') as HTMLSelectElement;
    await vi.waitFor(() => expect(voice.options).toHaveLength(4));
    voice.value = 'zf_xiaobei';
    voice.dispatchEvent(new Event('change'));
    const button = $(t.zones.input, 'tts-preview') as HTMLButtonElement;
    const note = $(t.zones.input, 'tts-preview-note')!;

    // Refused before anything is sent (here: a declined budget confirmation): nothing changes.
    await vi.waitFor(() => expect(note.textContent).toMatch(/\(about /));
    const before = note.textContent;
    const beginRun = vi.spyOn(t.ctx, 'beginRun').mockRejectedValueOnce(new RunCancelledError());
    button.focus();
    button.click();
    await vi.waitFor(() => expect(beginRun).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(note.textContent).toBe(before);
    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(speech).not.toHaveBeenCalled();

    button.click();
    await vi.waitFor(() => expect(speech).toHaveBeenCalledTimes(1));
    expect(speech.mock.calls[0]?.[0]).toMatchObject({
      voice: 'zf_xiaobei',
      input: '你好！这就是我朗读你的文字时的声音。',
    });
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(button);
    expect(note.textContent).toBe('Making the preview…');
    expect(announced).toContain('Making the preview…');
    button.click(); // ignored while busy
    expect(speech).toHaveBeenCalledTimes(1);

    answer(mp3Result());
    await vi.waitFor(() => expect(note.textContent).toContain('plays from memory'));
    expect(announced).toContain('The preview is ready.');
    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  it('announces a preview that fails', async () => {
    t = context(vi.fn(() => Promise.reject(new ApiError('Provider error', 500, {}))));
    await t.mount(setup);
    await vi.waitFor(() =>
      expect(($(t!.zones.input, 'tts-voice') as HTMLSelectElement).options).toHaveLength(4),
    );
    $(t.zones.input, 'tts-preview')!.click();
    await vi.waitFor(() => expect(announced).toContain('The preview could not be made.'));
  });

  it('reads dropped Markdown as plain text', async () => {
    t = context(vi.fn());
    const tool = await t.mount(setup);
    tool.onFiles?.([
      new File(['# Title\n\nSome **bold** words.'], 'notes.md', { type: 'text/markdown' }),
    ]);
    await vi.waitFor(() => expect(tool.getState().prompt).toBe('Title\n\nSome bold words.'));
    expect($(t.zones.input, 'tts-counts')?.textContent).toBe('23 characters · 4 words · 1 request');
  });
});
