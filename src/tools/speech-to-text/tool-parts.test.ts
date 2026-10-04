/**
 * The long-recording path of the tool: decoded audio (mocked: jsdom has no Web Audio) cut at pauses into parts,
 * transcribed two at a time, merged onto one timeline; a failed part retried alone; Stop.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawModel, TranscriptionRequest, TranscriptionResult } from '../../core/api/types';
import { ApiError } from '../../core/errors';
import type * as AudioModule from '../../core/media/audio';
import { type AudioData, planChunks } from '../../core/media/audio';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import { createToolTestContext, type ToolTestContext } from '../../ui/tool/testing';
import { getTool } from '../registry';
import { setup } from './tool';

const RATE = 16000;
const SECONDS = 150;
/** 8 s of tone, 2 s of silence, repeated: tone bursts start every 10 s. */
function synth(): AudioData {
  const samples = new Float32Array(SECONDS * RATE);
  for (let i = 0; i < samples.length; i++) {
    if ((i / RATE) % 10 < 8) samples[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / RATE);
  }
  return { sampleRate: RATE, channels: [samples] };
}

vi.mock('../../core/media/audio', async (importOriginal) => {
  const real = await importOriginal<typeof AudioModule>();
  return {
    ...real,
    decodeAudio: vi.fn(() => Promise.resolve(synth())),
    getAudioDuration: vi.fn(() => Promise.resolve(SECONDS)),
  };
});

const WHISPER: RawModel = {
  id: 'openai/whisper-1',
  name: 'Whisper',
  created: 1,
  context_length: 0,
  architecture: { input_modalities: ['audio'], output_modalities: ['transcription'] },
  pricing: { prompt: '0.0001', completion: '0' },
  supported_parameters: [],
};

/** Where the tool will cut (the same planner on the same audio), as [start, end] seconds per part. */
const PLAN = planChunks(synth(), { maxSeconds: 59 }).map(({ start, end }): [number, number] => [
  start / RATE,
  end / RATE,
]);

/** What a model would hear in part `n`: the bursts inside it, timed from the part's own start. */
function partResult(n: number): TranscriptionResult {
  const [from, to] = PLAN[n]!;
  const segments = [];
  for (let burst = 0; burst < SECONDS; burst += 10) {
    if (burst >= from && burst < to) {
      segments.push({
        start: burst - from,
        end: burst + 8 - from,
        text: `Burst ${burst / 10 + 1}.`,
      });
    }
  }
  return {
    text: segments.map((s) => s.text).join(' '),
    language: 'en',
    duration: to - from,
    segments,
    words: [],
    usage: null,
  };
}

const partOf = (body: TranscriptionRequest): number =>
  Number(/^part-(\d+)\.wav$/.exec(body.filename ?? '')?.[1]) - 1;

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
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockReturnValue(undefined);
});
afterEach(() => {
  t?.cleanup();
  t = null;
});

async function mount(
  transcribe: (body: TranscriptionRequest, signal: AbortSignal) => Promise<TranscriptionResult>,
) {
  const calls: TranscriptionRequest[] = [];
  t = createToolTestContext(getTool('speech-to-text'), {
    catalog: [WHISPER],
    modelOverride: 'openai/whisper-1',
    api: {
      transcribe: (body, opts) => {
        calls.push(body);
        return transcribe(body, opts.signal ?? opts.run.signal);
      },
    },
  });
  const tool = await t.mount(setup);
  tool.applyState({ prompt: '', settings: { partMinutes: 1 } });
  tool.onFiles?.([new File(['not decoded here'], 'long.mp3', { type: 'audio/mpeg' })]);
  await vi.waitFor(() =>
    expect($(t!.zones.input, 'stt-source-name')?.textContent).toBe('long.mp3'),
  );
  return { tool, calls };
}

const statuses = (): (string | undefined)[] =>
  $$(t!.zones.output, 'stt-part').map((item) => item.dataset['status']);
const starts = (): number[] =>
  $$(t!.zones.output, 'stt-segment').map((item) => Number(item.dataset['start']));

describe('Speech-to-text, long recordings', { timeout: 30_000 }, () => {
  it('plans three parts cut in pauses', () => {
    expect(PLAN).toHaveLength(3);
    // Every cut falls in a silence (8-10 s into a 10 s period).
    for (const [, end] of PLAN.slice(0, -1)) expect(end % 10).toBeGreaterThanOrEqual(8);
  });

  it('merges the parts onto one timeline; a failed part is retried alone', async () => {
    let failSecond = true;
    const { calls } = await mount((body) => {
      const n = partOf(body);
      if (n === 1 && failSecond) {
        failSecond = false;
        return Promise.reject(new ApiError('Provider returned error', 502));
      }
      return Promise.resolve(partResult(n));
    });
    await t!.runners[0]!.trigger();

    expect(calls.map((body) => [partOf(body), body.format])).toEqual([
      [0, 'wav'],
      [1, 'wav'],
      [2, 'wav'],
    ]);
    expect(statuses()).toEqual(['done', 'failed', 'done']);
    expect($(t!.zones.output, 'stt-failed')?.hidden).toBe(false);
    expect(t!.status()).toBe('Done · 2 of 3 parts; 1 failed');
    const inPart = (n: number) =>
      Array.from({ length: 15 }, (_, i) => i * 10).filter(
        (s) => s >= PLAN[n]![0] && s < PLAN[n]![1],
      );
    expect(starts()).toEqual([...inPart(0), ...inPart(2)]);

    $(t!.zones.output, 'stt-part-retry')!.click();
    await vi.waitFor(async () =>
      expect(await t!.core.history.query({ tool: 'speech-to-text' })).toHaveLength(2),
    );
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));
    expect(calls.map(partOf)).toEqual([0, 1, 2, 1]);
    expect(statuses()).toEqual(['done', 'done', 'done']);
    // Continuous: every burst at its place in the recording, in order, none twice.
    expect(starts()).toEqual(Array.from({ length: 15 }, (_, i) => i * 10));
    const runs = await t!.core.history.query({ tool: 'speech-to-text' });
    expect(runs[0]).toMatchObject({ title: 'Retry: long.mp3', status: 'ok' });
    expect(runs[0]?.output).toContain('Burst 15.');
    expect(runs[1]).toMatchObject({ title: 'long.mp3', meta: { parts: 3, failedParts: [2] } });
  });

  it('Stop ends the parts in flight and keeps what arrived', async () => {
    const { calls } = await mount((body, signal) => {
      const n = partOf(body);
      if (n === 0) return Promise.resolve(partResult(0));
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason as Error));
      });
    });
    const running = t!.runners[0]!.trigger();
    await vi.waitFor(() => expect(statuses()).toEqual(['done', 'running', 'running']));
    t!.runners[0]!.stop();
    await running;
    expect(calls).toHaveLength(3);
    expect(statuses()).toEqual(['done', 'stopped', 'stopped']);
    expect(t!.status()).toBe('Stopped');
    expect(starts()).toEqual([0, 10, 20, 30, 40, 50]);
    expect((await t!.core.history.query({ tool: 'speech-to-text' }))[0]?.status).toBe('aborted');
  });
});
