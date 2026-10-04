import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawModel, TranscriptionRequest, TranscriptionResult } from '../../core/api/types';
import { RunCancelledError } from '../../core/errors';
import { encodeWav } from '../../core/media/wav';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import { createToolTestContext, type ToolTestContext } from '../../ui/tool/testing';
import { getTool } from '../registry';
import { setup } from './tool';

const model = (id: string, prompt: string): RawModel => ({
  id,
  name: id,
  created: 1,
  context_length: 0,
  architecture: { input_modalities: ['audio'], output_modalities: ['transcription'] },
  pricing: { prompt, completion: '0' },
  supported_parameters: [],
});
const WHISPER = model('openai/whisper-1', '0.0001');
const DEEPGRAM = model('deepgram/nova-3', '0.0000716666666667');

/** A WAV of `seconds` of silence at 8 kHz (its duration is read from the header). */
const wav = (seconds: number, name = 'talk.wav'): File =>
  new File([encodeWav([new Float32Array(Math.round(seconds * 8000))], 8000)], name, {
    type: 'audio/wav',
  });

const verbose = (patch: Partial<TranscriptionResult> = {}): TranscriptionResult => ({
  text: 'Hello there. General Kenobi.',
  language: 'en',
  duration: 4,
  segments: [
    { start: 0, end: 1.5, text: 'Hello there.' },
    { start: 2, end: 4, text: 'General Kenobi.' },
  ],
  words: [],
  usage: { seconds: 4, cost: 0.0004 },
  ...patch,
});

const $ = (root: ParentNode, testId: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const $$ = (root: ParentNode, testId: string): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];

let t: ToolTestContext | null = null;
beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  // jsdom draws no canvas and plays no media: keep the player quiet.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockReturnValue(undefined);
});
afterEach(() => {
  t?.cleanup();
  t = null;
});

async function mount(
  options: {
    modelOverride?: string;
    transcribe?: (b: TranscriptionRequest) => Promise<TranscriptionResult>;
  } = {},
) {
  const transcribe = vi.fn(options.transcribe ?? (() => Promise.resolve(verbose())));
  t = createToolTestContext(getTool('speech-to-text'), {
    catalog: [WHISPER, DEEPGRAM],
    modelOverride: options.modelOverride ?? 'openai/whisper-1',
    api: {
      transcribe: (body, opts) => {
        opts.run.addUsage({
          model: body.model,
          promptTokens: 0,
          completionTokens: 0,
          costUsd: 0.0004,
          costEstimated: false,
          latencyMs: 5,
        });
        return transcribe(body);
      },
    },
  });
  const tool = await t.mount(setup);
  return { tool, transcribe, t };
}

async function addFile(tool: Awaited<ReturnType<typeof mount>>['tool'], file: File): Promise<void> {
  tool.onFiles?.([file]);
  await vi.waitFor(() => expect($(t!.zones.input, 'stt-source-name')?.textContent).toBe(file.name));
}

describe('Speech-to-text tool', { timeout: 30_000 }, () => {
  it('round-trips its state, keeping choices the model cannot honour', async () => {
    const { tool } = await mount();
    const state = {
      prompt: 'Kubernetes, ORtoolbox',
      settings: { language: 'de', timestamps: false, diarize: true, partMinutes: 2 },
    };
    tool.applyState(state);
    expect(tool.getState()).toEqual(state);
    // Whisper has no speaker labels: the switch shows off and disabled, the choice stays.
    const diarize = $(t!.zones.drawer, 'stt-diarize') as HTMLInputElement;
    expect(diarize.disabled).toBe(true);
    expect(diarize.checked).toBe(false);
    tool.applyState(tool.getState());
    expect(tool.getState()).toEqual(state);
    tool.applyState({ prompt: '', settings: { language: 'xx', partMinutes: 7 } });
    expect(tool.getState().settings).toMatchObject({ language: 'de', partMinutes: 2 });
  });

  it('shows duration, size and the plan, and estimates from the duration', async () => {
    const { tool } = await mount();
    await addFile(tool, wav(10));
    expect($(t!.zones.input, 'stt-source-meta')?.textContent).toBe('0:10 · 156.3 KB');
    expect($(t!.zones.input, 'stt-source-plan')?.textContent).toBe(
      'Sent as it is, in one request.',
    );
    await vi.waitFor(() => expect(t!.estimate()).toBeCloseTo((10 + 1) * 0.0001));
    // Longer than a part: decoded and cut, one extra second per part for rounding.
    tool.applyState({ prompt: '', settings: { partMinutes: 1 } });
    await addFile(tool, wav(150, 'long.wav'));
    expect($(t!.zones.input, 'stt-source-plan')?.textContent).toBe(
      'Decoded and cut at pauses into about 3 parts of up to 1:00.',
    );
    await vi.waitFor(() => expect(t!.estimate()).toBeCloseTo((150 + 3) * 0.0001));
  });

  it('transcribes a short file as it is, draws the segments and keeps the text in History', async () => {
    const { tool, transcribe } = await mount();
    tool.applyState({ prompt: 'Kenobi', settings: { language: 'en' } });
    await addFile(tool, wav(4));
    await t!.runners[0]!.trigger();

    expect(transcribe).toHaveBeenCalledTimes(1);
    const body = transcribe.mock.calls[0]![0];
    expect(body).toMatchObject({
      model: 'openai/whisper-1',
      format: 'wav',
      language: 'en',
      timestamps: true,
      diarize: false,
    });
    // Whisper takes no vocabulary list: it is not sent.
    expect(body.keyterms).toBeUndefined();
    expect($(t!.zones.input, 'stt-vocabulary-note')?.textContent).toContain('not sent');

    const segments = $$(t!.zones.output, 'stt-segment');
    expect(segments.map((item) => item.querySelector('textarea')?.value)).toEqual([
      'Hello there.',
      'General Kenobi.',
    ]);
    expect($$(t!.zones.output, 'stt-seek').map((button) => button.textContent)).toEqual([
      '0:00',
      '0:02',
    ]);
    expect($(t!.zones.output, 'stt-parts')?.hidden).toBe(true);
    expect(($(t!.zones.output, 'stt-copy') as HTMLButtonElement).disabled).toBe(false);
    expect(t!.status()).toBe('Done · 2 segments');

    // An edit changes the text everywhere it is read (exports, Send to).
    const box = segments[1]!.querySelector('textarea')!;
    box.value = 'General Kenobi!';
    box.dispatchEvent(new Event('input'));
    ($(t!.zones.output, 'stt-send') as HTMLButtonElement).click();
    expect(t!.sent[0]).toEqual([
      {
        kind: 'text',
        text: 'Hello there. General Kenobi!',
        type: 'text/plain',
        name: 'talk-transcript.txt',
      },
    ]);

    const history = await t!.core.history.query({ tool: 'speech-to-text' });
    expect(history[0]).toMatchObject({
      status: 'ok',
      title: 'talk.wav',
      output: 'Hello there. General Kenobi.',
      meta: { parts: 1, failedParts: [], language: 'en', speakers: 0 },
      settings: { language: 'en', timestamps: true, diarize: false, partMinutes: 5 },
    });
  });

  it('asks a supporting model for speaker labels and key terms; names apply everywhere', async () => {
    const { tool, transcribe } = await mount({
      modelOverride: 'deepgram/nova-3',
      transcribe: () =>
        Promise.resolve(
          verbose({
            segments: [
              { start: 0, end: 1.5, text: 'Hello there.', speaker: '0' },
              { start: 2, end: 4, text: 'General Kenobi.', speaker: '1' },
            ],
          }),
        ),
    });
    tool.applyState({ prompt: 'Kenobi, Grievous', settings: { diarize: true } });
    expect(($(t!.zones.drawer, 'stt-diarize') as HTMLInputElement).checked).toBe(true);
    await addFile(tool, wav(4));
    await t!.runners[0]!.trigger();
    expect(transcribe.mock.calls[0]![0]).toMatchObject({
      model: 'deepgram/nova-3',
      diarize: true,
      keyterms: ['Kenobi', 'Grievous'],
    });

    const badges = () => $$(t!.zones.output, 'stt-segment-speaker').map((b) => b.textContent);
    expect(badges()).toEqual(['Speaker 1', 'Speaker 2']);
    const names = $$(t!.zones.output, 'stt-speaker-name') as HTMLInputElement[];
    expect(names).toHaveLength(2);
    names[1]!.value = 'Grievous';
    names[1]!.dispatchEvent(new Event('input'));
    expect(badges()).toEqual(['Speaker 1', 'Grievous']);
    ($(t!.zones.output, 'stt-view-text') as HTMLButtonElement).click();
    expect($(t!.zones.output, 'stt-text')?.textContent).toBe(
      'Speaker 1: Hello there.\n\nGrievous: General Kenobi.',
    );
    // One part: no per-part note.
    expect($(t!.zones.output, 'stt-speakers')?.textContent).not.toContain('parts');
  });

  it('filters segments by a search', async () => {
    const { tool } = await mount();
    await addFile(tool, wav(4));
    await t!.runners[0]!.trigger();
    const search = $(t!.zones.output, 'stt-search') as HTMLInputElement;
    search.value = 'kenobi';
    search.dispatchEvent(new Event('input'));
    await vi.waitFor(() =>
      expect($(t!.zones.output, 'stt-search-count')?.textContent).toBe('1 of 2 segments'),
    );
    expect($$(t!.zones.output, 'stt-segment').map((item) => item.hidden)).toEqual([true, false]);
  });

  it('a refused run leaves the transcript as it was', async () => {
    const { tool, transcribe } = await mount();
    await addFile(tool, wav(4));
    await t!.runners[0]!.trigger();
    const before = $(t!.zones.output, 'stt-segments')?.textContent;
    // A declined budget confirmation.
    t!.ctx.beginRun = vi.fn().mockRejectedValueOnce(new RunCancelledError());
    await t!.runners[0]!.trigger();
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect($(t!.zones.output, 'stt-segments')?.textContent).toBe(before);
    expect(await t!.core.history.query({ tool: 'speech-to-text' })).toHaveLength(1);
  });

  it('says what is missing when there is nothing to transcribe', async () => {
    const { transcribe } = await mount();
    await t!.runners[0]!.trigger();
    expect(transcribe).not.toHaveBeenCalled();
    expect(t!.status()).toBe('Record or add a recording first.');
  });
});
