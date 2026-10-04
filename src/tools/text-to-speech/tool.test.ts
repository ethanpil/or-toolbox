import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawModel, SpeechRequest, SpeechResult } from '../../core/api/types';
import { ApiError } from '../../core/errors';
import { parseWav } from '../../core/media/wav';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import type { ApiClient } from '../../core/types';
import { createToolTestContext, type ToolTestContext } from '../../ui/tool/testing';
import { getTool } from '../registry';
import { setup } from './tool';

/** stitchAudio needs Web Audio; here it records what it was given and returns a one-second WAV. */
const stitched = vi.hoisted(() => ({ calls: [] as { segments: Blob[]; format: string }[] }));
vi.mock('../../core/media/stitch', async () => {
  const { encodeWav } = await import('../../core/media/wav');
  return {
    stitchAudio: (segments: Blob[], format: string) => {
      stitched.calls.push({ segments, format });
      return Promise.resolve(encodeWav([new Float32Array(24000)], 24000));
    },
  };
});

const KOKORO: RawModel = {
  id: 'hexgrad/kokoro-82m',
  name: 'Kokoro 82M',
  created: 1,
  context_length: 4096,
  architecture: { input_modalities: ['text'], output_modalities: ['speech'] },
  pricing: { prompt: '0.00000062', completion: '0' },
  supported_voices: ['af_alloy', 'af_heart', 'bm_george'],
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

/** A tool context whose speech endpoint answers with `speech`, Kokoro priced at $4 per million characters. */
function context(speech: ApiClient['speech'], options: { modelOverride?: string } = {}) {
  return createToolTestContext(getTool('text-to-speech'), {
    ...options,
    api: {
      speech,
      catalog: {
        models: () => Promise.resolve([KOKORO, GEMINI]),
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
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  // jsdom implements neither media playback nor canvas drawing (the waveform).
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLCanvasElement.prototype.getContext = () => null;
});
afterEach(() => {
  t?.cleanup();
  t = null;
});

describe('Text-to-speech tool', { timeout: 30_000 }, () => {
  it('round-trips its state and lists the model’s voices by name', async () => {
    t = context(vi.fn());
    const tool = await t.mount(setup);
    const voice = $(t.zones.input, 'tts-voice') as HTMLSelectElement;
    await vi.waitFor(() => expect(voice.options).toHaveLength(3));
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

    $(notice, 'tts-retry')!.click();
    await vi.waitFor(() => expect(stitched.calls).toHaveLength(1));
    expect(speech).toHaveBeenCalledTimes(4);
    expect(speech.mock.calls[3]?.[0].input).toMatch(/^Part 2,/);
    expect(stitched.calls[0]!.segments).toHaveLength(3);
    await vi.waitFor(() => expect($$(t!.zones.output, 'tts-result')).toHaveLength(1));
    expect($(t.zones.output, 'tts-notice')?.hidden).toBe(true);
    [record] = await t.core.history.query({ tool: 'text-to-speech' });
    expect(record).toMatchObject({
      title: 'Retry: 1 part of speech-part-1-sentence-1',
      prompt: '',
    });
  });

  it('makes a voice preview once and plays it from memory afterwards', async () => {
    const speech = vi.fn<(body: SpeechRequest) => Promise<SpeechResult>>(() =>
      Promise.resolve(mp3Result()),
    );
    t = context(speech);
    await t.mount(setup);
    const voice = $(t.zones.input, 'tts-voice') as HTMLSelectElement;
    await vi.waitFor(() => expect(voice.options).toHaveLength(3));
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
