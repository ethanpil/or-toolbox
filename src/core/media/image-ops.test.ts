// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createRaster, type Mask } from './image';
import { pixelBuffers, runImageOp } from './image-ops';

describe('pixelBuffers', () => {
  it('lists each image and mask buffer of a request once', () => {
    const image = createRaster(4, 3);
    const mask: Mask = { width: 4, height: 3, data: new Uint8Array(12) };
    expect(
      pixelBuffers({ op: 'compositeMasked', original: image, result: image, mask, feather: 0 }),
    ).toEqual([image.data.buffer, mask.data.buffer]);
  });

  it('finds the image inside an isolate result', () => {
    const result = runImageOp({ op: 'isolate', image: createRaster(6, 6), options: { size: 8 } });
    expect(pixelBuffers(result)).toEqual([result.image.data.buffer]);
  });

  it('leaves out a view on a larger buffer, which must be copied, not taken from its owner', () => {
    const shared = new Uint8Array(100);
    const mask: Mask = { width: 4, height: 3, data: shared.subarray(10, 22) };
    expect(pixelBuffers({ op: 'maskToRaster', mask })).toEqual([]);
  });
});
