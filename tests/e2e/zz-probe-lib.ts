// TEMPORARY diagnostics for the cross-browser CI runs; removed with zz-ci-probe.spec.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { MEDIA_FIXTURES_DIR } from '../mock/index.ts';

/** Event timings of media elements loading a video and a MediaRecorder recording, as openMedia sets them up. */
export async function mediaLoadProbe(page: Page): Promise<unknown> {
  const video = readFileSync(join(MEDIA_FIXTURES_DIR, 'video-1s.mp4')).toString('base64');
  await page.evaluate((base64) => {
    const w = window as unknown as { probe: Promise<unknown> };
    document.body.addEventListener(
      'click',
      () => {
        w.probe = (async () => {
          const t0 = performance.now();
          const log: unknown[] = [];
          const at = (): number => Math.round(performance.now() - t0);
          const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
          const watch = (element: HTMLMediaElement, label: string): void => {
            for (const name of [
              'loadstart',
              'durationchange',
              'loadedmetadata',
              'loadeddata',
              'canplay',
              'suspend',
              'stalled',
              'waiting',
              'seeking',
              'seeked',
              'error',
              'abort',
            ]) {
              element.addEventListener(name, () =>
                log.push([
                  label,
                  name,
                  at(),
                  element.readyState,
                  element.duration,
                  element.currentTime,
                  element.error?.message ?? null,
                ]),
              );
            }
          };
          try {
            const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
            const href = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
            const a = document.createElement('video');
            watch(a, 'A');
            a.preload = 'auto';
            a.muted = true;
            a.playsInline = true;
            a.style.position = 'fixed';
            a.style.left = '-10000px';
            a.style.width = '1px';
            a.style.height = '1px';
            document.body.append(a);
            a.src = href;
            await sleep(3000);
            a.currentTime = 0.5;
            await sleep(1500);
            a.currentTime = 1.02;
            await sleep(1500);
            const b = document.createElement('video');
            watch(b, 'B');
            b.muted = true;
            b.src = href;
            await sleep(3000);
            const context = new AudioContext();
            await context.resume().catch(() => undefined);
            const tone = context.createOscillator();
            const out = context.createMediaStreamDestination();
            tone.connect(out);
            tone.start();
            await sleep(500);
            log.push(['ctx', at(), context.state]);
            const recorder = new MediaRecorder(out.stream);
            const chunks: Blob[] = [];
            recorder.ondataavailable = (event) => chunks.push(event.data);
            recorder.start(500);
            await sleep(1600);
            const stopped = new Promise((r) => (recorder.onstop = r));
            recorder.stop();
            await stopped;
            const recording = new Blob(chunks, { type: recorder.mimeType });
            log.push(['recorded', at(), recorder.mimeType, recording.size, chunks.length]);
            const c = document.createElement('audio');
            watch(c, 'C');
            c.preload = 'auto';
            c.muted = true;
            c.src = URL.createObjectURL(recording);
            await sleep(3000);
            log.push(['C before seek', at(), c.duration]);
            c.currentTime = 1e101;
            await sleep(3000);
            log.push(['C after seek', at(), c.duration, c.currentTime]);
          } catch (error) {
            log.push(['threw', at(), String(error)]);
          }
          return log;
        })();
      },
      { once: true },
    );
  }, video);
  await page.mouse.click(5, 5);
  return page.evaluate(() => (window as unknown as { probe: Promise<unknown> }).probe);
}
