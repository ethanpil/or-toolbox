/**
 * Session results: images, audio, video and files produced in this page. They live in memory only (never
 * in storage). While anything is not downloaded, or a tool holds unsaved work (`hold()`: a recording in
 * progress, paid parts not joined), a `beforeunload` handler asks the browser to confirm leaving; the shell adds
 * its own in-app dialog on top.
 */

import type { CoreServices, ResultKind, ResultsService, SessionResult } from '../types';
import { InvalidInputError } from '../errors';
import { zipFiles } from '../export/zip';
import { downloadBlob } from '../files';
import { utcDay } from '../util';

const NOUNS: Record<ResultKind, [one: string, many: string]> = {
  image: ['image', 'images'],
  audio: ['audio file', 'audio files'],
  video: ['video', 'videos'],
  file: ['file', 'files'],
};
const KIND_ORDER: ResultKind[] = ['image', 'audio', 'video', 'file'];

/** "a", "a and b", "a, b and c". */
function joinList(parts: string[]): string {
  return parts.length <= 1
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- same factory shape as every core service
export function createResultsService(_core: CoreServices): ResultsService {
  const results = new Map<string, SessionResult>();
  const urls = new Map<string, string>();
  const listeners = new Set<() => void>();
  /** Unsaved work tools hold, by token (insertion order = oldest first). */
  const held = new Map<symbol, string>();
  let guarded = false;

  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    event.preventDefault();
    // Older Safari and Chromium show the prompt only when returnValue is set.
    event.returnValue = '';
  };

  const changed = (): void => {
    const needGuard = held.size > 0 || [...results.values()].some((result) => !result.downloaded);
    if (typeof window !== 'undefined' && needGuard !== guarded) {
      if (needGuard) window.addEventListener('beforeunload', onBeforeUnload);
      else window.removeEventListener('beforeunload', onBeforeUnload);
      guarded = needGuard;
    }
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch (error) {
        console.error(error);
      }
    }
  };

  const getOrThrow = (id: string): SessionResult => {
    const result = results.get(id);
    if (!result) throw new InvalidInputError('Unknown result: it was removed from this page.');
    return result;
  };

  /** Updates the very object `add()` returned, so callers holding it see the change. */
  const markDownloaded = (id: string): void => {
    const result = results.get(id);
    if (!result || result.downloaded) return;
    result.downloaded = true;
    changed();
  };

  const download = (id: string): void => {
    const result = getOrThrow(id);
    downloadBlob(result.blob, result.name); // sanitises the name; its own URL is revoked later
    markDownloaded(id);
  };

  const pending = (): SessionResult[] =>
    [...results.values()].filter((result) => !result.downloaded);

  return {
    add({ tool, kind, name, blob }) {
      const result: SessionResult = {
        id: crypto.randomUUID(),
        tool,
        kind,
        name,
        blob,
        downloaded: false,
        createdAt: Date.now(),
      };
      results.set(result.id, result);
      changed();
      return result;
    },
    download,
    markDownloaded,
    remove(id) {
      // Drop every reference this service holds, so the Blob can be garbage-collected.
      const url = urls.get(id);
      if (url) URL.revokeObjectURL(url);
      urls.delete(id);
      if (results.delete(id)) changed();
    },
    objectUrl(id) {
      let url = urls.get(id);
      if (!url) {
        url = URL.createObjectURL(getOrThrow(id).blob);
        urls.set(id, url);
      }
      return url;
    },
    pending,
    summary() {
      const counts = new Map<ResultKind, number>();
      for (const result of pending()) counts.set(result.kind, (counts.get(result.kind) ?? 0) + 1);
      if (counts.size === 0) return null;
      const parts = KIND_ORDER.filter((kind) => counts.has(kind)).map((kind) => {
        const count = counts.get(kind) ?? 0;
        return `${count} ${NOUNS[kind][count === 1 ? 0 : 1]}`;
      });
      return `${joinList(parts)} not downloaded`;
    },
    hold(description) {
      const token = Symbol(description);
      held.set(token, description);
      changed();
      return () => {
        if (held.delete(token)) changed();
      };
    },
    holds: () => [...held.values()],
    releaseHolds() {
      if (held.size === 0) return;
      held.clear();
      changed();
    },
    async downloadAll() {
      const todo = pending();
      if (todo.length === 0) return;
      if (todo.length === 1) return download(todo[0]!.id);
      const zip = await zipFiles(todo.map((result) => ({ name: result.name, data: result.blob })));
      downloadBlob(zip, `ortoolbox-results-${utcDay()}.zip`);
      for (const result of todo) markDownloaded(result.id);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
