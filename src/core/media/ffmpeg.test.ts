import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FfmpegModule from './ffmpeg';

/* eslint-disable @typescript-eslint/only-throw-error, @typescript-eslint/prefer-promise-reject-errors --
   the real ffmpeg worker reports failures as plain strings, and so does this fake. */

/**
 * A stand-in for @ffmpeg/ffmpeg's FFmpeg class. Tests set `next` to decide
 * how the next load of each core behaves.
 */
const fake = vi.hoisted(() => {
  type Outcome = 'ok' | 'fail' | 'wait-for-abort';
  const state = {
    next: { mt: 'ok', st: 'ok' } as Record<'mt' | 'st', Outcome>,
    created: [] as { core: 'mt' | 'st'; instance: FakeFFmpeg }[],
  };

  class FakeFFmpeg {
    loaded = false;
    terminated = false;

    load = async (config: { coreURL: string }, options: { signal?: AbortSignal } = {}) => {
      const core = config.coreURL.includes('core-mt') ? 'mt' : 'st';
      state.created.push({ core, instance: this });
      const outcome = state.next[core];
      if (outcome === 'fail') throw 'RuntimeError: worker failed';
      if (outcome === 'wait-for-abort') {
        await new Promise((_, reject) => {
          const abort = () => reject(options.signal?.reason as Error);
          if (options.signal?.aborted) abort();
          options.signal?.addEventListener('abort', abort);
        });
      }
      this.loaded = true;
      return true;
    };

    exec = (args: string[]): Promise<number> =>
      args[0] === 'crash'
        ? Promise.reject('RuntimeError: memory access out of bounds')
        : Promise.resolve(0);

    ffprobe = (): Promise<number> => Promise.resolve(0);

    terminate = () => {
      this.loaded = false;
      this.terminated = true;
    };
  }

  return { state, FakeFFmpeg };
});

vi.mock('@ffmpeg/ffmpeg', () => ({ FFmpeg: fake.FakeFFmpeg }));

/** A fresh copy of the module, so its per-page state starts empty. */
async function freshModule(): Promise<typeof FfmpegModule> {
  vi.resetModules();
  return import('./ffmpeg');
}

function setIsolated(isolated: boolean): void {
  Object.defineProperty(globalThis, 'crossOriginIsolated', { value: isolated, configurable: true });
}

beforeEach(() => {
  fake.state.next = { mt: 'ok', st: 'ok' };
  fake.state.created = [];
  setIsolated(true);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(new Uint8Array(8)))),
  );
  URL.createObjectURL = vi.fn(() => 'blob:fake');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('loadFfmpeg', () => {
  it('loads the multi-threaded core when isolated, and reuses it', async () => {
    const { loadFfmpeg } = await freshModule();
    const first = await loadFfmpeg();
    const second = await loadFfmpeg();
    expect(first.multiThreaded).toBe(true);
    expect(second.ffmpeg).toBe(first.ffmpeg);
    expect(fake.state.created).toHaveLength(1);
  });

  it('loads the single-threaded core when not isolated, or when asked to', async () => {
    const { loadFfmpeg } = await freshModule();
    expect((await loadFfmpeg({ singleThread: true })).multiThreaded).toBe(false);
    setIsolated(false);
    expect((await loadFfmpeg()).multiThreaded).toBe(false);
  });

  it('reports download progress against the size known at build time', async () => {
    const { loadFfmpeg } = await freshModule();
    const onProgress = vi.fn();
    await loadFfmpeg({ onProgress });
    expect(onProgress).toHaveBeenLastCalledWith({
      loaded: 8,
      total: __FFMPEG_ASSETS__.multiThread.wasmBytes,
    });
  });

  it('says what to do when the engine cannot be downloaded (a user error, not a bare Error)', async () => {
    const { loadFfmpeg } = await freshModule();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('', { status: 404 }))),
    );
    // (The module is a fresh copy, so its error classes are too: judge the error by what it carries.)
    const error = (await loadFfmpeg().catch((caught: unknown) => caught)) as Error & {
      code?: string;
    };
    expect(error).toMatchObject({ name: 'NetworkError', code: 'network' });
    expect(error.message).toMatch(/audio and video engine.*connection.*reload/i);
    expect(error.message).not.toContain('HTTP');
  });

  it('never hands out an instance that was terminated', async () => {
    const { loadFfmpeg } = await freshModule();
    const first = await loadFfmpeg();
    first.ffmpeg.terminate();
    const second = await loadFfmpeg();
    expect(second.ffmpeg).not.toBe(first.ffmpeg);
    expect(second.ffmpeg.loaded).toBe(true);
  });

  it('retires an instance whose exec crashed', async () => {
    const { loadFfmpeg } = await freshModule();
    const first = await loadFfmpeg();
    await expect(first.ffmpeg.exec(['crash'])).rejects.toThrow(/memory access/);
    expect(first.ffmpeg.loaded).toBe(false);
    expect((await loadFfmpeg()).ffmpeg).not.toBe(first.ffmpeg);
  });

  it('falls back to the single-threaded core for the rest of the page when the multi-threaded one fails', async () => {
    const { loadFfmpeg } = await freshModule();
    fake.state.next.mt = 'fail';
    expect((await loadFfmpeg()).multiThreaded).toBe(false);

    fake.state.next.mt = 'ok';
    expect((await loadFfmpeg()).multiThreaded).toBe(false);
    expect(fake.state.created.filter(({ core }) => core === 'mt')).toHaveLength(1);
  });

  it('gives up on a core that does not start in time, and falls back', async () => {
    const { loadFfmpeg } = await freshModule();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() =>
      AbortSignal.abort(new DOMException('timed out', 'TimeoutError')),
    );
    fake.state.next.mt = 'wait-for-abort';

    const loaded = await loadFfmpeg();
    expect(loaded.multiThreaded).toBe(false);
    const stuck = fake.state.created.find(({ core }) => core === 'mt')?.instance;
    expect(stuck?.terminated).toBe(true);
  });

  it('does not remember a failed load', async () => {
    const { loadFfmpeg } = await freshModule();
    setIsolated(false);
    fake.state.next.st = 'fail';
    await expect(loadFfmpeg()).rejects.toThrow(/worker failed/);

    fake.state.next.st = 'ok';
    expect((await loadFfmpeg()).ffmpeg.loaded).toBe(true);
  });

  it('disposeFfmpeg() terminates every instance', async () => {
    const { disposeFfmpeg, loadFfmpeg } = await freshModule();
    const multi = await loadFfmpeg();
    const single = await loadFfmpeg({ singleThread: true });
    disposeFfmpeg();
    await vi.waitFor(() => {
      expect(multi.ffmpeg.loaded).toBe(false);
      expect(single.ffmpeg.loaded).toBe(false);
    });
    expect((await loadFfmpeg()).ffmpeg).not.toBe(multi.ffmpeg);
  });
});
