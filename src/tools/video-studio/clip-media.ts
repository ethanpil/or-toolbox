/**
 * The clips' videos, in memory only (rule 3): which ones this page holds, downloads of generated clips from
 * OpenRouter (once per clip at a time; again after a reload while OpenRouter keeps them), the leave-guard result
 * of each generated clip, and each clip's true last frame as a PNG data URL (captured once, for Continue and
 * chained steps).
 */
import { ApiError, userMessage } from '../../core/errors';
import type { ResultHandle } from '../../ui/tool/types';
import type { TimelineClip } from './timeline';

/** A download's failure in words: a 404 means OpenRouter no longer keeps the clip (retention is short, §7.4). */
export function downloadMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return 'OpenRouter no longer has this clip (finished videos are kept only for a while). Remove it, or make it again.';
  }
  return userMessage(error);
}

export type ClipState =
  | { kind: 'ready'; blob: Blob }
  | { kind: 'loading' }
  | { kind: 'error'; message: string; error: unknown }
  /** Not in this page and cannot be fetched (an upload after a reload). */
  | { kind: 'missing'; message: string };

export interface ClipMediaOptions {
  /** Downloads a generated clip's video (the content endpoint). */
  download(clip: TimelineClip): Promise<Blob>;
  /** Registers a generated clip with the leave guard. */
  addResult(clip: TimelineClip, blob: Blob): ResultHandle;
  /** The final frame of a video as a PNG `data:` URL (captureFrame 'last' + encoding). */
  lastFrame(blob: Blob): Promise<string>;
  /** Something about a clip changed (it arrived, failed, was dropped). */
  onChange(clipId: string): void;
}

export interface ClipMedia {
  state(clip: TimelineClip): ClipState;
  /** The clip's video now, or undefined. */
  blob(clipId: string): Blob | undefined;
  /** Puts a video in memory (a finished job, an upload); generated clips become leave-guard results. */
  put(clip: TimelineClip, blob: Blob): void;
  /** The video, downloading a generated clip when it is not in memory. Rejects for an upload not in memory. */
  ensure(clip: TimelineClip): Promise<Blob>;
  /** Starts downloads for generated clips not in memory and not failed (after a reload). */
  prefetch(clips: readonly TimelineClip[]): void;
  /** The clip's last frame as a PNG data URL (cached). */
  lastFrame(clip: TimelineClip): Promise<string>;
  /** The clip's leave-guard result, if it has one. */
  result(clipId: string): ResultHandle | undefined;
  /** Forgets a clip (removed from the timeline): drops its result and video. */
  forget(clipId: string): void;
  /** Clears a failed download so the next `ensure` tries again. */
  retry(clipId: string): void;
}

export function createClipMedia(options: ClipMediaOptions): ClipMedia {
  const blobs = new Map<string, Blob>();
  const loading = new Map<string, Promise<Blob>>();
  const failures = new Map<string, unknown>();
  const results = new Map<string, ResultHandle>();
  const frames = new Map<string, Promise<string>>();

  const put = (clip: TimelineClip, blob: Blob): void => {
    if (blobs.get(clip.id) === blob) return;
    blobs.set(clip.id, blob);
    failures.delete(clip.id);
    frames.delete(clip.id);
    if (clip.source === 'generated' && !results.has(clip.id)) {
      results.set(clip.id, options.addResult(clip, blob));
    }
    options.onChange(clip.id);
  };

  const ensure = (clip: TimelineClip): Promise<Blob> => {
    const held = blobs.get(clip.id);
    if (held) return Promise.resolve(held);
    const pending = loading.get(clip.id);
    if (pending) return pending;
    if (clip.source !== 'generated' || !clip.remoteId || !clip.keyId) {
      return Promise.reject(new Error(missingMessage(clip)));
    }
    const download = options.download(clip).then(
      (blob) => {
        loading.delete(clip.id);
        put(clip, blob);
        return blob;
      },
      (error: unknown) => {
        loading.delete(clip.id);
        failures.set(clip.id, error);
        options.onChange(clip.id);
        throw error;
      },
    );
    loading.set(clip.id, download);
    failures.delete(clip.id);
    options.onChange(clip.id);
    return download;
  };

  return {
    state(clip) {
      const blob = blobs.get(clip.id);
      if (blob) return { kind: 'ready', blob };
      if (loading.has(clip.id)) return { kind: 'loading' };
      if (failures.has(clip.id)) {
        const error = failures.get(clip.id);
        return { kind: 'error', message: downloadMessage(error), error };
      }
      if (clip.source !== 'generated' || !clip.remoteId) {
        return { kind: 'missing', message: missingMessage(clip) };
      }
      return { kind: 'loading' };
    },
    blob: (clipId) => blobs.get(clipId),
    put,
    ensure,
    prefetch(clips) {
      for (const clip of clips) {
        if (clip.source !== 'generated' || blobs.has(clip.id) || failures.has(clip.id)) continue;
        void ensure(clip).catch(() => undefined); // shown on the clip, with Try again
      }
    },
    lastFrame(clip) {
      let frame = frames.get(clip.id);
      if (!frame) {
        frame = ensure(clip).then((blob) => options.lastFrame(blob));
        frames.set(clip.id, frame);
        frame.catch(() => {
          if (frames.get(clip.id) === frame) frames.delete(clip.id);
        });
      }
      return frame;
    },
    result: (clipId) => results.get(clipId),
    forget(clipId) {
      results.get(clipId)?.remove();
      results.delete(clipId);
      blobs.delete(clipId);
      failures.delete(clipId);
      frames.delete(clipId);
      loading.delete(clipId);
    },
    retry(clipId) {
      failures.delete(clipId);
      options.onChange(clipId);
    },
  };
}

function missingMessage(clip: TimelineClip): string {
  return clip.source === 'upload'
    ? 'This upload was not kept after the reload (videos stay in memory only). Add the file again.'
    : 'This clip cannot be downloaded again.';
}
