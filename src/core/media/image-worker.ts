/**
 * Module worker that runs the isolated-image pipeline off the main thread.
 * Started by image-async.ts (`new Worker(new URL('./image-worker.ts', import.meta.url),
 * { type: 'module' })`: a same-origin script, so `worker-src 'self'` allows it).
 * Do not import this file for its code; import `isolateImage` instead.
 */
import type { RasterImage } from './image';
import { type IsolateOptions, type IsolateResult, isolateRaster } from './image-pipeline';

export interface WorkerRequest {
  id: number;
  op: 'isolate';
  image: RasterImage;
  options: IsolateOptions;
}

export type WorkerResponse =
  { id: number; ok: true; result: IsolateResult } | { id: number; ok: false; message: string };

self.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const { id, image, options } = event.data;
  try {
    const result = isolateRaster(image, options);
    const response: WorkerResponse = { id, ok: true, result };
    // The result's pixels move to the page instead of being copied.
    self.postMessage(response, { transfer: [result.image.data.buffer] });
  } catch (error) {
    const response: WorkerResponse = {
      id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};
