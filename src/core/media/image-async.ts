/**
 * `isolateImage`: the isolated-image pipeline (bounding box, square, white
 * fill, sharpen, QA; see image-pipeline.ts) run in a module worker, so a
 * 2000 x 2000 image costs the page nothing but two memory copies. On a
 * machine without worker support, or if the worker fails to start, the same
 * code runs on the page instead, in a macrotask of its own.
 *
 * One image at a time goes to the worker, in the order asked. Aborting a job
 * that is still waiting simply removes it; aborting the one the worker is busy
 * with terminates the worker (a new one starts for the next job), because
 * a running pipeline cannot be interrupted.
 */
import { InvalidInputError } from '../errors';
import { abortError } from '../util';
import type { RasterImage } from './image';
import { type IsolateOptions, type IsolateResult, isolateRaster } from './image-pipeline';
import type { WorkerRequest, WorkerResponse } from './image-worker';

export interface IsolateJobOptions {
  /** Aborting rejects with an `AbortError`. */
  signal?: AbortSignal;
  /**
   * Hand the image's pixel buffer to the worker instead of copying it. Faster
   * and lighter, but the buffer is emptied: `image.data` has no bytes after the
   * call. Default false, so the same source can be processed again with other
   * settings.
   */
  transfer?: boolean;
}

interface Job {
  id: number;
  image: RasterImage;
  options: IsolateOptions;
  transfer: boolean;
  signal: AbortSignal | undefined;
  resolve: (result: IsolateResult) => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
}

const waiting: Job[] = [];
let current: Job | undefined;
/** The worker; `undefined` before the first job and after an abort, `null` when workers do not work here. */
let worker: Worker | null | undefined;
let nextId = 0;

function startWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === 'undefined') return (worker = null);
  try {
    const started = new Worker(new URL('./image-worker.ts', import.meta.url), { type: 'module' });
    started.onmessage = (event: MessageEvent<WorkerResponse>): void => {
      const response = event.data;
      if (current?.id !== response.id) return;
      const job = current;
      finish(job);
      if (response.ok) job.resolve(response.result);
      else job.reject(new InvalidInputError(response.message));
    };
    // Only failures of the worker itself reach here (script blocked, crashed at load): the pipeline's own
    // errors come back as messages. Run this job and all later ones on the page instead.
    started.onerror = (event: ErrorEvent): void => {
      event.preventDefault();
      started.terminate();
      if (worker === started) worker = null;
      const job = current;
      current = undefined;
      if (job) waiting.unshift(job);
      pump();
    };
    return (worker = started);
  } catch {
    return (worker = null);
  }
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
  const active = startWorker();
  if (!active) {
    // No worker: run here, after yielding so the page can paint first.
    setTimeout(() => {
      if (current !== job) return; // aborted while waiting for its turn on the page
      try {
        const result = isolateRaster(job.image, job.options);
        finish(job);
        job.resolve(result);
      } catch (error) {
        finish(job);
        job.reject(error);
      }
    }, 0);
    return;
  }
  const request: WorkerRequest = {
    id: job.id,
    op: 'isolate',
    image: job.image,
    options: job.options,
  };
  try {
    active.postMessage(request, job.transfer ? [job.image.data.buffer] : []);
  } catch (error) {
    finish(job);
    job.reject(error);
  }
}

/**
 * Runs the isolated-image pipeline on `image` (see `isolateRaster` and
 * `IsolateOptions`) in a worker and resolves with the square result, the box
 * that was kept and the QA check. Needs a browser for the worker and canvas;
 * elsewhere it runs on the calling thread.
 */
export function isolateImage(
  image: RasterImage,
  options: IsolateOptions = {},
  job: IsolateJobOptions = {},
): Promise<IsolateResult> {
  if (job.signal?.aborted) return Promise.reject(abortError());
  return new Promise<IsolateResult>((resolve, reject) => {
    const entry: Job = {
      id: ++nextId,
      image,
      options,
      transfer: job.transfer ?? false,
      signal: job.signal,
      resolve,
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
