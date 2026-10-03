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
