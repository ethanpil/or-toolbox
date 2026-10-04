/**
 * Heavy image work in a module worker (image-worker.ts), so the page stays responsive: the isolated-image
 * pipeline (`isolateImage`, 2000 x 2000 costs the page nothing but two memory copies) and the Image editor's
 * mask work (`maskOverlayAsync`, `maskToRasterAsync`, `featherInsideAsync`, `compositeMaskedAsync`). Each
 * resolves with exactly what the pure function of the same name returns (image-ops.ts runs them). Where no
 * worker can run, the same code runs on the page instead, in a macrotask of its own.
 *
 * One job at a time goes to the worker, in the order asked. Aborting a job that is still waiting simply
 * removes it; aborting the one the worker is busy with terminates the worker (a new one starts for the next
 * job), because a running operation cannot be interrupted.
 *
 * Failures: a worker that fails (script blocked, crashed) is dropped and its job runs on the page; the next job
 * starts a new worker. Only after `MAX_WORKER_FAILURES` failures with no answer in between does the page do
 * all the work for the rest of the session. Pixels are transferred (when asked) only to a worker that has
 * already answered a job, so a worker that fails to start never holds the only copy and the page re-runs the
 * job on the caller's pixels. If a worker that had answered dies while holding a transferred job, that job
 * cannot be re-run: it is rejected (`InvalidInputError`), and trying again uses a new worker.
 */
import { InvalidInputError } from '../errors';
import { abortError } from '../util';
import type { Mask, RasterImage, Rgb } from './image';
import {
  type ImageOpOutput,
  type ImageOpOutputs,
  type ImageOpRequest,
  pixelBuffers,
  runImageOp,
} from './image-ops';
import type { IsolateOptions, IsolateResult } from './image-pipeline';
import type { WorkerRequest, WorkerResponse } from './image-worker';

export interface ImageJobOptions {
  /** Aborting rejects with an `AbortError`. */
  signal?: AbortSignal;
  /**
   * Hand the pixel buffers of the inputs (every image and mask passed in) to the worker instead of copying
   * them. Faster and lighter, but they may be emptied: their `data` can have no bytes after the call. (A
   * worker's first job is copied anyway, until it has shown that it runs.) Default false, so the same inputs
   * can be used again.
   */
  transfer?: boolean;
}

/** `isolateImage`'s options: those of every job. */
export type IsolateJobOptions = ImageJobOptions;

/** Worker failures in a row (no answer between them) after which the page does all the work. */
export const MAX_WORKER_FAILURES = 3;

interface Job {
  id: number;
  request: ImageOpRequest;
  transfer: boolean;
  /** Its pixels were handed to the worker: the page can no longer run it. */
  transferred: boolean;
  /** Its worker failed: it runs on the page. */
  onPage: boolean;
  signal: AbortSignal | undefined;
  resolve: (result: ImageOpOutput) => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
}

const waiting: Job[] = [];
let current: Job | undefined;
/** The worker; `undefined` before the first job and after an abort or a failure. */
let worker: Worker | undefined;
/** `worker` has answered a job, so it is known to run: only then are pixels transferred to it. */
let proven = false;
/** Worker failures since the last answer. */
let failures = 0;
/** Workers cannot run here, or failed too often: every job runs on the page. */
let pageOnly = false;
let nextId = 0;

function workerFailed(): void {
  failures += 1;
  if (failures >= MAX_WORKER_FAILURES) pageOnly = true;
}

function startWorker(): Worker | null {
  if (worker) return worker;
  if (pageOnly) return null;
  if (typeof Worker === 'undefined') {
    pageOnly = true;
    return null;
  }
  let started: Worker;
  try {
    started = new Worker(new URL('./image-worker.ts', import.meta.url), { type: 'module' });
  } catch {
    workerFailed();
    return null;
  }
  started.onmessage = (event: MessageEvent<WorkerResponse>): void => {
    if (worker !== started) return;
    proven = true;
    failures = 0;
    const response = event.data;
    if (current?.id !== response.id) return;
    const job = current;
    finish(job);
    if (response.ok) job.resolve(response.result);
    else job.reject(new InvalidInputError(response.message));
  };
  // Only failures of the worker itself reach here (script blocked, crashed at load or out of memory): an
  // operation's own errors come back as messages.
  started.onerror = (event: ErrorEvent): void => {
    event.preventDefault();
    started.terminate();
    if (worker !== started) return;
    worker = undefined;
    workerFailed();
    const job = current;
    if (!job) return;
    current = undefined;
    if (job.transferred) {
      finish(job);
      job.reject(new InvalidInputError('The image worker stopped before it finished. Try again.'));
      return;
    }
    job.onPage = true;
    waiting.unshift(job);
    pump();
  };
  proven = false;
  return (worker = started);
}

function finish(job: Job): void {
  job.signal?.removeEventListener('abort', job.onAbort);
  if (current === job) current = undefined;
  pump();
}

function pump(): void {
  if (current) return;
  const job = waiting.shift();
  if (!job) return;
  current = job;
  const active = job.onPage ? null : startWorker();
  if (!active) {
    // No worker: run here, after yielding so the page can paint first.
    setTimeout(() => {
      if (current !== job) return; // aborted while waiting for its turn on the page
      try {
        const result = runImageOp(job.request);
        finish(job);
        job.resolve(result);
      } catch (error) {
        finish(job);
        job.reject(error);
      }
    }, 0);
    return;
  }
  const transfer = job.transfer && proven;
  const request: WorkerRequest = { ...job.request, id: job.id };
  try {
    active.postMessage(request, transfer ? pixelBuffers(job.request) : []);
    job.transferred = transfer;
  } catch (error) {
    finish(job);
    job.reject(error);
  }
}

function enqueue<R extends ImageOpRequest>(
  request: R,
  job: ImageJobOptions,
): Promise<ImageOpOutputs[R['op']]> {
  if (job.signal?.aborted) return Promise.reject(abortError());
  return new Promise<ImageOpOutputs[R['op']]>((resolve, reject) => {
    const entry: Job = {
      id: ++nextId,
      request,
      transfer: job.transfer ?? false,
      transferred: false,
      onPage: false,
      signal: job.signal,
      // The worker and the page answer a request with its op's output (image-ops.ts).
      resolve: resolve as (result: ImageOpOutput) => void,
      reject,
      onAbort: () => {
        const waitingAt = waiting.indexOf(entry);
        if (waitingAt >= 0) {
          waiting.splice(waitingAt, 1);
        } else if (current === entry) {
          // The worker is mid-computation: the only way to stop it is to end it.
          if (worker) {
            worker.terminate();
            worker = undefined;
          }
          current = undefined;
          pump();
        }
        reject(abortError());
      },
    };
    entry.signal?.addEventListener('abort', entry.onAbort, { once: true });
    waiting.push(entry);
    pump();
  });
}

/**
 * Runs the isolated-image pipeline on `image` (see `isolateRaster` and `IsolateOptions`) in a worker and
 * resolves with the square result, the box that was kept and the QA check. Needs a browser for the worker
 * and canvas; elsewhere it runs on the calling thread.
 */
export function isolateImage(
  image: RasterImage,
  options: IsolateOptions = {},
  job: ImageJobOptions = {},
): Promise<IsolateResult> {
  return enqueue({ op: 'isolate', image, options }, job);
}

/** `maskOverlay` (image.ts) in the worker: the picture with the masked area tinted, the marked reference. */
export function maskOverlayAsync(
  image: RasterImage,
  mask: Mask,
  colour: string | Rgb = '#FF0000',
  alpha = 0.5,
  job: ImageJobOptions = {},
): Promise<RasterImage> {
  return enqueue({ op: 'maskOverlay', image, mask, colour, alpha }, job);
}

/** `maskToRaster` (image.ts) in the worker: the mask as an opaque black-and-white picture. */
export function maskToRasterAsync(mask: Mask, job: ImageJobOptions = {}): Promise<RasterImage> {
  return enqueue({ op: 'maskToRaster', mask }, job);
}

/** `featherInside` (image.ts) in the worker: the mask with a soft inner edge of `radius` pixels. */
export function featherInsideAsync(
  mask: Mask,
  radius: number,
  job: ImageJobOptions = {},
): Promise<Mask> {
  return enqueue({ op: 'featherInside', mask, radius }, job);
}

export interface CompositeMaskedOptions {
  /** Soften the mask's inner edge by this many pixels first (`featherInside`). Default 0: the mask as it is. */
  feather?: number;
}

/**
 * `compositeMasked(original, result, featherInside(mask, feather))` (image.ts) in the worker, feather
 * included: the result inside the mask, the original exactly outside it ("Keep outside the mask").
 */
export function compositeMaskedAsync(
  original: RasterImage,
  result: RasterImage,
  mask: Mask,
  options: CompositeMaskedOptions = {},
  job: ImageJobOptions = {},
): Promise<RasterImage> {
  return enqueue(
    { op: 'compositeMasked', original, result, mask, feather: options.feather ?? 0 },
    job,
  );
}

/** Ends the worker (it restarts on the next job). Jobs still waiting or running are rejected as aborted. */
export function disposeImageWorker(): void {
  for (const job of [...waiting, ...(current ? [current] : [])]) {
    job.signal?.removeEventListener('abort', job.onAbort);
    job.reject(abortError());
  }
  waiting.length = 0;
  current = undefined;
  if (worker) {
    worker.terminate();
    worker = undefined;
  }
}
