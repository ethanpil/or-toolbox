/**
 * Loads ffmpeg.wasm on demand.
 *
 * Two builds of the ffmpeg core are self-hosted under `vendor/ffmpeg/`
 * (copied from node_modules by vite-plugins/ffmpeg-assets.ts):
 *
 * - multi-threaded: needs SharedArrayBuffer, which browsers only provide on
 *   cross-origin isolated pages (the service worker arranges that);
 * - single-threaded: works everywhere, slower. The fallback, also used for
 *   the rest of the page session once the multi-threaded core has failed.
 *
 * How the pieces load, and why no CSP exception beyond 'wasm-unsafe-eval' is
 * needed:
 *
 * 1. `@ffmpeg/ffmpeg` starts its own *module* worker from a bundled,
 *    same-origin chunk (Vite rewrites its `new Worker(new URL(...))`).
 * 2. That worker `import()`s `ffmpeg-core.js` from the same-origin URL we
 *    pass as `coreURL` (the ESM build, because a module worker cannot use
 *    importScripts).
 * 3. The core instantiates `ffmpeg-core.wasm`. We download it here first, to
 *    report progress, and hand it over as a `blob:` URL (allowed by
 *    `connect-src`), so it is downloaded exactly once.
 * 4. The multi-threaded core starts its pthread workers from the same-origin
 *    `ffmpeg-core.worker.js`.
 *
 * Nothing is loaded as a `blob:` script or worker, unlike the usual
 * `toBlobURL` recipe, which exists for cores hosted on a CDN.
 */
import type { FFmpeg } from '@ffmpeg/ffmpeg';
import { NetworkError } from '../errors';
import { url } from '../paths';

export interface FfmpegDownloadProgress {
  /** Bytes of the core downloaded so far. */
  loaded: number;
  /** Size of the core in bytes (about 32 MB). */
  total: number;
}

export interface LoadFfmpegOptions {
  /**
   * Called while the core downloads. Only the call that starts the load
   * reports progress; later calls get the already-loaded instance.
   */
  onProgress?: (progress: FfmpegDownloadProgress) => void;
  /** Use the single-threaded core even where threads are available. For diagnostics. */
  singleThread?: boolean;
}

export interface LoadedFfmpeg {
  ffmpeg: FFmpeg;
  /** Which core is running. */
  multiThreaded: boolean;
}

/** How long the core may take to start once downloaded (compiling 32 MB of wasm, starting threads). */
const INIT_TIMEOUT_MS = 60_000;

/** True if this page can run the multi-threaded core. */
export function threadsAvailable(): boolean {
  return globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';
}

/** One instance per core per page; ffmpeg is expensive to load. Never holds a rejected load. */
const instances = new Map<boolean, Promise<LoadedFfmpeg>>();

/** Set once the multi-threaded core has failed to start; the page then sticks to the other one. */
let multiThreadFailed = false;

/**
 * Returns a ready ffmpeg instance: the multi-threaded core when the page is
 * cross-origin isolated, the single-threaded core otherwise (or when the
 * multi-threaded one fails to start).
 *
 * ```ts
 * const { ffmpeg, multiThreaded } = await loadFfmpeg({ onProgress });
 * await ffmpeg.writeFile('in.webm', bytes);
 * await ffmpeg.exec(['-i', 'in.webm', 'out.mp4']);
 * const mp4 = await ffmpeg.readFile('out.mp4');
 * ```
 *
 * Calling `ffmpeg.terminate()` on the instance, or an `exec` that crashes the
 * core, retires it; the next `loadFfmpeg()` starts a fresh one.
 */
export async function loadFfmpeg(options: LoadFfmpegOptions = {}): Promise<LoadedFfmpeg> {
  const wantThreads = !options.singleThread && !multiThreadFailed && threadsAvailable();
  if (!wantThreads) return instance(false, options.onProgress);
  try {
    return await instance(true, options.onProgress);
  } catch {
    multiThreadFailed = true;
    return instance(false, options.onProgress);
  }
}

/** Terminates every ffmpeg instance of this page and frees its memory. */
export function disposeFfmpeg(): void {
  const pending = [...instances.values()];
  instances.clear();
  for (const loading of pending) {
    loading.then(({ ffmpeg }) => ffmpeg.terminate()).catch(() => undefined);
  }
}

/** The cached instance for one core, or a new one if there is none or it is no longer usable. */
async function instance(
  multiThreaded: boolean,
  onProgress: LoadFfmpegOptions['onProgress'],
): Promise<LoadedFfmpeg> {
  const existing = instances.get(multiThreaded);
  if (existing) {
    const loaded = await existing.catch(() => null);
    if (loaded?.ffmpeg.loaded) return loaded;
    if (instances.get(multiThreaded) === existing) instances.delete(multiThreaded);
  }

  const loading = load(multiThreaded, onProgress);
  instances.set(multiThreaded, loading);
  loading.catch(() => {
    if (instances.get(multiThreaded) === loading) instances.delete(multiThreaded);
  });
  return loading;
}

async function load(
  multiThreaded: boolean,
  onProgress: LoadFfmpegOptions['onProgress'],
): Promise<LoadedFfmpeg> {
  const core = multiThreaded ? __FFMPEG_ASSETS__.multiThread : __FFMPEG_ASSETS__.singleThread;
  // Absolute URLs: the worker resolves them from its own location otherwise.
  const file = (name: string): string => new URL(url(core.dir + name), location.href).href;

  const [{ FFmpeg }, wasm] = await Promise.all([
    import('@ffmpeg/ffmpeg'),
    download(file('ffmpeg-core.wasm'), core.wasmBytes, onProgress),
  ]);

  const ffmpeg = new FFmpeg();
  const wasmURL = URL.createObjectURL(wasm);
  try {
    await ffmpeg.load(
      {
        coreURL: file('ffmpeg-core.js'),
        wasmURL,
        ...(multiThreaded ? { workerURL: file('ffmpeg-core.worker.js') } : {}),
      },
      { signal: AbortSignal.timeout(INIT_TIMEOUT_MS) },
    );
  } catch (error) {
    ffmpeg.terminate();
    throw asError(error, 'ffmpeg failed to start');
  } finally {
    URL.revokeObjectURL(wasmURL);
  }

  retireOnFailure(ffmpeg, multiThreaded);
  return { ffmpeg, multiThreaded };
}

/**
 * Makes sure a dead instance is never handed out again: `terminate()` drops
 * it from the cache, and an `exec`/`ffprobe` that fails (rather than merely
 * returning a non-zero exit code) means the core crashed, so it is terminated.
 */
function retireOnFailure(ffmpeg: FFmpeg, multiThreaded: boolean): void {
  const terminate = ffmpeg.terminate;
  ffmpeg.terminate = () => {
    void instances.get(multiThreaded)?.then(
      (loaded) => {
        if (loaded.ffmpeg === ffmpeg) instances.delete(multiThreaded);
      },
      () => undefined,
    );
    terminate();
  };

  for (const method of ['exec', 'ffprobe'] as const) {
    const run = ffmpeg[method];
    ffmpeg[method] = async (...args: Parameters<FFmpeg['exec']>) => {
      try {
        return await run(...args);
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === 'AbortError';
        if (!aborted && ffmpeg.loaded) ffmpeg.terminate();
        throw asError(error, `ffmpeg ${method} failed`);
      }
    };
  }
}

/** The worker reports failures as plain strings. */
function asError(error: unknown, context: string): Error {
  return error instanceof Error ? error : new Error(`${context}: ${String(error)}`);
}

/** Downloads a file, reporting progress against a size known at build time. */
async function download(
  href: string,
  total: number,
  onProgress: LoadFfmpegOptions['onProgress'],
): Promise<Blob> {
  const response = await fetch(href);
  if (!response.ok) {
    throw new NetworkError(
      'Could not download the audio and video engine. Check your connection and reload the page.',
      { cause: new Error(`${href}: HTTP ${response.status}`) },
    );
  }

  const type = 'application/wasm';
  if (!response.body) return new Blob([await response.arrayBuffer()], { type });

  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({ loaded, total });
  }
  return new Blob(chunks, { type });
}
