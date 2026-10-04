import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawVideoModel, VideoJobStatus, VideoRequest } from '../../core/api/types';
import type * as Media from '../../core/media/image';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import type { ApiClient } from '../../core/types';
import type * as Errors from '../../ui/feedback/errors';
import { createToolTestContext, type ToolTestContext } from '../../ui/tool/testing';
import { getTool } from '../registry';
import { DEFAULT_SETTINGS, settingsJson } from './params';
import { TIMELINE_KEY } from './store';
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
});
