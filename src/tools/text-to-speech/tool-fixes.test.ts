/**
 * Stage 8 fixes for Text-to-speech: paid parts that are not joined are never dropped without a question and
 * unchanged ones are reused (M3), a part that may have been billed asks before it is made again (M1), and the
 * join follows the format chosen now, also on a retry.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawModel, SpeechRequest, SpeechResult } from '../../core/api/types';
import { ApiError } from '../../core/errors';
import type * as AudioModule from '../../core/media/audio';
import { encodeWav } from '../../core/media/wav';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import type { ApiClient } from '../../core/types';
import type * as Dialogs from '../../ui/feedback/dialogs';
import { createToolTestContext, type ToolTestContext } from '../../ui/tool/testing';
import { getTool } from '../registry';
import { setup } from './tool';

const hoisted = vi.hoisted(() => ({
  confirm: vi.fn<(options: unknown) => Promise<boolean>>(() => Promise.resolve(true)),
  stitched: [] as { segments: Blob[]; format: string }[],
}));
vi.mock('../../ui/feedback/dialogs', async (importOriginal) => ({
  ...(await importOriginal<typeof Dialogs>()),
  confirmDialog: hoisted.confirm,
}));
vi.mock('../../core/media/stitch', () => ({
  stitchAudio: (segments: Blob[], format: string) => {
    hoisted.stitched.push({ segments, format });
    return Promise.resolve(encodeWav([new Float32Array(24000)], 24000));
  },
}));
vi.mock('../../core/media/audio', async (original) => ({
  ...(await original<typeof AudioModule>()),
  decodeAudio: () =>
    Promise.resolve({ channels: [new Float32Array(10)], sampleRate: 8000, duration: 0.001 }),
}));

const KOKORO: RawModel = {
  id: 'hexgrad/kokoro-82m',
  name: 'Kokoro 82M',
  created: 1,
  context_length: 4096,
  architecture: { input_modalities: ['text'], output_modalities: ['speech'] },
  pricing: { prompt: '0.00000062', completion: '0' },
  supported_voices: ['af_alloy', 'af_heart', 'bm_george'],
};

/** Distinct bytes per request, so a reused part can be told from a remade one. */
let counter = 0;
const mp3Result = (): SpeechResult => ({
  blob: new Blob([new Uint8Array([0xff, 0xfb, 0x90, 0xc4, ++counter])], { type: 'audio/mpeg' }),
  mimeType: 'audio/mpeg',
  sampleRate: null,
  channels: null,
  generationId: `gen-${counter}`,
});
const unknownOutcome = (): ApiError =>
  Object.assign(new ApiError('Provider returned error', 502), { outcomeUnknown: true });

const $ = (root: ParentNode, testId: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

/** Paragraphs of about 900 characters each: one request per paragraph. */
const paragraph = (name: string): string =>
  Array.from(
    { length: 15 },
    (_, s) => `${name}, sentence ${s + 1} is about sixty characters long.`,
  ).join(' ');
const text = (...names: string[]): string => names.map(paragraph).join('\n\n');

let t: ToolTestContext | null = null;
beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
  hoisted.stitched.length = 0;
  hoisted.confirm.mockReset();
  hoisted.confirm.mockImplementation(() => Promise.resolve(true));
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLCanvasElement.prototype.getContext = () => null;
});
afterEach(async () => {
  await t?.cleanup();
  t = null;
  document.querySelectorAll('[data-testid="toast"]').forEach((node) => node.remove());
});

async function mount(speech: ApiClient['speech']) {
  t = createToolTestContext(getTool('text-to-speech'), {
    api: {
      speech,
      catalog: {
        models: () => Promise.resolve([KOKORO]),
        modelEndpoints: () =>
          Promise.resolve([
            { name: 'Together', provider_name: 'Together', pricing: { prompt: '0.000004' } },
          ]),
        imageModels: () => Promise.resolve([]),
        videoModels: () => Promise.resolve([]),
      },
    },
  });
  const tool = await t.mount(setup);
  await vi.waitFor(() =>
    expect(($(t!.zones.input, 'tts-voice') as HTMLSelectElement).value).toBe('af_alloy'),
  );
  return tool;
}

/** Makes parts 1 and 2 and leaves part 3 failed (fatal), so two paid parts wait to be joined. */
async function twoPartsMade(
  tool: Awaited<ReturnType<typeof mount>>,
  speech: ReturnType<typeof vi.fn<(body: SpeechRequest) => Promise<SpeechResult>>>,
  initial: string,
) {
  tool.applyState({ prompt: initial, settings: {} });
  await t!.runners[0]!.trigger();
  expect(speech).toHaveBeenCalledTimes(3);
  expect(t!.core.results.holds()).toEqual(['2 paid speech parts not joined yet']);
}

describe('Text-to-speech fixes', { timeout: 30_000 }, () => {
  it('M3: editing one paragraph keeps the parts made from the unchanged ones', async () => {
    let failThird = true;
    const speech = vi.fn((body: SpeechRequest) =>
      failThird && body.input.startsWith('Gamma')
        ? Promise.reject(new ApiError('Not enough credits', 402, {}))
        : Promise.resolve(mp3Result()),
    );
    const tool = await mount(speech);
    await twoPartsMade(tool, speech, text('Alpha', 'Beta', 'Gamma'));

    failThird = false;
    tool.applyState({ prompt: text('Alpha', 'Beta', 'Delta'), settings: {} });
    await t!.runners[0]!.trigger();
    // Only the new third paragraph is made; the other two are taken over without a question.
    expect(speech).toHaveBeenCalledTimes(4);
    expect(speech.mock.calls[3]![0].input).toMatch(/^Delta/);
    expect(hoisted.confirm).not.toHaveBeenCalled();
    expect(hoisted.stitched).toHaveLength(1);
    expect(hoisted.stitched[0]!.segments).toHaveLength(3);
    const [record] = await t!.core.history.query({ tool: 'text-to-speech' });
    // Edited words are a prompt of their own, so the new text is in Recent.
    expect(record?.prompt).toContain('Delta');
    expect(t!.core.results.holds()).toEqual([]);
  });

  it('M3: editing a paragraph with paid parts asks first, naming how many would be thrown away', async () => {
    let failThird = true;
    const speech = vi.fn((body: SpeechRequest) =>
      failThird && body.input.startsWith('Gamma')
        ? Promise.reject(new ApiError('Not enough credits', 402, {}))
        : Promise.resolve(mp3Result()),
    );
    const tool = await mount(speech);
    await twoPartsMade(tool, speech, text('Alpha', 'Beta', 'Gamma'));
    const firstPart = (await speech.mock.results[0]!.value) as SpeechResult;
    expect(firstPart).toBeDefined();

    failThird = false;
    tool.applyState({ prompt: text('Alpha edited', 'Beta', 'Gamma'), settings: {} });
    hoisted.confirm.mockImplementation(() => Promise.resolve(false));
    await t!.runners[0]!.trigger();
    expect(hoisted.confirm).toHaveBeenCalledTimes(1);
    expect(hoisted.confirm.mock.calls[0]![0]).toMatchObject({
      title: 'Replace the parts already made?',
      message: expect.stringContaining('1 paid speech part not joined yet') as unknown,
    });
    // Declined: nothing was sent and the parts made are still held.
    expect(speech).toHaveBeenCalledTimes(3);
    expect(t!.core.results.holds()).toEqual(['2 paid speech parts not joined yet']);

    hoisted.confirm.mockImplementation(() => Promise.resolve(true));
    await t!.runners[0]!.trigger();
    // Beta was kept: only the edited first paragraph and the unmade third are made.
    expect(speech).toHaveBeenCalledTimes(5);
    expect(speech.mock.calls.slice(3).map(([body]) => body.input.slice(0, 5))).toEqual([
      'Alpha',
      'Gamma',
    ]);
    expect(hoisted.stitched[0]!.segments).toHaveLength(3);
  });

  it('M3: another voice cannot reuse the parts: it asks before dropping them', async () => {
    let failThird = true;
    const speech = vi.fn((body: SpeechRequest) =>
      failThird && body.input.startsWith('Gamma')
        ? Promise.reject(new ApiError('Not enough credits', 402, {}))
        : Promise.resolve(mp3Result()),
    );
    const tool = await mount(speech);
    await twoPartsMade(tool, speech, text('Alpha', 'Beta', 'Gamma'));

    failThird = false;
    tool.applyState({ prompt: text('Alpha', 'Beta', 'Gamma'), settings: { voice: 'bm_george' } });
    hoisted.confirm.mockImplementation(() => Promise.resolve(false));
    await t!.runners[0]!.trigger();
    expect(hoisted.confirm.mock.calls[0]![0]).toMatchObject({
      message: expect.stringContaining('2 paid speech parts not joined yet') as unknown,
    });
    expect(speech).toHaveBeenCalledTimes(3);

    hoisted.confirm.mockImplementation(() => Promise.resolve(true));
    await t!.runners[0]!.trigger();
    expect(speech).toHaveBeenCalledTimes(6);
    expect(speech.mock.calls[5]![0]).toMatchObject({ voice: 'bm_george' });
  });

  it('M3: a plan with nothing paid is replaced without a question', async () => {
    const speech = vi.fn(() => Promise.reject(new ApiError('Not enough credits', 402, {})));
    const tool = await mount(speech);
    tool.applyState({ prompt: text('Alpha', 'Beta'), settings: {} });
    await t!.runners[0]!.trigger();
    tool.applyState({ prompt: text('Other'), settings: {} });
    await t!.runners[0]!.trigger();
    expect(hoisted.confirm).not.toHaveBeenCalled();
  });

  it('M1: a part that may have been billed says so and asks before it is made again', async () => {
    let fail = true;
    const speech = vi.fn((body: SpeechRequest) =>
      fail && body.input.startsWith('Beta')
        ? Promise.reject(unknownOutcome())
        : Promise.resolve(mp3Result()),
    );
    const tool = await mount(speech);
    tool.applyState({ prompt: text('Alpha', 'Beta', 'Gamma'), settings: {} });
    await t!.runners[0]!.trigger();
    const notice = $(t!.zones.output, 'tts-notice')!;
    expect($(notice, 'tts-failed')?.textContent).toContain('check your OpenRouter activity');
    expect($(notice, 'tts-failed-item-activity')).not.toBeNull();

    hoisted.confirm.mockImplementation(() => Promise.resolve(false));
    $(notice, 'tts-retry')!.click();
    await vi.waitFor(() => expect(hoisted.confirm).toHaveBeenCalledTimes(1));
    expect(hoisted.confirm.mock.calls[0]![0]).toMatchObject({ title: 'Retry anyway?' });
    expect(speech).toHaveBeenCalledTimes(3);

    fail = false;
    hoisted.confirm.mockImplementation(() => Promise.resolve(true));
    $(notice, 'tts-retry')!.click();
    await vi.waitFor(() => expect(hoisted.stitched).toHaveLength(1));
    expect(speech).toHaveBeenCalledTimes(4);
  });

  it('M1: a plainly failed part is retried without a question', async () => {
    let fail = true;
    const speech = vi.fn((body: SpeechRequest) =>
      fail && body.input.startsWith('Beta')
        ? Promise.reject(new ApiError('Bad request', 400, {}))
        : Promise.resolve(mp3Result()),
    );
    const tool = await mount(speech);
    tool.applyState({ prompt: text('Alpha', 'Beta', 'Gamma'), settings: {} });
    await t!.runners[0]!.trigger();
    fail = false;
    $(t!.zones.output, 'tts-retry')!.click();
    await vi.waitFor(() => expect(hoisted.stitched).toHaveLength(1));
    expect(hoisted.confirm).not.toHaveBeenCalled();
  });

  it('a retry joins into the format chosen now, not the one the plan was started with', async () => {
    let fail = true;
    const speech = vi.fn((body: SpeechRequest) =>
      fail && body.input.startsWith('Beta')
        ? Promise.reject(new ApiError('Bad request', 400, {}))
        : Promise.resolve(mp3Result()),
    );
    const tool = await mount(speech);
    tool.applyState({ prompt: text('Alpha', 'Beta'), settings: { format: 'mp3' } });
    await t!.runners[0]!.trigger();
    fail = false;
    tool.applyState({
      ...tool.getState(),
      settings: { ...tool.getState().settings, format: 'wav' },
    });
    $(t!.zones.output, 'tts-retry')!.click();
    await vi.waitFor(() => expect(hoisted.stitched).toHaveLength(1));
    expect(hoisted.stitched[0]!.format).toBe('wav');
  });
});
