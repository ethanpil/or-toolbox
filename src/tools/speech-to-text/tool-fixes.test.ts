/**
 * Stage 8 fixes for Speech-to-text: a part that may have been billed is never retried without asking (M1), a
 * replayed run pays for no finished part again (M2), an edited transcript is asked about and held before it is
 * replaced and never wiped before the new run can fail (M4), an unknown-length recording is checked against the
 * budget with its real length (M6), and a retry transcribes with the options of the run it belongs to.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawModel, TranscriptionRequest, TranscriptionResult } from '../../core/api/types';
import { ApiError } from '../../core/errors';
import type * as AudioModule from '../../core/media/audio';
import type * as Dialogs from '../../ui/feedback/dialogs';
import { type AudioData, planChunks } from '../../core/media/audio';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import { createToolTestContext, type ToolTestContext } from '../../ui/tool/testing';
import { getTool } from '../registry';
import { setup } from './tool';

const hoisted = vi.hoisted(() => ({
  confirm: vi.fn<(options: unknown) => Promise<boolean>>(() => Promise.resolve(true)),
}));
vi.mock('../../ui/feedback/dialogs', async (importOriginal) => ({
  ...(await importOriginal<typeof Dialogs>()),
  confirmDialog: hoisted.confirm,
}));

const RATE = 16000;
const SECONDS = 150;
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
const audio = await import('../../core/media/audio');

const sttModel = (id: string): RawModel => ({
  id,
  name: id,
  created: 1,
  context_length: 0,
  architecture: { input_modalities: ['audio'], output_modalities: ['transcription'] },
  pricing: { prompt: '0.0001', completion: '0' },
  supported_parameters: [],
});
const CATALOG = ['openai/whisper-1', 'deepgram/nova-3', 'microsoft/mai-transcribe-1.5'].map(
  sttModel,
);
const PLAN = planChunks(synth(), { maxSeconds: 59 }).map(({ start, end }): [number, number] => [
  start / RATE,
  end / RATE,
]);

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

/** What the API client throws for a paid request that may have gone through. */
const unknownOutcome = (): ApiError =>
  Object.assign(new ApiError('Provider returned error', 502), { outcomeUnknown: true });

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
  hoisted.confirm.mockReset();
  hoisted.confirm.mockImplementation(() => Promise.resolve(true));
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockReturnValue(undefined);
});
afterEach(async () => {
  await t?.cleanup();
  t = null;
  document.querySelectorAll('[data-testid="toasts"] > *').forEach((node) => node.remove());
});

async function mount(
  transcribe: (body: TranscriptionRequest) => Promise<TranscriptionResult>,
  { unknownLength = false }: { unknownLength?: boolean } = {},
) {
  const calls: TranscriptionRequest[] = [];
  t = createToolTestContext(getTool('speech-to-text'), {
    catalog: CATALOG,
    api: {
      transcribe: (body) => {
        calls.push(body);
        return transcribe(body);
      },
    },
  });
  const tool = await t.mount(setup);
  t.core.settings.update((draft) => {
    draft.tools['speech-to-text'] = { ...draft.tools['speech-to-text'], model: 'openai/whisper-1' };
  });
  await t.ctx.ui.refreshEstimate();
  tool.applyState({ prompt: '', settings: { partMinutes: 1 } });
  if (unknownLength)
    vi.mocked(audio.getAudioDuration).mockRejectedValueOnce(new Error('unreadable'));
  tool.onFiles?.([new File(['not decoded here'], 'long.mp3', { type: 'audio/mpeg' })]);
  await vi.waitFor(() =>
    expect($(t!.zones.input, 'stt-source-name')?.textContent).toBe('long.mp3'),
  );
  return { tool, calls };
}

const statuses = (): (string | undefined)[] =>
  $$(t!.zones.output, 'stt-part').map((item) => item.dataset['status']);
const texts = (): string[] =>
  $$(t!.zones.output, 'stt-segment-text').map((box) => (box as HTMLTextAreaElement).value);
const edit = (index: number, value: string): void => {
  const box = $$(t!.zones.output, 'stt-segment-text')[index] as HTMLTextAreaElement;
  box.value = value;
  box.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('Speech-to-text fixes', { timeout: 30_000 }, () => {
  it('M1: a part that may have been billed says so and asks before it is sent again', async () => {
    let failSecond = true;
    const { calls } = await mount((body) => {
      if (partOf(body) === 1 && failSecond) {
        failSecond = false;
        return Promise.reject(unknownOutcome());
      }
      return Promise.resolve(partResult(partOf(body)));
    });
    await t!.runners[0]!.trigger();
    expect(statuses()).toEqual(['done', 'failed', 'done']);
    expect($(t!.zones.output, 'stt-part-error')?.textContent).toContain(
      'check your OpenRouter activity',
    );
    expect($(t!.zones.output, 'stt-part-error-activity')).not.toBeNull();

    hoisted.confirm.mockImplementation(() => Promise.resolve(false));
    $(t!.zones.output, 'stt-part-retry')!.click();
    await vi.waitFor(() => expect(hoisted.confirm).toHaveBeenCalledTimes(1));
    expect(hoisted.confirm.mock.calls[0]![0]).toMatchObject({ title: 'Retry anyway?' });
    expect(calls).toHaveLength(3);

    // The notice's "Retry" asks too; accepting sends the part again.
    hoisted.confirm.mockImplementation(() => Promise.resolve(true));
    $(t!.zones.output, 'stt-retry-failed')!.click();
    await vi.waitFor(() => expect(calls.map(partOf)).toEqual([0, 1, 2, 1]));
    expect(hoisted.confirm).toHaveBeenCalledTimes(2);
  });

  it('M1: a part that plainly failed is retried without a question', async () => {
    let fail = true;
    const { calls } = await mount((body) => {
      if (partOf(body) === 1 && fail) {
        fail = false;
        return Promise.reject(new ApiError('Provider returned error', 400));
      }
      return Promise.resolve(partResult(partOf(body)));
    });
    await t!.runners[0]!.trigger();
    $(t!.zones.output, 'stt-part-retry')!.click();
    await vi.waitFor(() => expect(calls.map(partOf)).toEqual([0, 1, 2, 1]));
    expect(hoisted.confirm).not.toHaveBeenCalled();
  });

  it('M2: the error toast’s Retry sends only the parts without a result', async () => {
    let paymentFailed = false;
    const { calls } = await mount((body) => {
      const n = partOf(body);
      if (n === 1 && !paymentFailed) {
        paymentFailed = true;
        // Part 0 is made first; part 1 then hits a fatal error while part 2 is on its way.
        return new Promise((_, reject) =>
          setTimeout(() => reject(new ApiError('Payment required', 402)), 20),
        );
      }
      if (n === 2) return new Promise((resolve) => setTimeout(() => resolve(partResult(2)), 60));
      return Promise.resolve(partResult(n));
    });
    await t!.runners[0]!.trigger();
    expect(statuses()).toEqual(['done', 'failed', 'done']);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="toast-retry"]')).not.toBeNull(),
    );
    document.querySelector<HTMLButtonElement>('[data-testid="toast-retry"]')!.click();
    await vi.waitFor(() => expect(statuses()).toEqual(['done', 'done', 'done']));
    expect(calls.map(partOf)).toEqual([0, 1, 2, 1]);
  });

  it('M4: transcribing again asks before replacing an edited transcript, and holds it meanwhile', async () => {
    const { calls } = await mount((body) => Promise.resolve(partResult(partOf(body))));
    await t!.runners[0]!.trigger();
    expect(t!.core.results.holds()).toEqual([]);
    edit(0, 'My own words.');
    expect(t!.core.results.holds()).toEqual(['Your edited transcript']);

    hoisted.confirm.mockImplementation(() => Promise.resolve(false));
    await t!.runners[0]!.trigger();
    expect(hoisted.confirm).toHaveBeenCalledTimes(1);
    expect(hoisted.confirm.mock.calls[0]![0]).toMatchObject({
      message: expect.stringContaining('your edited transcript') as unknown,
    });
    expect(calls).toHaveLength(3);
    expect(texts()[0]).toBe('My own words.');
    expect(await t!.core.history.query({ tool: 'speech-to-text' })).toHaveLength(1);

    hoisted.confirm.mockImplementation(() => Promise.resolve(true));
    await t!.runners[0]!.trigger();
    expect(calls).toHaveLength(6);
    expect(texts()[0]).toBe('Burst 1.');
    expect(t!.core.results.holds()).toEqual([]);
  });

  it('M4: nothing is asked when nothing was edited', async () => {
    const { calls } = await mount((body) => Promise.resolve(partResult(partOf(body))));
    await t!.runners[0]!.trigger();
    await t!.runners[0]!.trigger();
    expect(hoisted.confirm).not.toHaveBeenCalled();
    expect(calls).toHaveLength(6);
  });

  it('M4: a recording that cannot be decoded leaves the edited transcript where it was', async () => {
    const { tool, calls } = await mount((body) => Promise.resolve(partResult(partOf(body))));
    await t!.runners[0]!.trigger();
    edit(0, 'My own words.');
    // Another part length: the audio must be cut again, and that fails.
    tool.applyState({ prompt: '', settings: { partMinutes: 2 } });
    vi.mocked(audio.decodeAudio).mockRejectedValueOnce(new Error('cannot decode'));
    await t!.runners[0]!.trigger();
    expect(calls).toHaveLength(3);
    expect(texts()[0]).toBe('My own words.');
    expect(statuses()).toEqual(['done', 'done', 'done']);
    const runs = await t!.core.history.query({ tool: 'speech-to-text' });
    expect(runs[0]?.status).toBe('error');
  });

  it('M6: a recording of unknown length is checked against the budget with its real length', async () => {
    const { calls } = await mount((body) => Promise.resolve(partResult(partOf(body))), {
      unknownLength: true,
    });
    expect($(t!.zones.input, 'stt-source-meta')?.textContent).toContain('Length unknown');
    t!.core.settings.update((draft) => {
      draft.budgets = { ...draft.budgets, mode: 'warn', perRunUsd: 0.01 };
    });
    const confirm = vi.fn().mockResolvedValue(true);
    t!.core.runs.setConfirmHandler(confirm);
    await t!.runners[0]!.trigger();
    expect(confirm).toHaveBeenCalledOnce();
    const question = confirm.mock.calls[0]![1] as { spec: { estimateUsd: number | null } };
    expect(question.spec.estimateUsd).toBeCloseTo((150 + 3) * 0.0001);
    expect(calls).toHaveLength(3);
  });

  it('M6: declining that question sends nothing and changes nothing', async () => {
    const { calls } = await mount((body) => Promise.resolve(partResult(partOf(body))), {
      unknownLength: true,
    });
    t!.core.settings.update((draft) => {
      draft.budgets = { ...draft.budgets, mode: 'warn', perRunUsd: 0.01 };
    });
    t!.core.runs.setConfirmHandler(() => Promise.resolve(false));
    await t!.runners[0]!.trigger();
    expect(calls).toHaveLength(0);
    expect($$(t!.zones.output, 'stt-part')).toHaveLength(0);
  });

  it('a retry uses the options of the run it belongs to, not the form as it is now', async () => {
    let fail = true;
    const { tool, calls } = await mount((body) => {
      if (partOf(body) === 1 && fail) {
        fail = false;
        return Promise.reject(new ApiError('Provider returned error', 400));
      }
      return Promise.resolve(partResult(partOf(body)));
    });
    tool.applyState({ prompt: '', settings: { partMinutes: 1, language: 'de', timestamps: true } });
    await t!.runners[0]!.trigger();
    expect(calls[0]).toMatchObject({ language: 'de' });
    // Changed afterwards: the transcript's other parts were made in German with timestamps.
    tool.applyState({
      prompt: '',
      settings: { partMinutes: 1, language: 'fr', timestamps: false },
    });
    $(t!.zones.output, 'stt-part-retry')!.click();
    await vi.waitFor(() => expect(calls.map(partOf)).toEqual([0, 1, 2, 1]));
    expect(calls[3]).toMatchObject({ language: 'de', timestamps: true });
  });

  it('the speaker-label note for a model without timestamps says why, not that the model is unsupported', async () => {
    await mount(() => Promise.resolve(partResult(0)));
    const note = () => $(t!.zones.drawer, 'stt-diarize-note')?.textContent ?? '';
    expect(note()).toContain('that return timestamps');
    t!.core.settings.update((draft) => {
      draft.tools['speech-to-text'] = {
        ...draft.tools['speech-to-text'],
        model: 'microsoft/mai-transcribe-1.5',
      };
    });
    await t!.ctx.ui.refreshEstimate();
    expect(note()).toBe(
      'Speaker labels need timestamps, and this model returns text without them. Choose another model to turn them on.',
    );
  });
});
