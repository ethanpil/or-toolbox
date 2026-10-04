// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readImageHeader } from './image-header';
import { gifFile, jpegFile, pngFile, webpFile } from './image-test-files';

const blob = (bytes: Uint8Array, type = ''): Blob => new Blob([bytes as BlobPart], { type });

describe('readImageHeader', () => {
  it('reads the size of a PNG, with or without an eXIf orientation', async () => {
    expect(await readImageHeader(blob(pngFile(640, 480)))).toEqual({
      type: 'image/png',
      width: 640,
      height: 480,
      orientation: 1,
    });
    expect(await readImageHeader(blob(pngFile(64, 32, { orientation: 6 })))).toMatchObject({
      width: 64,
      height: 32,
      orientation: 6,
    });
    // eXIf after a large text chunk, beyond the first 64 KiB window.
    expect(
      await readImageHeader(blob(pngFile(5, 7, { orientation: 8, padding: 100_000 }))),
    ).toMatchObject({ width: 5, height: 7, orientation: 8 });
  });

  it('reads a JPEG frame header, past big metadata segments, and its EXIF orientation', async () => {
    expect(await readImageHeader(blob(jpegFile(4032, 3024)))).toEqual({
      type: 'image/jpeg',
      width: 4032,
      height: 3024,
      orientation: 1,
    });
    for (const littleEndian of [false, true]) {
      expect(
        await readImageHeader(blob(jpegFile(4032, 3024, { orientation: 6, littleEndian }))),
      ).toMatchObject({ width: 4032, height: 3024, orientation: 6 });
    }
    // 200 KB of ICC profile before the frame header; progressive frames carry the size too.
    expect(
      await readImageHeader(
        blob(jpegFile(1200, 800, { orientation: 3, padding: 200_000, progressive: true })),
      ),
    ).toMatchObject({ width: 1200, height: 800, orientation: 3 });
    // An out-of-range orientation counts as none.
    expect(await readImageHeader(blob(jpegFile(10, 10, { orientation: 42 })))).toMatchObject({
      orientation: 1,
    });
  });

  it('reads lossy, lossless and extended WebP, and the EXIF chunk after the image data', async () => {
    expect(await readImageHeader(blob(webpFile('VP8 ', 1023, 767)))).toEqual({
      type: 'image/webp',
      width: 1023,
      height: 767,
      orientation: 1,
    });
    expect(await readImageHeader(blob(webpFile('VP8L', 16383, 1)))).toMatchObject({
      width: 16383,
      height: 1,
    });
    expect(await readImageHeader(blob(webpFile('VP8X', 3000, 2000)))).toMatchObject({
      width: 3000,
      height: 2000,
      orientation: 1,
    });
    expect(
      await readImageHeader(
        blob(webpFile('VP8X', 300, 200, { orientation: 6, littleEndian: true, padding: 150_001 })),
      ),
    ).toMatchObject({ width: 300, height: 200, orientation: 6 });
    expect(
      await readImageHeader(blob(webpFile('VP8X', 300, 200, { orientation: 5, exifPrefix: true }))),
    ).toMatchObject({ orientation: 5 });
  });

  it('reads the logical screen size of a GIF', async () => {
    expect(await readImageHeader(blob(gifFile(320, 240)))).toEqual({
      type: 'image/gif',
      width: 320,
      height: 240,
      orientation: 1,
    });
  });

  it('goes by the bytes, not the declared type', async () => {
    expect(await readImageHeader(blob(pngFile(3, 2), 'image/jpeg'))).toMatchObject({
      type: 'image/png',
    });
  });

  it('returns null for other formats, truncated headers and empty sizes', async () => {
    const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"/>']);
    expect(await readImageHeader(svg)).toBeNull();
    expect(await readImageHeader(new Blob([]))).toBeNull();
    expect(await readImageHeader(blob(jpegFile(30, 20).slice(0, 40)))).toBeNull();
    expect(await readImageHeader(blob(pngFile(30, 20).slice(0, 20)))).toBeNull();
    expect(await readImageHeader(blob(webpFile('VP8 ', 30, 20).slice(0, 26)))).toBeNull();
    expect(await readImageHeader(blob(pngFile(0, 20)))).toBeNull();
    expect(await readImageHeader(blob(gifFile(0, 0)))).toBeNull();
  });
});
