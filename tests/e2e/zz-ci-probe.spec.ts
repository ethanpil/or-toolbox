// TEMPORARY diagnostics for the cross-browser CI runs (removed later). Logs only, never fails.
/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unnecessary-type-assertion -- temporary probe */
import { test } from '../mock/index.ts';
import { seedApp } from './app.ts';

test('probe: a recording made in the app', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'firefox', 'Firefox only');
  test.setTimeout(90_000);
  await seedApp(context, { key: true });
  await context.addInitScript(() => {
    if (!navigator.mediaDevices) return;
    navigator.mediaDevices.getUserMedia = () => {
      const audio = new AudioContext();
      const out = audio.createMediaStreamDestination();
      const tone = audio.createOscillator();
      tone.connect(out);
      tone.start();
      return Promise.resolve(out.stream);
    };
    navigator.mediaDevices.enumerateDevices = () =>
      Promise.resolve([
        { deviceId: 'mic-0', groupId: 'g', kind: 'audioinput', label: 'Mic' } as MediaDeviceInfo,
      ]);
    const t0 = performance.now();
    const log: unknown[] = [];
    (window as unknown as { __plog: unknown[] }).__plog = log;
    const at = (): number => Math.round(performance.now() - t0);
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const href = create(object);
      if (object instanceof Blob) {
        log.push(['url', at(), object.type, object.size]);
        void object
          .slice(0, 400)
          .arrayBuffer()
          .then((buffer) =>
            log.push([
              'head',
              [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join(''),
            ]),
          );
      }
      return href;
    };
    const original = Document.prototype.createElement;
    Document.prototype.createElement = function (this: Document, tag: string, options?: object) {
      const element = original.call(this, tag, options as ElementCreationOptions);
      if (/^(audio|video)$/i.test(tag)) {
        const media = element as HTMLMediaElement;
        for (const name of [
          'loadstart',
          'durationchange',
          'loadedmetadata',
          'loadeddata',
          'seeking',
          'seeked',
          'timeupdate',
          'error',
          'abort',
          'emptied',
        ]) {
          media.addEventListener(name, () =>
            log.push([tag, name, at(), media.readyState, media.duration, media.currentTime]),
          );
        }
      }
      return element;
    } as typeof Document.prototype.createElement;
  });
  await page.goto('tools/speech-to-text/');
  await page.getByTestId('stt-record').click();
  await page.waitForTimeout(4000);
  await page.getByTestId('stt-record-stop').click();
  const statuses: unknown[] = [];
  for (let i = 0; i < 40; i++) {
    statuses.push([
      i * 500,
      await page.getByTestId('tool-status').textContent(),
      await page.getByTestId('stt-source-name').count(),
    ]);
    await page.waitForTimeout(500);
  }
  console.log(`PROBE recording ${browserName} statuses`, JSON.stringify(statuses));
  console.log(
    `PROBE recording ${browserName} log`,
    JSON.stringify(
      await page.evaluate(() => (window as unknown as { __plog: unknown[] }).__plog.slice(0, 80)),
    ),
  );
});
