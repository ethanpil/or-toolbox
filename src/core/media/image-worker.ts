/**
 * Module worker that runs the image operations of image-ops.ts (the isolated-image pipeline, the editor's mask
 * work) off the main thread. Started by image-async.ts (`new Worker(new URL('./image-worker.ts',
 * import.meta.url), { type: 'module' })`: a same-origin script, so `worker-src 'self'` allows it).
 * Do not import this file for its code; import the functions of image-async.ts instead.
 */
import { type ImageOpOutput, type ImageOpRequest, pixelBuffers, runImageOp } from './image-ops';

export type WorkerRequest = ImageOpRequest & { id: number };

export type WorkerResponse =
  { id: number; ok: true; result: ImageOpOutput } | { id: number; ok: false; message: string };

self.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const request = event.data;
  try {
    const result = runImageOp(request);
    const response: WorkerResponse = { id: request.id, ok: true, result };
    // The result's pixels move to the page instead of being copied.
    self.postMessage(response, { transfer: pixelBuffers(result) });
  } catch (error) {
    const response: WorkerResponse = {
      id: request.id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};
