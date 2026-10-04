/**
 * Moving pixels between files and the pipeline, with the browser's own decoders and encoders (no pixel loops
 * on the page: the pipeline itself runs in the worker through `isolateImage`). Browser only; the unit tests
 * replace this module.
 */
import { InvalidInputError } from '../../core/errors';
import {
  imageDataFrom,
  loadImage,
  toBlob,
  toDataUrl,
  type RasterImage,
} from '../../core/media/image';
import type { OutputFormat } from './options';

/** The largest request body the providers take comfortably; bigger photos are re-encoded smaller. */
const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;

/** A photo as the `data:` URL sent to the model, at most `maxSide` pixels on its longer side. */
export function referenceDataUrl(photo: Blob, maxSide: number): Promise<string> {
  return toDataUrl(photo, {
    maxDimension: maxSide,
    maxBytes: MAX_REFERENCE_BYTES,
    type: 'image/jpeg',
    quality: 0.92,
  });
}

/** Decodes an image file to RGBA pixels. */
export async function decodeRaster(blob: Blob): Promise<RasterImage> {
  const source = await loadImage(blob);
  try {
    return imageDataFrom(source);
  } finally {
    if ('close' in source) source.close();
  }
}

/** Encodes pixels as JPG (`quality` 0-1) or PNG, through a bitmap so nothing loops over pixels here. */
export async function encodeRaster(
  raster: RasterImage,
  format: OutputFormat,
  quality: number,
): Promise<Blob> {
  const bitmap = await createImageBitmap(new ImageData(raster.data, raster.width, raster.height));
  try {
    return await toBlob(
      bitmap,
      format === 'png' ? { type: 'image/png' } : { type: 'image/jpeg', quality },
    );
  } finally {
    bitmap.close();
  }
}

/** A sample product photo for `?sample=1`: a mug with a white label on a busy table. */
export async function samplePhoto(): Promise<File> {
  const width = 960;
  const height = 720;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new InvalidInputError('This browser could not draw the sample.');
  const wall = context.createLinearGradient(0, 0, 0, height);
  wall.addColorStop(0, '#c9b79c');
  wall.addColorStop(0.62, '#a98f6d');
  wall.addColorStop(0.62, '#6e5137');
  wall.addColorStop(1, '#4d3825');
  context.fillStyle = wall;
  context.fillRect(0, 0, width, height);
  // Clutter the model has to remove: a plant pot and a book.
  context.fillStyle = '#3f6b3a';
  context.beginPath();
  context.ellipse(150, 330, 90, 120, 0, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#8a4b2a';
  context.fillRect(100, 400, 100, 90);
  context.fillStyle = '#2c4a7a';
  context.fillRect(700, 420, 200, 60);
  // The mug: body, handle, white label with a logo.
  context.fillStyle = '#0f766e';
  context.beginPath();
  context.roundRect(380, 250, 220, 260, 24);
  context.fill();
  context.lineWidth = 34;
  context.strokeStyle = '#0f766e';
  context.beginPath();
  context.arc(610, 380, 62, -Math.PI / 2, Math.PI / 2);
  context.stroke();
  context.fillStyle = '#fafafa';
  context.fillRect(410, 320, 160, 110);
  context.fillStyle = '#b91c1c';
  context.font = 'bold 44px sans-serif';
  context.textAlign = 'center';
  context.fillText('ORT', 490, 392);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new InvalidInputError('This browser could not draw the sample.');
  return new File([blob], 'sample-mug.png', { type: 'image/png' });
}
