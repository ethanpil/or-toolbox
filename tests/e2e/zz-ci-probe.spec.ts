// TEMPORARY diagnostics for the cross-browser CI run; removed in the next commit. Logs only, never fails.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, MEDIA_FIXTURES_DIR, test } from '../mock/index.ts';
import { seedApp } from './app.ts';

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
      // Alternatives: in the document, after playing, createImageBitmap, WebCodecs VideoFrame, a WebGL texture.
      element.width = 64;
      document.body.append(element);
      await new Promise((r) => setTimeout(r, 300));
      log.push(['attached', pixels()]);
      await element.play().catch((error: unknown) => log.push(['play failed', String(error)]));
      await new Promise((r) => setTimeout(r, 400));
      element.pause();
      await new Promise((r) => setTimeout(r, 200));
      log.push(['after play', element.currentTime, pixels()]);
      try {
        const bitmap = await createImageBitmap(element);
        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 16;
        const context = canvas.getContext('2d')!;
        context.drawImage(bitmap, 0, 0, 16, 16);
        const data = context.getImageData(0, 0, 16, 16).data;
        log.push([
          'bitmap',
          bitmap.width,
          data[0],
          data[1],
          data[2],
          data[3],
          data[400],
          data[403],
        ]);
      } catch (error) {
        log.push(['bitmap threw', String(error)]);
      }
      try {
        const Frame = (window as unknown as { VideoFrame?: new (v: HTMLVideoElement) => unknown })
          .VideoFrame;
        if (Frame) {
          const frame = new Frame(element) as {
            codedWidth: number;
            format: string | null;
            close(): void;
          };
          log.push(['VideoFrame', frame.codedWidth, frame.format]);
          const canvas = document.createElement('canvas');
          canvas.width = 16;
          canvas.height = 16;
          const context = canvas.getContext('2d')!;
          context.drawImage(frame as unknown as CanvasImageSource, 0, 0, 16, 16);
          const data = context.getImageData(0, 0, 16, 16).data;
          log.push(['VideoFrame drawn', data[0], data[1], data[2], data[3], data[400], data[403]]);
          frame.close();
        } else log.push(['no VideoFrame']);
      } catch (error) {
        log.push(['VideoFrame threw', String(error)]);
      }
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 16;
        const gl = canvas.getContext('webgl');
        if (gl) {
          const texture = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, element);
          const fb = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
          const out = new Uint8Array(4 * 4);
          gl.readPixels(100, 100, 2, 2, gl.RGBA, gl.UNSIGNED_BYTE, out);
          log.push(['webgl', gl.getError(), [...out]]);
        } else log.push(['no webgl']);
      } catch (error) {
        log.push(['webgl threw', String(error)]);
      }
    } catch (error) {
      log.push(['threw', String(error)]);
    }
    return log;
  }, video);
  console.log(`PROBE video ${browserName}`, JSON.stringify(result));
});

test('probe: a key rename reaching another open tab', async ({ page, context, browserName }) => {
  await seedApp(context, { key: true });
  await page.goto('settings/#keys');
  const other = await context.newPage();
  await other.goto('settings/#keys');
  await other.evaluate(() => {
    const w = window as unknown as { got: unknown[] };
    w.got = [];
    const stamp = (): number => Math.round(performance.now());
    new BroadcastChannel('ortoolbox').onmessage = (e) => w.got.push(['bc', e.data, stamp()]);
    new BroadcastChannel('probe2').onmessage = (e) => w.got.push(['probe2', e.data, stamp()]);
    window.addEventListener('storage', (e) => w.got.push(['storage', e.key, stamp()]));
    document.addEventListener('visibilitychange', () =>
      w.got.push(['vis', document.visibilityState, stamp()]),
    );
  });
  await page.bringToFront();
  const state = (): Promise<unknown> =>
    other.evaluate(() => ({
      got: (window as unknown as { got: unknown[] }).got,
      vis: document.visibilityState,
      focus: document.hasFocus(),
      name: document.querySelector('[data-testid=key-name]')?.textContent,
      stored: localStorage.getItem('ortoolbox:keys')?.includes('Renamed') ?? null,
    }));
  await page.getByTestId('key-rename').click();
  await page.getByTestId('prompt-input').fill('Renamed elsewhere');
  await page.getByTestId('rename-key-dialog').getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('key-name')).toHaveText('Renamed elsewhere');
  await page.evaluate(() => new BroadcastChannel('probe2').postMessage('hi from page'));
  await page.waitForTimeout(2000);
  console.log(`PROBE tabs ${browserName} after`, JSON.stringify(await state()));
  await other.bringToFront();
  await other.waitForTimeout(2000);
  console.log(`PROBE tabs ${browserName} front`, JSON.stringify(await state()));
});
