/**
 * The pixel operations the image worker runs, as one table that the worker (image-worker.ts) and the page
 * fallback (image-async.ts) both call, so the two can never compute different things. Pure.
 */
import {
  compositeMasked,
  featherInside,
  type Mask,
  maskOverlay,
  maskToRaster,
  type RasterImage,
  type Rgb,
} from './image';
import { type IsolateOptions, type IsolateResult, isolateRaster } from './image-pipeline';

export type ImageOpRequest =
  | { op: 'isolate'; image: RasterImage; options: IsolateOptions }
  | { op: 'maskOverlay'; image: RasterImage; mask: Mask; colour: string | Rgb; alpha: number }
  | { op: 'maskToRaster'; mask: Mask }
  | { op: 'featherInside'; mask: Mask; radius: number }
  | {
      op: 'compositeMasked';
      original: RasterImage;
      result: RasterImage;
      mask: Mask;
      /** `featherInside` radius applied to `mask` first; 0 uses it as it is. */
      feather: number;
    };

export interface ImageOpOutputs {
  isolate: IsolateResult;
  maskOverlay: RasterImage;
  maskToRaster: RasterImage;
  featherInside: Mask;
  compositeMasked: RasterImage;
}

export type ImageOpOutput = ImageOpOutputs[keyof ImageOpOutputs];

function run(request: ImageOpRequest): ImageOpOutput {
  switch (request.op) {
    case 'isolate':
      return isolateRaster(request.image, request.options);
    case 'maskOverlay':
      return maskOverlay(request.image, request.mask, request.colour, request.alpha);
    case 'maskToRaster':
      return maskToRaster(request.mask);
    case 'featherInside':
      return featherInside(request.mask, request.radius);
    case 'compositeMasked':
      return compositeMasked(
        request.original,
        request.result,
        request.feather > 0 ? featherInside(request.mask, request.feather) : request.mask,
      );
  }
}

/** Runs one operation on the calling thread. */
export function runImageOp<R extends ImageOpRequest>(request: R): ImageOpOutputs[R['op']] {
  // `run` returns the output of the op it was given; TypeScript cannot follow that through the switch.
  return run(request) as ImageOpOutputs[R['op']];
}

const isPixels = (value: unknown): value is RasterImage | Mask =>
  typeof value === 'object' &&
  value !== null &&
  'data' in value &&
  (value.data instanceof Uint8ClampedArray || value.data instanceof Uint8Array);

/**
 * The pixel buffers of the images and masks in a request or an output (top level and one level down, as in
 * `IsolateResult.image`), each once, for a `postMessage` transfer list. A typed array that is a window on a
 * larger buffer is left out: transferring would take the rest of that buffer from its owner too, so it is
 * copied instead.
 */
export function pixelBuffers(value: ImageOpRequest | ImageOpOutput): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const part of [value, ...(Object.values(value) as unknown[])]) {
    if (!isPixels(part)) continue;
    const { data } = part;
    if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength)
      buffers.add(data.buffer);
  }
  return [...buffers];
}
