/**
 * Session results: images, audio, video and files produced in this page. They live in memory only (never
 * in storage). While anything is not downloaded, a `beforeunload` handler asks the browser to confirm
 * leaving; the shell adds its own in-app dialog on top.
 */

import type { CoreServices, ResultKind, ResultsService, SessionResult } from '../types';

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

/** `name.png`, `name (2).png`, … — unique within one ZIP. */
function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function saveFile(href: string, name: string): void {
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  link.rel = 'noopener';
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
}

/** Downloads a blob through a temporary object URL (revoked later: revoking at once can cancel it). */
function saveBlob(blob: Blob, name: string): void {
  const href = URL.createObjectURL(blob);
  saveFile(href, name);
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- same factory shape as every core service
export function createResultsService(_core: CoreServices): ResultsService {
  const results = new Map<string, SessionResult>();
  const urls = new Map<string, string>();
  const listeners = new Set<() => void>();
  let guarded = false;

  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    event.preventDefault();
    // Older Safari and Chromium show the prompt only when returnValue is set.
    event.returnValue = '';
  };

  const changed = (): void => {
    const needGuard = [...results.values()].some((result) => !result.downloaded);
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
    if (!result) throw new Error(`Unknown result ${id}.`);
    return result;
  };

  const markDownloaded = (id: string): void => {
    const result = results.get(id);
    if (!result || result.downloaded) return;
    results.set(id, { ...result, downloaded: true });
    changed();
  };

  const download = (id: string): void => {
    const result = getOrThrow(id);
    const cached = urls.get(id);
    if (cached) saveFile(cached, result.name);
    else saveBlob(result.blob, result.name);
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
    async downloadAll() {
      const todo = pending();
      if (todo.length === 0) return;
      if (todo.length === 1) return download(todo[0]!.id);
      const { zipSync } = await import('fflate');
      const used = new Set<string>();
      const files: Record<string, Uint8Array> = {};
      for (const result of todo) {
        files[uniqueName(result.name, used)] = new Uint8Array(await result.blob.arrayBuffer());
      }
      // Media is already compressed: store, don't deflate.
      const zip = zipSync(files, { level: 0 });
      saveBlob(
        new Blob([zip], { type: 'application/zip' }),
        `ortoolbox-results-${new Date().toISOString().slice(0, 10)}.zip`,
      );
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
