/**
 * Loads ffmpeg.wasm on demand.
 *
 * Two builds of the ffmpeg core are self-hosted under `vendor/ffmpeg/`
 * (copied from node_modules by vite-plugins/ffmpeg-assets.ts):
 *
 * - multi-threaded: needs SharedArrayBuffer, which browsers only provide on
 *   cross-origin isolated pages (the service worker arranges that);
 * - single-threaded: works everywhere, slower. The fallback.
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

/** True if this page can run the multi-threaded core. */
export function threadsAvailable(): boolean {
  return globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';
}

/** One instance per core per page; ffmpeg is expensive to load. */
const instances = new Map<boolean, Promise<LoadedFfmpeg>>();

/**
 * Returns a ready ffmpeg instance: the multi-threaded core when the page is
 * cross-origin isolated, the single-threaded core otherwise.
 *
 * ```ts
 * const { ffmpeg, multiThreaded } = await loadFfmpeg({ onProgress });
 * await ffmpeg.writeFile('in.webm', bytes);
 * await ffmpeg.exec(['-i', 'in.webm', 'out.mp4']);
 * const mp4 = await ffmpeg.readFile('out.mp4');
 * ```
 */
export function loadFfmpeg(options: LoadFfmpegOptions = {}): Promise<LoadedFfmpeg> {
  const multiThreaded = !options.singleThread && threadsAvailable();

  let instance = instances.get(multiThreaded);
  if (!instance) {
    instance = load(multiThreaded, options.onProgress).catch((error: unknown) => {
      instances.delete(multiThreaded); // let the next call try again
      throw error;
    });
    instances.set(multiThreaded, instance);
  }
  return instance;
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
    await ffmpeg.load({
      coreURL: file('ffmpeg-core.js'),
      wasmURL,
      ...(multiThreaded ? { workerURL: file('ffmpeg-core.worker.js') } : {}),
    });
  } catch (error) {
    ffmpeg.terminate();
    // The worker reports failures as plain strings.
    throw error instanceof Error ? error : new Error(`ffmpeg failed to load: ${String(error)}`);
  } finally {
    URL.revokeObjectURL(wasmURL);
  }

  return { ffmpeg, multiThreaded };
}

/** Downloads a file, reporting progress against a size known at build time. */
async function download(
  href: string,
  total: number,
  onProgress: LoadFfmpegOptions['onProgress'],
): Promise<Blob> {
  const response = await fetch(href);
  if (!response.ok) throw new Error(`Could not download ${href}: HTTP ${response.status}`);

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
