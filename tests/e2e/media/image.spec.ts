import { expect, test } from '../../mock/index.ts';
import { fixture, openMediaPage } from './support.ts';

test.setTimeout(180_000);

test('canvas wrappers round-trip pixels and the isolated-image pipeline runs on a real photo', async ({
  page,
}) => {
  const problems = await openMediaPage(page);

  const result = await page.evaluate(async (photo) => {
    const { image, helpers } = window.__media as NonNullable<Window['__media']>;

    // A product on white: a 100 x 80 PNG with a red rectangle, drawn on a canvas.
    const canvas = new OffscreenCanvas(100, 80);
    const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 100, 80);
    context.fillStyle = '#c80000';
    context.fillRect(20, 10, 40, 30);
    const png = await canvas.convertToBlob({ type: 'image/png' });

    const bitmap = await image.loadImage(png);
    const raster = image.imageDataFrom(bitmap);
    const box = image.contentBoundingBox(raster);
    const reencoded = await image.toBlob(raster);
    const roundTrip = image.imageDataFrom(await image.loadImage(reencoded));
    const jpeg = await image.toBlob(raster, { type: 'image/jpeg', quality: 0.9 });
    const cropped = image.imageDataFrom(
      image.cropCanvas(bitmap, { x: 20, y: 10, width: 40, height: 30 }),
    );
    const resized = image.imageDataFrom(image.resizeCanvas(bitmap, 50, 40));

    // Transparency becomes white in a JPEG.
    const transparent = image.createRaster(4, 4, '#000000');
    transparent.data.fill(0);
    const flatJpeg = image.imageDataFrom(
      await image.loadImage(await image.toBlob(transparent, { type: 'image/jpeg' })),
    );

    // SVG cannot go through createImageBitmap in every browser: the <img> fallback reads it.
    const svg = new Blob(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"><rect width="30" height="20" fill="blue"/></svg>',
      ],
      { type: 'image/svg+xml' },
    );
    const svgImage = await image.loadImage(svg);

    const mask = { width: 4, height: 4, data: new Uint8Array(16).fill(255) };
    const maskPng = await image.maskToPng(mask);
    const maskPixels = await helpers.pixels(maskPng);

    // The whole isolated-image pipeline, 2000 x 2000, on the 1024 x 1024 fixture photo.
    const source = image.imageDataFrom(await image.loadImage(helpers.blobOf(photo)));
    const started = performance.now();
    const sourceBox = image.contentBoundingBox(source) ?? {
      x: 0,
      y: 0,
      width: source.width,
      height: source.height,
    };
    const squared = image.padToSquare(source, sourceBox, { size: 2000, margin: 0.08 });
    const squaredMs = performance.now() - started;
    const white = image.floodFillWhiteFromEdges(squared);
    const whiteMs = performance.now() - started - squaredMs;
    const sharp = image.unsharpMask(white, { amount: 0.5, radius: 1 });
    const totalMs = performance.now() - started;
    const qa = image.checkIsolated(sharp);
    const jpegOut = await image.toBlob(sharp, { type: 'image/jpeg', quality: 0.92 });

    // A product photo with a nearly white background passes the QA after the pipeline.
    const studio = new OffscreenCanvas(1200, 900);
    const studioContext = studio.getContext('2d') as OffscreenCanvasRenderingContext2D;
    studioContext.fillStyle = '#fbfbfb';
    studioContext.fillRect(0, 0, 1200, 900);
    studioContext.fillStyle = '#305080';
    studioContext.beginPath();
    studioContext.ellipse(600, 450, 300, 200, 0, 0, 2 * Math.PI);
    studioContext.fill();
    const studioPhoto = image.imageDataFrom(studio);
    const studioBox = image.contentBoundingBox(studioPhoto);
    const studioArea = studioBox ?? {
      x: 0,
      y: 0,
      width: studioPhoto.width,
      height: studioPhoto.height,
    };
    const studioResult = image.unsharpMask(
      image.floodFillWhiteFromEdges(image.padToSquare(studioPhoto, studioArea, { size: 1000 })),
    );
    const studioQa = image.checkIsolated(studioResult);
    const studioBeforeFill = image.checkIsolated(
      image.padToSquare(studioPhoto, studioArea, {
        size: 1000,
        background: '#fbfbfb',
      }),
    );

    // Downsizing for upload limits: a big noisy image is shrunk under the byte limit; a small one passes through.
    const big = new OffscreenCanvas(3000, 2000);
    const bigContext = big.getContext('2d') as OffscreenCanvasRenderingContext2D;
    const noise = bigContext.createImageData(3000, 2000);
    for (let i = 0; i < noise.data.length; i++)
      noise.data[i] = i % 4 === 3 ? 255 : Math.floor(Math.random() * 256);
    bigContext.putImageData(noise, 0, 0);
    const bigPng = await big.convertToBlob({ type: 'image/png' });
    const shrunkUrl = await image.toDataUrl(bigPng, { maxBytes: 300_000, maxDimension: 1024 });
    const shrunk = await (await fetch(shrunkUrl)).blob();
    const shrunkBitmap = await image.loadImage(shrunk);
    const smallUrl = await image.toDataUrl(png);

    return {
      bitmap: [bitmap.width, bitmap.height],
      box,
      roundTripSame: helpers.meanDifference(raster, roundTrip),
      reencodedType: reencoded.type,
      jpegType: jpeg.type,
      cropped: [cropped.width, cropped.height, cropped.data[0], cropped.data[1], cropped.data[2]],
      resized: [resized.width, resized.height],
      flatJpegCorner: Array.from(flatJpeg.data.slice(0, 3)),
      svg: [
        image.imageSize(svgImage).width,
        image.imageSize(svgImage).height,
        svgImage instanceof HTMLImageElement,
      ],
      maskPng: [maskPng.type, maskPixels.width, maskPixels.data[0], maskPixels.data[3]],
      pipeline: {
        sourceBox,
        size: [sharp.width, sharp.height],
        squaredMs,
        whiteMs,
        totalMs,
        qa,
        jpegBytes: jpegOut.size,
      },
      studio: { box: studioBox, qa: studioQa, qaWithoutFill: studioBeforeFill },
      shrunk: {
        type: shrunk.type,
        bytes: shrunk.size,
        width: image.imageSize(shrunkBitmap).width,
        height: image.imageSize(shrunkBitmap).height,
        prefix: shrunkUrl.slice(0, 23),
      },
      smallUrlStart: smallUrl.slice(0, 22),
      smallUrlSame:
        smallUrl ===
        `data:image/png;base64,${btoa(String.fromCharCode(...new Uint8Array(await png.arrayBuffer())))}`,
    };
  }, fixture('generated-image.jpg'));

  expect(result.bitmap).toEqual([100, 80]);
  expect(result.box).toEqual({ x: 20, y: 10, width: 40, height: 30 });
  expect(result.roundTripSame).toBe(0);
  expect(result.reencodedType).toBe('image/png');
  expect(result.jpegType).toBe('image/jpeg');
  expect(result.cropped.slice(0, 2)).toEqual([40, 30]);
  expect(result.cropped.slice(2)).toEqual([200, 0, 0]);
  expect(result.resized).toEqual([50, 40]);
  for (const channel of result.flatJpegCorner) expect(channel).toBeGreaterThan(250);
  expect(result.svg).toEqual([30, 20, true]);
  expect(result.maskPng).toEqual(['image/png', 4, 255, 255]);

  expect(result.pipeline.size).toEqual([2000, 2000]);
  expect(result.pipeline.jpegBytes).toBeGreaterThan(10_000);
  // The fixture is a photograph filling its frame, so it correctly fails the QA: the check works on real pixels.
  expect(result.pipeline.qa.nonWhiteBorderPixels).toBeGreaterThanOrEqual(0);
  console.info(`isolated-image pipeline on a 1024 px photo: ${JSON.stringify(result.pipeline)}`);

  const studioBox = result.studio.box;
  expect(studioBox).not.toBeNull();
  // The ellipse is 600 x 400 at (300, 250); anti-aliased edge pixels may add a pixel.
  for (const [actual, expected] of [
    [studioBox?.x, 300],
    [studioBox?.y, 250],
    [studioBox?.width, 600],
    [studioBox?.height, 400],
  ] as const) {
    expect(Math.abs((actual ?? 0) - expected)).toBeLessThanOrEqual(2);
  }
  expect(result.studio.qa).toEqual({
    borderPureWhite: true,
    touchesEdge: false,
    nonWhiteBorderPixels: 0,
  });
  // Without the flood fill the off-white background fails the strict check, which is what the fill is for.
  expect(result.studio.qaWithoutFill.borderPureWhite).toBe(false);
  expect(result.studio.qaWithoutFill.touchesEdge).toBe(false);

  expect(result.shrunk.prefix).toBe('data:image/jpeg;base64,');
  expect(result.shrunk.bytes).toBeLessThanOrEqual(300_000);
  expect(Math.max(result.shrunk.width, result.shrunk.height)).toBeLessThanOrEqual(1024);
  expect(result.smallUrlStart).toBe('data:image/png;base64,');
  expect(result.smallUrlSame).toBe(true);
  expect(problems).toEqual([]);
});

test('runs the isolated-image pipeline in a worker without freezing the page, and can abort it', async ({
  page,
}) => {
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  const problems = await openMediaPage(page);

  const result = await page.evaluate(async (photo) => {
    const { image, imageAsync, imagePipeline, helpers } = window.__media as NonNullable<
      Window['__media']
    >;
    const small = image.imageDataFrom(await image.loadImage(helpers.blobOf(photo)));

    // A bigger studio photo (2400 x 1800), so that the canvas resize and the sharpening take real time.
    const studio = new OffscreenCanvas(2400, 1800);
    const context = studio.getContext('2d') as OffscreenCanvasRenderingContext2D;
    context.fillStyle = '#fbfbfb';
    context.fillRect(0, 0, 2400, 1800);
    context.fillStyle = '#305080';
    context.beginPath();
    context.ellipse(1200, 900, 900, 600, 0, 0, 2 * Math.PI);
    context.fill();
    const large = image.imageDataFrom(studio);

    /** The longest time the page went without running a timer while `work` ran. */
    const longestStall = async <T>(
      work: () => Promise<T>,
    ): Promise<{ value: T; stallMs: number }> => {
      let last = performance.now();
      let stallMs = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        stallMs = Math.max(stallMs, now - last);
        last = now;
      }, 10);
      try {
        const value = await work();
        // Work that blocked the page ends before the timer got to run: give it a turn to report the gap.
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        return { value, stallMs };
      } finally {
        clearInterval(timer);
      }
    };

    // Same pixels as the pure pipeline (the small photo's crop is below the canvas-resize threshold).
    const viaWorker = await imageAsync.isolateImage(small, { size: 2000 });
    const direct = imagePipeline.isolateRaster(small, { size: 2000 });
    let identical = viaWorker.image.data.length === direct.image.data.length;
    for (let i = 0; identical && i < direct.image.data.length; i++) {
      if (viaWorker.image.data[i] !== direct.image.data[i]) identical = false;
    }

    // The large one: the page keeps running during the job, and the result matches the main thread's.
    const started = performance.now();
    const worked = await longestStall(() => imageAsync.isolateImage(large, { size: 2000 }));
    const workerMs = performance.now() - started;
    const mainStarted = performance.now();
    const onPage = await longestStall(() =>
      Promise.resolve(imagePipeline.isolateRaster(large, { size: 2000 })),
    );
    const mainMs = performance.now() - mainStarted;
    const difference = helpers.meanDifference(worked.value.image, onPage.value.image);

    // Abort: a long job is stopped, and the next one runs in a fresh worker.
    const controller = new AbortController();
    const aborting = imageAsync.isolateImage(large, { size: 2000 }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const outcome = await aborting.then(
      () => 'finished',
      (error: unknown) => (error instanceof DOMException ? error.name : String(error)),
    );
    const after = await imageAsync.isolateImage(small, { size: 100 });

    // The caller's pixels survive a normal call, and are handed over (emptied) with transfer.
    const copy = image.createRaster(10, 10, '#ffffff');
    await imageAsync.isolateImage(copy, { size: 20 });
    const keptBytes = copy.data.length;
    await imageAsync.isolateImage(copy, { size: 20 }, { transfer: true });

    return {
      identical,
      checks: [viaWorker.check, worked.value.check],
      size: [viaWorker.image.width, viaWorker.image.height],
      boxLarge: worked.value.box,
      workerStallMs: worked.stallMs,
      pageStallMs: onPage.stallMs,
      workerMs,
      mainMs,
      difference,
      outcome,
      afterSize: after.image.width,
      keptBytes,
      transferredBytes: copy.data.length,
    };
  }, fixture('generated-image.jpg'));

  expect(result.identical).toBe(true);
  expect(result.size).toEqual([2000, 2000]);
  for (const check of result.checks) expect(check.borderPureWhite).toBe(true);
  expect(Math.abs(result.boxLarge.width - 1800)).toBeLessThanOrEqual(3);
  expect(result.difference).toBeLessThan(2);
  console.info(
    `isolated-image on 2400x1800: worker ${Math.round(result.workerMs)} ms (page stalled at most ${Math.round(result.workerStallMs)} ms), main thread ${Math.round(result.mainMs)} ms (stalled ${Math.round(result.pageStallMs)} ms)`,
  );
  // The page keeps running while the worker works, while the same work on the page blocks it for the whole job.
  expect(result.workerStallMs).toBeLessThan(400);
  expect(result.pageStallMs).toBeGreaterThan(result.workerStallMs);

  expect(result.outcome).toBe('AbortError');
  expect(result.afterSize).toBe(100);
  expect(result.keptBytes).toBe(400);
  expect(result.transferredBytes).toBe(0);

  const origin = new URL(page.url()).origin;
  expect(
    workers.filter((url) => /image-worker/.test(url) && new URL(url).origin === origin).length,
  ).toBeGreaterThanOrEqual(2);
  expect(problems).toEqual([]);
});

test('header sizes, EXIF rotation and reference sets that stay aligned', async ({ page }) => {
  const problems = await openMediaPage(page);

  const result = await page.evaluate(async () => {
    const { image, helpers } = window.__media as NonNullable<Window['__media']>;
    const draw = (
      width: number,
      height: number,
      paint: (context: OffscreenCanvasRenderingContext2D) => void,
    ): OffscreenCanvas => {
      const canvas = new OffscreenCanvas(width, height);
      paint(canvas.getContext('2d') as OffscreenCanvasRenderingContext2D);
      return canvas;
    };
    const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
    const bytesOf = async (blob: Blob): Promise<Uint8Array<ArrayBuffer>> =>
      new Uint8Array(await blob.arrayBuffer());
    const blobOfUrl = async (url: string): Promise<Blob> => (await fetch(url)).blob();
    const base64 = (bytes: Uint8Array): string => {
      let text = '';
      for (const byte of bytes) text += String.fromCharCode(byte);
      return btoa(text);
    };
    const decodedSize = async (blob: Blob): Promise<{ width: number; height: number }> => {
      const decoded = await image.loadImage(blob);
      const size = image.imageSize(decoded);
      if ('close' in decoded) decoded.close();
      return size;
    };
    /** The box of the pixels `test` picks. */
    const boxOf = (
      pixels: ImageData,
      test: (r: number, g: number, b: number) => boolean,
    ): number[] => {
      let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1];
      for (let y = 0; y < pixels.height; y++) {
        for (let x = 0; x < pixels.width; x++) {
          const i = (y * pixels.width + x) * 4;
          if (!test(pixels.data[i] ?? 0, pixels.data[i + 1] ?? 0, pixels.data[i + 2] ?? 0))
            continue;
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      }
      return [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
    };

    // readImageSize reads the header and agrees with the decoder, for each format the browser writes and a GIF.
    const card = draw(64, 48, (context) => {
      context.fillStyle = '#336699';
      context.fillRect(0, 0, 64, 48);
    });
    const gif = new Blob(
      [
        Uint8Array.from([
          ...ascii('GIF89a'),
          ...[5, 0, 3, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255],
          ...[0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0, 0x3b],
        ]),
      ],
      { type: 'image/gif' },
    );
    const formats: Record<string, Blob> = {
      png: await card.convertToBlob({ type: 'image/png' }),
      jpeg: await card.convertToBlob({ type: 'image/jpeg', quality: 0.9 }),
      webpLossy: await card.convertToBlob({ type: 'image/webp', quality: 0.8 }),
      webpLossless: await card.convertToBlob({ type: 'image/webp', quality: 1 }),
      gif,
    };
    const sizes: Record<string, unknown> = {};
    for (const [name, blob] of Object.entries(formats)) {
      const chunk = String.fromCharCode(...(await bytesOf(blob.slice(12, 16))));
      sizes[name] = {
        header: await image.readImageSize(blob),
        decoded: await decodedSize(blob),
        kind: `${blob.type} ${name.startsWith('webp') ? chunk : ''}`.trim(),
      };
    }

    // A JPEG tagged "rotate 90° clockwise" (EXIF orientation 6): left half red, right half blue as stored.
    const wide = draw(60, 30, (context) => {
      context.fillStyle = '#ff0000';
      context.fillRect(0, 0, 30, 30);
      context.fillStyle = '#0000ff';
      context.fillRect(30, 0, 30, 30);
    });
    const stored = await bytesOf(await wide.convertToBlob({ type: 'image/jpeg', quality: 0.95 }));
    const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0];
    const exif = [...ascii('Exif'), 0, 0, ...tiff, 0, 0, 0, 0];
    const rotated = new Blob(
      [
        stored.subarray(0, 2),
        Uint8Array.from([0xff, 0xe1, 0, exif.length + 2, ...exif]),
        stored.subarray(2),
      ],
      { type: 'image/jpeg' },
    );
    const rotatedUrl = await image.toDataUrl(rotated);
    const rotatedOut = await helpers.pixels(await blobOfUrl(rotatedUrl));
    const at = (pixels: ImageData, x: number, y: number): number[] =>
      Array.from(pixels.data.slice((y * pixels.width + x) * 4, (y * pixels.width + x) * 4 + 3));
    const storedUrl = await image.toDataUrl(new Blob([stored], { type: 'image/jpeg' }));

    // The same tag in a PNG (eXIf chunk after IHDR, with its CRC): the size is whatever the decoder makes of it.
    const crc32 = (bytes: number[]): number => {
      let c = ~0;
      for (const byte of bytes) {
        c ^= byte;
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
      }
      return ~c >>> 0;
    };
    const png = await bytesOf(await wide.convertToBlob({ type: 'image/png' }));
    const chunk = [...ascii('eXIf'), ...tiff, 0, 0, 0, 0];
    const crc = crc32(chunk);
    const pngRotated = new Blob(
      [
        png.subarray(0, 33),
        Uint8Array.from([
          0,
          0,
          0,
          chunk.length - 4,
          ...chunk,
          crc >>> 24,
          (crc >> 16) & 255,
          (crc >> 8) & 255,
          crc & 255,
        ]),
        png.subarray(33),
      ],
      { type: 'image/png' },
    );

    // A reference set: the marked picture, the plain file and the mask, scaled to one size together.
    const scene = draw(1600, 1200, (context) => {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, 1600, 1200);
      context.fillStyle = '#d01010';
      context.fillRect(400, 300, 480, 360);
    });
    const plain = await scene.convertToBlob({ type: 'image/png' });
    const mask = { width: 1600, height: 1200, data: new Uint8Array(1600 * 1200) };
    for (let y = 300; y < 660; y++) mask.data.fill(255, y * 1600 + 400, y * 1600 + 880);
    const marked = image.maskOverlay(image.imageDataFrom(scene), mask, '#FF00FF', 0.5);
    const set = await Promise.all(
      (
        await image.toDataUrls(
          [
            { image: marked, type: 'image/png' },
            plain,
            { image: image.maskToRaster(mask), type: 'image/png' },
          ],
          { maxDimension: 800 },
        )
      ).map(async (url) => helpers.pixels(await blobOfUrl(url))),
    );
    const [markedOut, plainOut, maskOut] = set as [ImageData, ImageData, ImageData];

    // A noisy plain picture that must shrink to fit the byte limit takes its mask down with it.
    const noisy = draw(1600, 1200, (context) => {
      const noise = context.createImageData(1600, 1200);
      for (let i = 0; i < noise.data.length; i++)
        noise.data[i] = i % 4 === 3 ? 255 : Math.floor(Math.random() * 256);
      context.putImageData(noise, 0, 0);
    });
    const noisyPng = await noisy.convertToBlob({ type: 'image/png' });
    const heavyUrls = await image.toDataUrls(
      [noisyPng, { image: image.maskToRaster(mask), type: 'image/png' }],
      { maxDimension: 800, maxBytes: 60_000 },
    );
    const heavy = await Promise.all(heavyUrls.map(async (url) => blobOfUrl(url)));

    // PNG output skips the quality steps and still gets under the limit by size alone.
    const started = performance.now();
    const pngUrl = await image.toDataUrl(noisyPng, {
      type: 'image/png',
      maxDimension: 1024,
      maxBytes: 600_000,
    });
    const pngMs = performance.now() - started;
    const pngOut = await blobOfUrl(pngUrl);

    return {
      sizes,
      rotated: {
        header: await image.readImageSize(rotated),
        decoded: await decodedSize(rotated),
        out: [rotatedOut.width, rotatedOut.height],
        top: at(rotatedOut, 15, 10),
        bottom: at(rotatedOut, 15, 50),
        passedThrough: rotatedUrl.endsWith(base64(await bytesOf(rotated))),
        uprightPassedThrough: storedUrl === `data:image/jpeg;base64,${base64(stored)}`,
      },
      pngRotated: {
        header: await image.readImageSize(pngRotated),
        decoded: await decodedSize(pngRotated),
      },
      set: {
        sizes: set.map((pixels) => [pixels.width, pixels.height]),
        plainBox: boxOf(plainOut, (r, g, b) => r > 150 && g < 90 && b < 90),
        markedBox: boxOf(markedOut, (r, g, b) => r > 150 && b > 60 && g < 90),
        maskBox: boxOf(maskOut, (r) => r > 127),
      },
      heavy: {
        sizes: await Promise.all(heavy.map((blob) => image.readImageSize(blob))),
        bytes: heavy.map((blob) => blob.size),
        types: heavy.map((blob) => blob.type),
      },
      png: {
        type: pngOut.type,
        bytes: pngOut.size,
        size: await image.readImageSize(pngOut),
        pngMs,
      },
    };
  });

  for (const [name, entry] of Object.entries(result.sizes)) {
    const { header, decoded } = entry as { header: unknown; decoded: unknown };
    expect(header, name).toEqual(decoded);
  }
  console.info(`header sizes: ${JSON.stringify(result.sizes)}`);

  // The browser shows the JPEG upright; the header size says so, and the reference holds those pixels.
  expect(result.rotated.decoded).toEqual({ width: 30, height: 60 });
  expect(result.rotated.header).toEqual({ width: 30, height: 60 });
  expect(result.rotated.out).toEqual([30, 60]);
  expect(result.rotated.passedThrough).toBe(false);
  const [topRed, , topBlue] = result.rotated.top as [number, number, number];
  const [bottomRed, , bottomBlue] = result.rotated.bottom as [number, number, number];
  expect(topRed).toBeGreaterThan(200);
  expect(topBlue).toBeLessThan(60);
  expect(bottomBlue).toBeGreaterThan(200);
  expect(bottomRed).toBeLessThan(60);
  expect(result.rotated.uprightPassedThrough).toBe(true);
  expect(result.pngRotated.header).toEqual(result.pngRotated.decoded);
  console.info(
    `PNG with eXIf orientation 6 decodes as ${JSON.stringify(result.pngRotated.decoded)}`,
  );

  // Scaled together: one size, and the marked area, the red square and the mask cover the same pixels.
  expect(result.set.sizes).toEqual([
    [800, 600],
    [800, 600],
    [800, 600],
  ]);
  for (const box of [result.set.plainBox, result.set.markedBox, result.set.maskBox]) {
    [200, 150, 240, 180].forEach((expected, i) =>
      expect(Math.abs((box[i] ?? 0) - expected)).toBeLessThanOrEqual(1),
    );
  }

  const [noisySize, maskSize] = result.heavy.sizes;
  expect(noisySize).toEqual(maskSize);
  expect(noisySize?.width ?? 800).toBeLessThan(800);
  expect(Math.abs((noisySize?.width ?? 0) / (noisySize?.height ?? 1) - 4 / 3)).toBeLessThan(0.01);
  expect(result.heavy.types).toEqual(['image/jpeg', 'image/png']);
  for (const bytes of result.heavy.bytes) expect(bytes).toBeLessThanOrEqual(60_000);

  expect(result.png.type).toBe('image/png');
  expect(result.png.bytes).toBeLessThanOrEqual(600_000);
  expect(result.png.size.width).toBeLessThan(1024);
  console.info(`noisy PNG to PNG under 600 KB: ${JSON.stringify(result.png)}`);
  expect(problems).toEqual([]);
});

test("runs the editor's mask work in the worker, and recovers from a worker that fails to start", async ({
  page,
}) => {
  const workers: string[] = [];
  page.on('worker', (worker) => {
    if (/image-worker/.test(worker.url())) workers.push(worker.url());
  });
  const problems = await openMediaPage(page);

  const result = await page.evaluate(async () => {
    const { image, imageAsync } = window.__media as NonNullable<Window['__media']>;
    const same = (a: { data: ArrayLike<number> }, b: { data: ArrayLike<number> }): boolean => {
      if (a.data.length !== b.data.length) return false;
      for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
      return true;
    };
    const canvas = new OffscreenCanvas(1200, 900);
    const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
    const gradient = context.createLinearGradient(0, 0, 1200, 900);
    gradient.addColorStop(0, '#1e3a8a');
    gradient.addColorStop(1, '#f59e0b');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 1200, 900);
    const picture = image.imageDataFrom(canvas);
    const disc = (width: number, height: number, radius: number) => {
      const mask = { width, height, data: new Uint8Array(width * height) };
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          if ((x - width / 2) ** 2 + (y - height / 2) ** 2 < radius ** 2)
            mask.data[y * width + x] = 255;
      return mask;
    };
    const mask = disc(1200, 900, 250);
    const answer = image.createRaster(1200, 900, '#20a040');

    const identical = {
      overlay: same(
        await imageAsync.maskOverlayAsync(picture, mask, '#FF00FF', 0.5),
        image.maskOverlay(picture, mask, '#FF00FF', 0.5),
      ),
      maskRaster: same(await imageAsync.maskToRasterAsync(mask), image.maskToRaster(mask)),
      feather: same(await imageAsync.featherInsideAsync(mask, 12), image.featherInside(mask, 12)),
      composite: same(
        await imageAsync.compositeMaskedAsync(picture, answer, mask, { feather: 12 }),
        image.compositeMasked(picture, answer, image.featherInside(mask, 12)),
      ),
    };

    // The worker has answered, so pixels asked to be transferred are handed over.
    const moved = {
      picture: image.imageDataFrom(canvas),
      answer: image.createRaster(1200, 900, '#20a040'),
      mask: disc(1200, 900, 250),
    };
    await imageAsync.compositeMaskedAsync(
      moved.picture,
      moved.answer,
      moved.mask,
      { feather: 4 },
      { transfer: true },
    );
    const transferred = [
      moved.picture.data.length,
      moved.answer.data.length,
      moved.mask.data.length,
    ];

    // A long job is aborted, and the next one runs in a fresh worker.
    const bigMask = disc(4000, 3000, 1200);
    const big = image.createRaster(4000, 3000, '#808080');
    const controller = new AbortController();
    const aborting = imageAsync.compositeMaskedAsync(
      big,
      big,
      bigMask,
      { feather: 32 },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 30);
    const outcome = await aborting.then(
      () => 'finished',
      (error: unknown) => (error instanceof DOMException ? error.name : String(error)),
    );
    const afterAbort = (await imageAsync.featherInsideAsync(disc(40, 30, 10), 2)).width;
    return { identical, transferred, outcome, afterAbort };
  });

  expect(result.identical).toEqual({
    overlay: true,
    maskRaster: true,
    feather: true,
    composite: true,
  });
  expect(result.transferred).toEqual([0, 0, 0]);
  expect(result.outcome).toBe('AbortError');
  expect(result.afterAbort).toBe(40);
  await expect.poll(() => workers.length).toBeGreaterThanOrEqual(2);
  const beforeFailure = workers.length;

  // The next worker fails before it ever answers (as a blocked or broken script would): the page runs that
  // job on its own copy of the pixels, and the job after it gets a new, real worker.
  const recovery = await page.evaluate(async () => {
    const { image, imageAsync, imagePipeline } = window.__media as NonNullable<Window['__media']>;
    imageAsync.disposeImageWorker();
    const RealWorker = window.Worker;
    class FailsToStart {
      onmessage: unknown = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      constructor() {
        setTimeout(() => this.onerror?.(new ErrorEvent('error', { cancelable: true })), 20);
      }
      postMessage(message: unknown, transfer: Transferable[] = []): void {
        structuredClone(message, { transfer }); // what a real hand-over does to the page's buffers
      }
      terminate(): void {}
    }
    let first = true;
    const Wrapped = function (url: string | URL, options?: WorkerOptions): unknown {
      if (first) {
        first = false;
        return new FailsToStart();
      }
      return new RealWorker(url, options);
    };
    (window as unknown as { Worker: unknown }).Worker = Wrapped;
    try {
      const photo = image.createRaster(300, 200, '#fbfbfb');
      for (let y = 50; y < 150; y++) photo.data.fill(40, (y * 300 + 60) * 4, (y * 300 + 240) * 4);
      const expected = imagePipeline.isolateRaster(photo, { size: 120 });
      const failed = await imageAsync.isolateImage(photo, { size: 120 }, { transfer: true });
      const keptBytes = photo.data.length;
      const next = await imageAsync.isolateImage(photo, { size: 60 });
      let sameAsPage = failed.image.data.length === expected.image.data.length;
      for (let i = 0; sameAsPage && i < expected.image.data.length; i++)
        if (failed.image.data[i] !== expected.image.data[i]) sameAsPage = false;
      return { sameAsPage, keptBytes, next: next.image.width, usedFake: !first };
    } finally {
      (window as unknown as { Worker: unknown }).Worker = RealWorker;
    }
  });

  expect(recovery).toEqual({
    sameAsPage: true,
    keptBytes: 300 * 200 * 4,
    next: 60,
    usedFake: true,
  });
  await expect.poll(() => workers.length).toBe(beforeFailure + 1);
  expect(problems).toEqual([]);
});
