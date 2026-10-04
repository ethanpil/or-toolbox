import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawVideoModel, VideoJobStatus, VideoRequest } from '../../core/api/types';
import type * as Media from '../../core/media/image';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import type { ApiClient } from '../../core/types';
import { ApiError, NetworkError } from '../../core/errors';
import type * as Errors from '../../ui/feedback/errors';
import { presentError } from '../../ui/feedback/errors';
import { createToolTestContext, type ToolTestContext } from '../../ui/tool/testing';
import { getTool } from '../registry';
import { DEFAULT_SETTINGS, settingsJson } from './params';
import { SEQUENCE_KEY, TIMELINE_KEY } from './store';
import { setup, stemFrom } from './tool';

// jsdom cannot decode images or video: stand-ins for the header reads, encoders and frame grabs.
vi.mock('../../core/media/image', async (importOriginal) => ({
  ...(await importOriginal<typeof Media>()),
  loadImage: () => Promise.resolve({ width: 64, height: 64, close: () => undefined }),
  toDataUrl: (blob: Blob) => Promise.resolve(`data:${blob.type};base64,IMG`),
}));
vi.mock('../../core/media/video', () => ({
  getVideoMetadata: () => Promise.resolve({ duration: 1.04, width: 544, height: 544 }),
  captureFrame: () => Promise.resolve(new Blob(['png'], { type: 'image/png' })),
  clampSeekTime: (time: number) => time,
}));
vi.mock('../../ui/feedback/errors', async (importOriginal) => ({
  ...(await importOriginal<typeof Errors>()),
  presentError: vi.fn(() => Promise.resolve()),
}));

const videoModels = (
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../../tests/fixtures/openrouter/videos-models.json'),
      'utf8',
    ),
  ) as { data: RawVideoModel[] }
).data;
const GROK = 'x-ai/grok-imagine-video';

let t: ToolTestContext;
let submits: VideoRequest[];

function completed(id: string): VideoJobStatus {
  return {
    id,
    status: 'completed',
    done: true,
    generationId: id,
    outputs: 1,
    costUsd: 0.052,
    error: null,
  };
}

async function mount(api: Partial<ApiClient> = {}) {
  submits = [];
  t = createToolTestContext(getTool('video-studio'), {
    api: {
      videos: {
        submit: (body) => {
          submits.push(body);
          const id = `gen-vid-1-${String(submits.length).padStart(20, '0')}`;
          return Promise.resolve({
            ...completed(id),
            status: 'pending',
            done: false,
            costUsd: null,
          });
        },
        status: (id) => Promise.resolve(completed(id)),
        content: () => Promise.resolve(new Blob(['mp4'], { type: 'video/mp4' })),
      },
      catalog: {
        models: () => Promise.resolve([]),
        modelEndpoints: () => Promise.resolve([]),
        imageModels: () => Promise.resolve([]),
        videoModels: () => Promise.resolve(videoModels),
      },
      ...api,
    },
  });
  const tool = await t.mount(setup);
  await vi.waitFor(() => expect(t.estimate()).not.toBeUndefined());
  return tool;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.querySelector<T>(`[data-testid="${id}"]`)!;

/** One 1 s clip ($0.05 on Grok at 480p). */
const oneSecond = () =>
  settingsJson({ ...DEFAULT_SETTINGS, format: { ...DEFAULT_SETTINGS.format, duration: 1 } });
/** A one-step sequence of 1 s clips. */
const oneStepSequence = () =>
  settingsJson({
    ...DEFAULT_SETTINGS,
    tab: 'sequence',
    format: { ...DEFAULT_SETTINGS.format, duration: 1 },
    sequence: {
      ...DEFAULT_SETTINGS.sequence,
      steps: [{ id: 'a', prompt: 'One', imageRole: 'references' }],
    },
  });

beforeAll(() => {
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = () => undefined;
  HTMLMediaElement.prototype.pause = () => undefined;
  HTMLMediaElement.prototype.load = () => undefined;
});
beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
});
describe('file names', () => {
  it('come from the prompt', () => {
    expect(stemFrom('A fishing boat leaves a quiet harbour!')).toBe('a-fishing-boat-leaves-a');
    expect(stemFrom('???')).toBe('clip');
  });
});

describe('Video studio', () => {
  afterEach(() => {
    t.cleanup();
  });

  it('round-trips its state exactly', async () => {
    const tool = await mount();
    const state = {
      prompt: 'A boat at dawn',
      settings: settingsJson({
        ...DEFAULT_SETTINGS,
        tab: 'sequence',
        mode: 'references',
        format: {
          duration: 3,
          resolution: '720p',
          aspectRatio: '1:1',
          size: null,
          audio: 'off',
          seed: 5,
        },
        sequence: {
          mode: 'independent',
          repeat: 3,
          style: 'Noir',
          capUsd: 0.5,
          onFailure: 'skip',
          steps: [
            { id: 's1', prompt: 'One', imageRole: 'references' },
            { id: 's2', prompt: 'Two', imageRole: 'last-frame' },
          ],
        },
      }),
    };
    tool.applyState(state);
    expect(tool.getState()).toEqual(state);
    tool.applyState(tool.getState());
    expect(tool.getState()).toEqual(state);
  });

  it('estimates a clip from the model price, and a sequence in full', async () => {
    const tool = await mount();
    // Grok at 480p: $0.05 a second, 5 s by default.
    expect(t.estimate()).toBeCloseTo(0.25, 6);
    tool.applyState({
      prompt: 'x',
      settings: settingsJson({
        ...DEFAULT_SETTINGS,
        format: { ...DEFAULT_SETTINGS.format, duration: 1 },
      }),
    });
    await vi.waitFor(() => expect(t.estimate()).toBeCloseTo(0.05, 6));
    // Three chained steps: the second and third send a first frame ($0.002 each).
    tool.applyState({
      prompt: 'x',
      settings: settingsJson({
        ...DEFAULT_SETTINGS,
        tab: 'sequence',
        format: { ...DEFAULT_SETTINGS.format, duration: 1 },
        sequence: {
          ...DEFAULT_SETTINGS.sequence,
          steps: ['a', 'b', 'c'].map((id) => ({
            id,
            prompt: id,
            imageRole: 'references' as const,
          })),
        },
      }),
    });
    await vi.waitFor(() => expect(t.estimate()).toBeCloseTo(0.154, 6));
  });

  it('sends a text clip, hands its run to the job and puts the clip on the timeline with its cost', async () => {
    const tool = await mount();
    tool.applyState({
      prompt: 'A boat at dawn',
      settings: settingsJson({
        ...DEFAULT_SETTINGS,
        format: { ...DEFAULT_SETTINGS.format, duration: 1 },
      }),
    });
    await t.runners[0]!.trigger();
    expect(submits).toEqual([
      {
        model: GROK,
        prompt: 'A boat at dawn',
        duration: 1,
        resolution: '480p',
        aspect_ratio: '16:9',
      },
    ]);
    await vi.waitFor(async () => {
      const stored = (
        await t.ctx.state.get<{ clips: { name: string; duration: number | null }[] }>(TIMELINE_KEY)
      )?.clips;
      expect(stored).toHaveLength(1);
      expect(stored?.[0]?.duration).toBe(1.04);
    });
    await vi.waitFor(async () => {
      const [record] = await t.core.history.query({ tool: 'video-studio' });
      expect(record?.status).toBe('ok');
      expect(record?.usage.costUsd).toBeCloseTo(0.052, 6);
      expect(record?.jobId).not.toBeNull();
    });
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-testid="video-clip"]')).toHaveLength(1),
    );
    // The clip is an unsaved result, so leaving asks first.
    expect(t.core.results.pending().map((result) => result.kind)).toEqual(['video']);
  });

  it('refuses frames the model cannot take before anything is sent', async () => {
    const tool = await mount();
    tool.applyState({
      prompt: 'A walk',
      settings: settingsJson({ ...DEFAULT_SETTINGS, mode: 'first-last' }),
    });
    await t.runners[0]!.trigger();
    expect(submits).toEqual([]);
    expect(t.status()).toContain('takes a first frame only');
    expect($('video-problem').textContent).toContain('takes a first frame only');
    expect(await t.core.history.query({ tool: 'video-studio' })).toEqual([]);
  });

  it('asks for a prompt, a first frame or a clip to continue as the mode needs', async () => {
    const tool = await mount();
    tool.applyState({ prompt: '', settings: settingsJson(DEFAULT_SETTINGS) });
    await t.runners[0]!.trigger();
    expect(t.status()).toBe('Describe the video first.');
    tool.applyState({
      prompt: '',
      settings: settingsJson({ ...DEFAULT_SETTINGS, mode: 'continue' }),
    });
    await t.runners[0]!.trigger();
    expect(t.status()).toBe('Choose or upload the clip to continue.');
    expect(submits).toEqual([]);
  });

  it('records the form as it was when Generate was pressed, whatever changes while it is sent', async () => {
    let release!: () => void;
    const tool = await mount({
      videos: {
        submit: async (body) => {
          submits.push(body);
          await new Promise<void>((resolve) => (release = resolve));
          return { ...completed('gen-vid-1-00000000000000000001'), status: 'pending', done: false };
        },
        status: (id) => Promise.resolve(completed(id)),
        content: () => Promise.resolve(new Blob(['mp4'], { type: 'video/mp4' })),
      },
    });
    const pressed = {
      prompt: 'A boat at dawn',
      settings: settingsJson({
        ...DEFAULT_SETTINGS,
        format: { ...DEFAULT_SETTINGS.format, duration: 1 },
      }),
    };
    tool.applyState(pressed);
    const run = t.runners[0]!.trigger();
    await vi.waitFor(() => expect(submits).toHaveLength(1));
    // The user edits the form while the request is on its way.
    tool.applyState({
      prompt: 'Something else',
      settings: settingsJson({ ...DEFAULT_SETTINGS, mode: 'references' }),
    });
    release();
    await run;
    const [record] = await t.core.history.query({ tool: 'video-studio' });
    expect(record?.prompt).toBe('A boat at dawn');
    expect(record?.settings).toEqual(pressed.settings);
    expect(record?.model).toBe(GROK);
  });

  it('leaves a request that may have reached OpenRouter to the framework, which offers no Retry for it', async () => {
    // The API client marks a paid request that may have gone through.
    const failure = new NetworkError();
    failure.outcomeUnknown = true;
    const tool = await mount({
      videos: {
        submit: (body) => {
          submits.push(body);
          return Promise.reject(failure);
        },
        status: (id) => Promise.resolve(completed(id)),
        content: () => Promise.resolve(new Blob(['mp4'])),
      },
    });
    tool.applyState({ prompt: 'A boat', settings: oneSecond() });
    vi.mocked(presentError).mockClear();
    await t.runners[0]!.trigger();
    expect(submits).toHaveLength(1);
    // No toast of its own: the runner's presentError explains it (and keeps Retry back).
    expect(document.body.textContent).not.toContain('may have reached OpenRouter');
    const calls = vi.mocked(presentError).mock.calls;
    expect(calls.map((call) => call[0])).toEqual([failure]);
    expect(calls[0]?.[1]?.retryUnknownOutcome).toBeUndefined();
    const [record] = await t.core.history.query({ tool: 'video-studio' });
    expect(record?.status).toBe('error');
  });

  it('says a request OpenRouter accepted but this page cannot follow may be billed, with no Retry', async () => {
    const tool = await mount({
      videos: {
        submit: (body) => {
          submits.push(body);
          // Accepted (202) without a job id: nothing to follow.
          return Promise.resolve({ ...completed(''), status: 'pending', done: false });
        },
        status: (id) => Promise.resolve(completed(id)),
        content: () => Promise.resolve(new Blob(['mp4'])),
      },
    });
    tool.applyState({ prompt: 'A boat', settings: oneSecond() });
    vi.mocked(presentError).mockClear();
    await t.runners[0]!.trigger();
    expect(submits).toHaveLength(1);
    // Shown first without a Retry (the runner's later call finds it already shown).
    const [first] = vi.mocked(presentError).mock.calls;
    expect(String((first?.[0] as Error).message)).toContain(
      'OpenRouter accepted the video request',
    );
    expect(first?.[1]?.retry).toBeUndefined();
    const [record] = await t.core.history.query({ tool: 'video-studio' });
    expect(record?.status).toBe('error');
    expect(record?.usage.costUnknown).toBe(true);
  });

  it('"Stop waiting" ends the run as stopped at once, booking its reservation', async () => {
    const tool = await mount({
      videos: {
        submit: (body) => {
          submits.push(body);
          return Promise.resolve({ ...completed('gen-vid-1-1'), status: 'pending', done: false });
        },
        status: (id) => Promise.resolve({ ...completed(id), status: 'pending', done: false }),
        content: () => Promise.resolve(new Blob(['mp4'])),
      },
    });
    tool.applyState({ prompt: 'A boat', settings: oneSecond() });
    await t.runners[0]!.trigger();
    const [job] = await t.core.jobs.list({ tool: 'video-studio' });
    await t.core.jobs.cancel(job!.id);
    await vi.waitFor(async () => {
      const [record] = await t.core.history.query({ tool: 'video-studio' });
      expect(record?.status).toBe('aborted');
      expect(record?.usage.costUnknown).toBe(true);
    });
  });

  it('a clip job notifies only when the switch is on; sequence steps leave it to the sequence', async () => {
    const tool = await mount();
    tool.applyState({ prompt: 'A boat', settings: oneSecond() });
    await t.runners[0]!.trigger();
    t.ctx.options.set({ notify: true });
    await t.runners[0]!.trigger();
    tool.applyState({ prompt: '', settings: oneStepSequence() });
    await t.runners[0]!.trigger();
    await vi.waitFor(async () =>
      expect(await t.core.jobs.list({ tool: 'video-studio' })).toHaveLength(3),
    );
    const jobs = await t.core.jobs.list({ tool: 'video-studio' });
    const notify = (sequence: boolean) =>
      jobs
        .filter(
          (job) =>
            ((job.payload as { sequenceId: string | null }).sequenceId !== null) === sequence,
        )
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((job) => job.notify);
    expect(notify(false)).toEqual([false, true]);
    expect(notify(true)).toEqual([false]);
  });

  it.each([
    ['the provider failed it: nothing counts against the cap', 'remote', 0, false],
    ['the page gave up asking: its reservation counts', 'gave-up', 0.05, true],
  ] as const)('a failed sequence step: %s', async (_, kind, spentUsd, spentEstimated) => {
    const tool = await mount({
      videos: {
        submit: (body) => {
          submits.push(body);
          return Promise.resolve({ ...completed('gen-vid-1-1'), status: 'pending', done: false });
        },
        status: (id) =>
          kind === 'remote'
            ? Promise.resolve({
                ...completed(id),
                status: 'failed',
                costUsd: null,
                error: 'Failed.',
              })
            : Promise.reject(new ApiError('Not found', 404)),
        content: () => Promise.resolve(new Blob(['mp4'])),
      },
    });
    tool.applyState({ prompt: '', settings: oneStepSequence() });
    await t.runners[0]!.trigger();
    await vi.waitFor(async () => {
      const [job] = await t.core.jobs.list({ tool: 'video-studio' });
      expect(job?.failureKind).toBe(kind);
      const stored = await t.ctx.state.get<{ slots: { status: string }[] }>(SEQUENCE_KEY);
      expect(stored?.slots[0]).toMatchObject({ status: 'failed', spentUsd, spentEstimated });
    });
  });

  it("writes only this tab's edits over a stored run: a cap lowered elsewhere stays, and the form follows it", async () => {
    const { createRun } = await import('./sequence');
    const { SEQUENCE_KEY } = await import('./store');
    const tool = await mount();
    const stored = {
      ...createRun({
        id: 'seq',
        spec: {
          ...DEFAULT_SETTINGS.sequence,
          capUsd: 0.5,
          steps: [{ id: 'a', prompt: 'One', imageRole: 'references' as const }],
        },
        model: GROK,
        format: DEFAULT_SETTINGS.format,
        sourceClipId: null,
        now: 1,
      }),
      status: 'paused' as const,
    };
    await t.ctx.state.set(SEQUENCE_KEY, stored);
    await vi.waitFor(() =>
      expect((tool.getState().settings['sequence'] as { capUsd: number }).capUsd).toBe(0.5),
    );
    // Another tab lowers the cap; this tab's form follows.
    await t.ctx.state.set(SEQUENCE_KEY, { ...stored, spec: { ...stored.spec, capUsd: 0.1 } });
    await vi.waitFor(() =>
      expect((tool.getState().settings['sequence'] as { capUsd: number }).capUsd).toBe(0.1),
    );
    // This tab edits a prompt: only the prompt is written.
    const prompt = $<HTMLTextAreaElement>('seq-step-prompt');
    prompt.value = 'One, better';
    prompt.dispatchEvent(new Event('input'));
    await vi.waitFor(async () => {
      const now = await t.ctx.state.get<{ spec: { capUsd: number; steps: { prompt: string }[] } }>(
        SEQUENCE_KEY,
      );
      expect(now?.spec.steps[0]?.prompt).toBe('One, better');
      expect(now?.spec.capUsd).toBe(0.1);
    });
  });
});
