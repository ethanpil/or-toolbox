/**
 * Mocked `/videos` endpoints for the Video studio specs (docs/openrouter-api.md §7): the real model list
 * (tests/fixtures/openrouter/videos-models.json), submits that answer 202 with a fresh job id, polls that stay
 * `pending` for a while (or until a test releases the job) and then say `completed` with a cost, and the content
 * endpoint serving tests/fixtures/media/video-1s.mp4 (1.04 s, 544 x 544, H.264 + AAC, the recorded grok clip).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA_FIXTURES_DIR, type OpenRouterMock, type RecordedCall } from '../mock/index.ts';

export const GROK = 'x-ai/grok-imagine-video';
export const SEEDANCE_MINI = 'bytedance/seedance-2.0-mini';
export const VIDEO_PATH = join(MEDIA_FIXTURES_DIR, 'video-1s.mp4');
export const VIDEO_BYTES = readFileSync(VIDEO_PATH);
export const IMAGE_PATH = join(MEDIA_FIXTURES_DIR, 'generated-image.jpg');

const MODELS = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', 'fixtures', 'openrouter', 'videos-models.json'),
    'utf8',
  ),
) as unknown;

/** A video request body as the page sent it. */
export interface VideoBody {
  model: string;
  prompt?: string;
  duration?: number;
  resolution?: string;
  aspect_ratio?: string;
  size?: string;
  generate_audio?: boolean;
  frame_images?: { type: string; image_url: { url: string }; frame_type: string }[];
  input_references?: (
    | { type: 'image_url'; image_url: { url: string } }
    | { type: 'video_url'; video_url: { url: string } }
  )[];
  previous_job_id?: string;
}

export function mockVideoCatalog(mock: OpenRouterMock): void {
  mock.json('GET', '/api/v1/videos/models', MODELS);
}

export interface VideoJobsOptions {
  /** Polls answered `pending` before `completed` (default 1). */
  pendingPolls?: number;
  /** `usage.cost` of a completed job (default 0.052, the recorded grok first-frame job). */
  cost?: number;
  /** Jobs (1-based submit number) that stay pending until `release(n)`. */
  held?: readonly number[];
  /** Jobs (1-based) that end `failed`. */
  failing?: readonly number[];
  /** Delay before each submit's 202, in ms. */
  submitDelayMs?: number;
}

export interface VideoJobsMock {
  /** Bodies of the `POST /videos` calls, in order. */
  submits(): VideoBody[];
  /** The job id of the n-th submit (1-based). */
  jobId(n: number): string;
  /** Lets a held job complete on its next poll. */
  release(n: number): void;
  /** Content downloads per job id. */
  downloads(): RecordedCall[];
}

/** Registers the job endpoints. Call `mockVideoCatalog` after it (the last mock registered wins). */
export function mockVideoJobs(mock: OpenRouterMock, options: VideoJobsOptions = {}): VideoJobsMock {
  const pendingPolls = options.pendingPolls ?? 1;
  const cost = options.cost ?? 0.052;
  const held = new Set(options.held ?? []);
  const failing = new Set(options.failing ?? []);
  const polls = new Map<string, number>();
  const ids: string[] = [];
  const idOf = (n: number): string => `gen-vid-1790000000-${String(n).padStart(20, 'a')}`;
  const numberOf = (id: string): number => ids.indexOf(id) + 1;

  mock.respond('POST', '/api/v1/videos', () => {
    const id = idOf(ids.length + 1);
    ids.push(id);
    return {
      status: 202,
      delayMs: options.submitDelayMs,
      body: { id, polling_url: `https://openrouter.ai/api/v1/videos/${id}`, status: 'pending' },
    };
  });
  mock.respond('GET', /^\/api\/v1\/videos\/gen-vid-[^/]+$/, (call) => {
    const id = call.path.split('/').at(-1)!;
    const n = numberOf(id);
    const count = (polls.get(id) ?? 0) + 1;
    polls.set(id, count);
    const base = {
      id,
      generation_id: id,
      polling_url: `https://openrouter.ai/api/v1/videos/${id}`,
    };
    if (n === 0)
      return { status: 404, body: { error: { code: 404, message: `Job ${id} not found` } } };
    if (held.has(n) || count <= pendingPolls) return { body: { ...base, status: 'pending' } };
    if (failing.has(n)) {
      return {
        body: { ...base, status: 'failed', error: 'The provider could not make this video.' },
      };
    }
    return {
      body: {
        ...base,
        status: 'completed',
        unsigned_urls: [`https://openrouter.ai/api/v1/videos/${id}/content?index=0`],
        usage: { cost, is_byok: false },
      },
    };
  });
  mock.respond('GET', /^\/api\/v1\/videos\/gen-vid-[^/]+\/content$/, () => ({
    body: VIDEO_BYTES,
    headers: { 'content-type': 'video/mp4' },
  }));

  return {
    submits: () => mock.calls('/api/v1/videos', 'POST').map((call) => call.body as VideoBody),
    jobId: idOf,
    release: (n) => void held.delete(n),
    downloads: () => mock.calls(/\/content$/, 'GET'),
  };
}

/** Settings for the specs: onboarding done and budgets off (no confirmation dialogs), unless a spec wants them. */
export const NO_BUDGETS = {
  budgets: { mode: 'disabled', perRunUsd: 0.1, monthlyUsd: null, perKeyMonthlyUsd: {} },
};

/** Width and height of a PNG `data:` URL, read from its IHDR chunk. */
export function pngSize(dataUrl: string): { width: number; height: number } | null {
  const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
  if (!match?.[1]) return null;
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.subarray(1, 4).toString('latin1') !== 'PNG') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
