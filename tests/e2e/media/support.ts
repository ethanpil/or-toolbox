/// <reference types="vite/client" />
// The sources use globals declared in src/env.d.ts, which only a `path` reference can pull in here.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../../../src/env.d.ts" />
/**
 * Helpers for the core media specs.
 *
 * These specs test browser-only code (canvas, `<video>`, Web Audio, pdf.js,
 * ffmpeg.wasm) by importing the real source modules into a page served by the
 * dev server and calling them there, with the real fixtures from
 * tests/fixtures/media/. Run them with
 * `npm run e2e:dev -- tests/e2e/media --project=chromium`.
 *
 * Page code reaches the modules through `window.__media`, typed from the
 * sources so a signature change breaks these specs at compile time.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { basePath } from '../../../vite-plugins/site.ts';
import type * as Files from '../../../src/core/files';
import type * as Docx from '../../../src/core/export/docx';
import type * as Subtitles from '../../../src/core/export/subtitles';
import type * as Table from '../../../src/core/export/table';
import type * as Xlsx from '../../../src/core/export/xlsx';
import type * as Zip from '../../../src/core/export/zip';
import type * as Audio from '../../../src/core/media/audio';
import type * as FfmpegCore from '../../../src/core/media/ffmpeg';
import type * as FfmpegOps from '../../../src/core/media/ffmpeg-ops';
import type * as Image from '../../../src/core/media/image';
import type * as ImageAsync from '../../../src/core/media/image-async';
import type * as ImagePipeline from '../../../src/core/media/image-pipeline';
import type * as Pdf from '../../../src/core/media/pdf';
import type * as Stitch from '../../../src/core/media/stitch';
import type * as Video from '../../../src/core/media/video';
import { MEDIA_FIXTURES_DIR } from '../../mock/index.ts';
import { watchForProblems } from '../support.ts';

export interface MediaModules {
  files: typeof Files;
  image: typeof Image;
  imageAsync: typeof ImageAsync;
  imagePipeline: typeof ImagePipeline;
  stitch: typeof Stitch;
  video: typeof Video;
  audio: typeof Audio;
  ffmpeg: typeof FfmpegOps;
  /** The shared ffmpeg loader that ffmpeg-ops builds on. */
  ffmpegCore: typeof FfmpegCore;
  pdf: typeof Pdf;
  docx: typeof Docx;
  subtitles: typeof Subtitles;
  table: typeof Table;
  xlsx: typeof Xlsx;
  zip: typeof Zip;
  helpers: PageHelpers;
}

/** Anything with RGBA pixels: `ImageData`, or the `RasterImage` of image.ts. */
export type PixelData = Pick<ImageData, 'width' | 'height' | 'data'>;

/** Small utilities that run inside the page. */
export interface PageHelpers {
  /** A fixture (see `fixture()`) as a Blob. */
  blobOf: (data: { base64: string; type: string }) => Blob;
  /** Decodes an image Blob to pixels. */
  pixels: (blob: Blob) => Promise<ImageData>;
  /** Mean absolute difference of the RGB channels, 0 (identical) to 255. */
  meanDifference: (a: PixelData, b: PixelData) => number;
}

declare global {
  interface Window {
    __media?: MediaModules;
  }
}

export type FixtureName =
  'speech.mp3' | 'video-1s.mp4' | 'invoice.pdf' | 'generated-image.jpg' | 'edited-image.jpg';

const FIXTURE_TYPES: Record<FixtureName, string> = {
  'speech.mp3': 'audio/mpeg',
  'video-1s.mp4': 'video/mp4',
  'invoice.pdf': 'application/pdf',
  'generated-image.jpg': 'image/jpeg',
  'edited-image.jpg': 'image/jpeg',
};

/** A fixture as arguments for `page.evaluate`, which can only pass serialisable values. */
export interface FixtureData {
  base64: string;
  type: string;
}

export function fixture(name: FixtureName): FixtureData {
  return {
    base64: readFileSync(join(MEDIA_FIXTURES_DIR, name)).toString('base64'),
    type: FIXTURE_TYPES[name],
  };
}

/** True for the error Playwright raises when the page navigates while a script is running in it. */
function isNavigationError(error: unknown): boolean {
  return /context was destroyed|navigation|Target (page|closed)/i.test(String(error));
}

/**
 * Opens a lightweight page of the app and loads every media module into
 * `window.__media`. Returns the page's problem list (console errors, CSP
 * violations, failed requests), which a spec should assert is empty at the end.
 *
 * The first run on a machine has one wrinkle: the dev server pre-bundles a
 * library the first time anything asks for it and then reloads the page. The
 * warm-up below asks for them all up front and retries across the reload; later
 * runs find them cached.
 */
export async function openMediaPage(page: Page): Promise<string[]> {
  const problems = await watchForProblems(page);
  await page.goto('privacy/');

  for (let attempt = 1; ; attempt++) {
    try {
      await page.evaluate(async (base) => {
        const load = async <T>(path: string): Promise<T> =>
          (await import(/* @vite-ignore */ `${base}src/core/${path}.ts`)) as T;
        const helpers: PageHelpers = {
          blobOf: (data) =>
            new Blob([Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0))], {
              type: data.type,
            }),
          pixels: async (blob) => {
            const bitmap = await createImageBitmap(blob);
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
            context.drawImage(bitmap, 0, 0);
            bitmap.close();
            return context.getImageData(0, 0, canvas.width, canvas.height);
          },
          meanDifference: (a, b) => {
            if (a.width !== b.width || a.height !== b.height) return Infinity;
            let sum = 0;
            for (let i = 0; i < a.data.length; i += 4) {
              sum +=
                Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)) +
                Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0)) +
                Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0));
            }
            return sum / ((a.data.length / 4) * 3);
          },
        };
        const media: MediaModules = {
          helpers,
          files: await load('files'),
          image: await load('media/image'),
          imageAsync: await load('media/image-async'),
          imagePipeline: await load('media/image-pipeline'),
          stitch: await load('media/stitch'),
          video: await load('media/video'),
          audio: await load('media/audio'),
          ffmpeg: await load('media/ffmpeg-ops'),
          ffmpegCore: await load('media/ffmpeg'),
          pdf: await load('media/pdf'),
          docx: await load('export/docx'),
          subtitles: await load('export/subtitles'),
          table: await load('export/table'),
          xlsx: await load('export/xlsx'),
          zip: await load('export/zip'),
        };
        window.__media = media;
        // Touch every lazily imported library once, so Vite optimises them now.
        await media.zip.zipFiles([]);
        await media.docx.toDocx('');
        await media.xlsx.toXlsx([{ name: 'warm-up', columns: [], rows: [] }]);
        await media.pdf.openPdf(new Blob(['not a pdf'])).catch(() => undefined);
      }, basePath());
      break;
    } catch (error) {
      if (!isNavigationError(error) || attempt >= 4) throw error;
      await page.waitForLoadState('load');
      // The interrupted load left aborted requests behind; they are not problems.
      problems.length = 0;
    }
  }
  return problems;
}
