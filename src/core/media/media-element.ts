/**
 * Plumbing shared by audio.ts and video.ts: load a Blob into an `<audio>` or
 * `<video>` element, wait for it, and release it again. Browser only.
 *
 * Elements are created detached, except videos, which are parked off-screen in
 * the document: Safari does not reliably decode frames of a detached video
 * that is only being seeked.
 */

export interface OpenedMedia<T extends HTMLMediaElement> {
  element: T;
  /** Frees the decoder and the object URL. Safe to call twice. */
  dispose: () => void;
}

/** How long to wait for a media element to react before giving up. */
const MEDIA_TIMEOUT_MS = 30_000;

/**
 * Resolves with the name of the first event of `events` that fires on
 * `target`. Rejects after `timeoutMs` (or when `signal` aborts).
 */
export function waitForEvent(
  target: EventTarget,
  events: string[],
  timeoutMs = MEDIA_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      for (const name of events) target.removeEventListener(name, onEvent);
    };
    const onEvent = (event: Event): void => {
      cleanup();
      resolve(event.type);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('The browser took too long to read this media file.'));
    }, timeoutMs);
    for (const name of events) target.addEventListener(name, onEvent);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort);
  });
}

function describeError(element: HTMLMediaElement, kind: string): Error {
  const detail =
    element.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
      ? ' (its format or codec is not supported by this browser)'
      : '';
  return new Error(`This ${kind} file cannot be played${detail}.`);
}

/**
 * Loads a Blob into a media element and waits until its metadata is known.
 * Streams whose length is unknown (`duration === Infinity`, typical for
 * recordings made with MediaRecorder) are probed to find it.
 */
export async function openMedia<K extends 'audio' | 'video'>(
  blob: Blob,
  kind: K,
  signal?: AbortSignal,
): Promise<OpenedMedia<K extends 'audio' ? HTMLAudioElement : HTMLVideoElement>> {
  const element = document.createElement(kind);
  element.preload = 'auto';
  element.muted = true;
  if (element instanceof HTMLVideoElement) {
    element.playsInline = true;
    element.setAttribute('aria-hidden', 'true');
    // CSSOM writes are allowed under our CSP (only style attributes in markup are not).
    element.style.position = 'fixed';
    element.style.left = '-10000px';
    element.style.top = '0';
    element.style.width = '1px';
    element.style.height = '1px';
    element.style.opacity = '0';
    element.style.pointerEvents = 'none';
    document.body.append(element);
  }

  const href = URL.createObjectURL(blob);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    element.removeAttribute('src');
    element.load();
    element.remove();
    URL.revokeObjectURL(href);
  };

  try {
    element.src = href;
    if (element.readyState < HTMLMediaElement.HAVE_METADATA) {
      const outcome = await waitForEvent(
        element,
        ['loadedmetadata', 'error'],
        MEDIA_TIMEOUT_MS,
        signal,
      );
      if (outcome === 'error') throw describeError(element, kind);
    }
    if (element.duration === Infinity) await resolveDuration(element);
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    element: element as K extends 'audio' ? HTMLAudioElement : HTMLVideoElement,
    dispose,
  };
}

/** Seeks far past the end so the browser works out the real length, then rewinds. */
async function resolveDuration(element: HTMLMediaElement): Promise<void> {
  const known = (): boolean => Number.isFinite(element.duration);
  const settled = waitForEvent(element, ['durationchange', 'timeupdate'], 5000).catch(() => '');
  element.currentTime = 1e101;
  await settled;
  if (!known()) await waitForEvent(element, ['durationchange', 'timeupdate'], 5000).catch(() => '');
  element.currentTime = 0;
}

/** Duration in seconds of an audio or video Blob, read by the browser. */
export async function mediaDuration(blob: Blob, kind: 'audio' | 'video'): Promise<number> {
  const { element, dispose } = await openMedia(blob, kind);
  try {
    return Number.isFinite(element.duration) ? element.duration : 0;
  } finally {
    dispose();
  }
}
