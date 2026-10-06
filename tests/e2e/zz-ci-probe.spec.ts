// TEMPORARY diagnostics for the cross-browser CI run; removed in the next commit. Logs only, never fails.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA_FIXTURES_DIR, test } from '../mock/index.ts';

test('probe: Web Audio and a cross-context MediaStream', async ({ page, browserName }) => {
  await page.goto('privacy/');
  await page.evaluate(() => {
    const w = window as unknown as { probe: Promise<unknown> };
    document.body.addEventListener(
      'click',
      () => {
        w.probe = (async () => {
          const log: unknown[] = [];
          const rms = (analyser: AnalyserNode): number => {
            const data = new Float32Array(analyser.fftSize);
            analyser.getFloatTimeDomainData(data);
            return Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length);
          };
          try {
            const a = new AudioContext();
            log.push(['a created', a.state, a.sampleRate]);
            const osc = a.createOscillator();
            const dest = a.createMediaStreamDestination();
            const local = a.createAnalyser();
            osc.connect(dest);
            osc.connect(local);
            osc.start();
            const b = new AudioContext();
            log.push(['b created', b.state, b.sampleRate]);
            let analyser: AnalyserNode | null = null;
            try {
              analyser = b.createAnalyser();
              b.createMediaStreamSource(dest.stream).connect(analyser);
            } catch (error) {
              log.push(['createMediaStreamSource threw', String(error)]);
            }
            for (let i = 0; i < 6; i++) {
              await new Promise((r) => setTimeout(r, 500));
              void a.resume().catch(() => undefined);
              void b.resume().catch(() => undefined);
              log.push([i, a.state, b.state, rms(local), analyser ? rms(analyser) : null]);
            }
          } catch (error) {
            log.push(['threw', String(error)]);
          }
          return log;
        })();
      },
      { once: true },
    );
  });
  await page.mouse.click(5, 5);
  const result = await page.evaluate(
    () => (window as unknown as { probe: Promise<unknown> }).probe,
  );
  console.log(`PROBE audio ${browserName}`, JSON.stringify(result));
});

test('probe: video frames after seeking', async ({ page, browserName }) => {
  await page.goto('privacy/');
  const video = readFileSync(join(MEDIA_FIXTURES_DIR, 'video-1s.mp4')).toString('base64');
  const result = await page.evaluate(async (base64) => {
    const log: unknown[] = [];
    try {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const element = document.createElement('video');
      element.muted = true;
      element.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
      const loaded = await Promise.race([
        new Promise((r) =>
          element.addEventListener('loadeddata', () => r('loadeddata'), { once: true }),
        ),
        new Promise((r) =>
          element.addEventListener(
            'error',
            () => r(`error ${element.error?.code} ${element.error?.message}`),
            { once: true },
          ),
        ),
        new Promise((r) => setTimeout(() => r('timeout'), 10_000)),
      ]);
      log.push([
        'load',
        loaded,
        element.duration,
        element.videoWidth,
        element.readyState,
        'rvfc' in element,
      ]);
      const pixels = (): number[] => {
        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 16;
        const context = canvas.getContext('2d')!;
        context.drawImage(element, 0, 0, 16, 16);
        const data = context.getImageData(0, 0, 16, 16).data;
        let sum = 0;
        let alpha = 0;
        for (let i = 0; i < data.length; i += 4) {
          sum += data[i]! + data[i + 1]! + data[i + 2]!;
          alpha += data[i + 3]!;
        }
        return [Math.round(sum / 256), Math.round(alpha / 256), data[0]!, data[1]!, data[2]!];
      };
      for (const time of [0, 0.5, element.duration - 1 / 48]) {
        const seeked = new Promise((r) => element.addEventListener('seeked', r, { once: true }));
        element.currentTime = time;
        await Promise.race([seeked, new Promise((r) => setTimeout(r, 5000))]);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        log.push([time, element.readyState, pixels()]);
        await new Promise((r) => setTimeout(r, 300));
        log.push([`${time} +300ms`, pixels()]);
      }
    } catch (error) {
      log.push(['threw', String(error)]);
    }
    return log;
  }, video);
  console.log(`PROBE video ${browserName}`, JSON.stringify(result));
});
