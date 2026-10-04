import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../core/errors';
import type { ResultHandle } from '../../ui/tool/types';
import { createClipMedia, EXPIRED_MESSAGE } from './clip-media';
import type { TimelineClip } from './timeline';

const clip = (patch: Partial<TimelineClip> = {}): TimelineClip => ({
  id: 'c1',
  name: 'c1.mp4',
  source: 'generated',
  jobId: 'j',
  remoteId: 'gen-1',
  keyId: 'k',
  model: 'm',
  prompt: '',
  duration: 1,
  trimStart: 0,
  trimEnd: 0,
  continues: false,
  dropFirstFrame: false,
  included: true,
  sequenceId: null,
  slotKey: null,
  attempt: 1,
  expired: false,
  staleSource: false,
  createdAt: 1,
  ...patch,
});

function media(download: (signal: AbortSignal) => Promise<Blob>) {
  const results: string[] = [];
  const expired: string[] = [];
  const created = createClipMedia({
    download: (_clip, signal) => download(signal),
    addResult: (item) => {
      results.push(item.id);
      return { remove: () => undefined, result: { id: item.id } } as unknown as ResultHandle;
    },
    lastFrame: () => Promise.resolve('data:image/png;base64,F'),
    onChange: () => undefined,
    onExpired: (item) => void expired.push(item.id),
  });
  return { created, results, expired };
}

describe('clip media', () => {
  it('forget() aborts the download and never keeps what arrives afterwards', async () => {
    let finish!: (blob: Blob) => void;
    let aborted = false;
    const { created, results } = media(
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => (aborted = true));
          finish = resolve;
        }),
    );
    const pending = created.ensure(clip());
    created.forget('c1');
    expect(aborted).toBe(true);
    finish(new Blob(['mp4']));
    await expect(pending).rejects.toThrow('This clip was removed.');
    expect(created.blob('c1')).toBeUndefined();
    expect(results).toEqual([]);
    // A forgotten clip is not fetched or registered again.
    await expect(created.ensure(clip())).rejects.toBeTruthy();
    created.put(clip(), new Blob(['x']));
    expect(results).toEqual([]);
  });

  it('a 404 marks the clip expired: not usable, shown as expired', async () => {
    const { created, expired } = media(() => Promise.reject(new ApiError('Not found', 404)));
    await expect(created.ensure(clip())).rejects.toBeTruthy();
    expect(expired).toEqual(['c1']);
    expect(created.usable(clip())).toBe(false);
    expect(created.state(clip())).toMatchObject({ kind: 'error', message: EXPIRED_MESSAGE });
    expect(created.state(clip({ expired: true }))).toEqual({
      kind: 'missing',
      message: EXPIRED_MESSAGE,
    });
    expect(created.usable(clip({ id: 'other', expired: true }))).toBe(false);
  });

  it('downloads once and registers the clip as a result', async () => {
    const download = vi.fn(() => Promise.resolve(new Blob(['mp4'])));
    const { created, results } = media(download);
    await Promise.all([created.ensure(clip()), created.ensure(clip())]);
    expect(download).toHaveBeenCalledTimes(1);
    expect(results).toEqual(['c1']);
    expect(created.usable(clip({ source: 'upload', remoteId: null, id: 'u' }))).toBe(false);
  });
});
