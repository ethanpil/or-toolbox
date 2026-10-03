import { expect, test } from '../../mock/index.ts';
import { fixture, openMediaPage } from './support.ts';

// Each test starts ffmpeg.wasm: a 32 MB core, then real encodes on a slow machine.
test.setTimeout(420_000);

test('transcodes speech.mp3 to WAV and back to MP3', async ({ page }) => {
  const problems = await openMediaPage(page);

  const result = await page.evaluate(async (speech) => {
    const { ffmpeg, audio, helpers } = window.__media as NonNullable<Window['__media']>;
    const blob = helpers.blobOf(speech);
    const timings: Record<string, number> = {};
    const time = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      try {
        return await work();
      } finally {
        timings[name] = Math.round(performance.now() - started);
      }
    };

    const progress: number[] = [];
    let loadProgress = 0;
    const wav = await time('mp3->wav (includes core load)', () =>
      ffmpeg.transcodeAudio(blob, 'wav', {
        onProgress: (ratio) => progress.push(ratio),
        onLoadProgress: ({ loaded, total }) =>
          (loadProgress = Math.max(loadProgress, loaded / total)),
      }),
    );
    const wavInfo = audio.parseWav(new Uint8Array(await wav.arrayBuffer()));

    const speechWav = await time('mp3->wav 16 kHz mono', () =>
      ffmpeg.transcodeAudio(blob, 'wav', { sampleRate: 16000, channels: 1 }),
    );
    const speechInfo = audio.parseWav(new Uint8Array(await speechWav.arrayBuffer()));

    const mp3 = await time('wav->mp3', () => ffmpeg.transcodeAudio(wav, 'mp3', { bitrate: 64 }));
    const mp3Info = audio.parseMp3(new Uint8Array(await mp3.arrayBuffer()));

    // PCM from a PCM-only TTS model becomes an MP3 in the browser.
    const pcm = new Int16Array(24000 * 2);
    for (let i = 0; i < pcm.length; i++)
      pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24000));
    const fromPcm = await time('pcm->mp3', () =>
      ffmpeg.transcodeAudio(audio.pcmToWav(new Uint8Array(pcm.buffer), 24000, 1), 'mp3'),
    );
    const fromPcmInfo = audio.parseMp3(new Uint8Array(await fromPcm.arrayBuffer()));

    const probed = await ffmpeg.probeMedia(blob);

    return {
      progress,
      loadProgress,
      timings,
      wav: { type: wav.type, ...wavInfo },
      speechWav: { ...speechInfo },
      mp3: { type: mp3.type, ...mp3Info.info },
      fromPcm: { seconds: fromPcmInfo.info.duration, rate: fromPcmInfo.info.sampleRate },
      probed,
    };
  }, fixture('speech.mp3'));

  console.info(`ffmpeg audio timings (ms): ${JSON.stringify(result.timings)}`);
  expect(result.wav.type).toBe('audio/wav');
  expect(result.wav.bitsPerSample).toBe(16);
  expect(result.wav.duration).toBeGreaterThan(3.1);
  expect(result.wav.duration).toBeLessThan(3.4);
  expect(result.speechWav.sampleRate).toBe(16000);
  expect(result.speechWav.channels).toBe(1);
  expect(result.mp3.type).toBe('audio/mpeg');
  expect(result.mp3.duration).toBeCloseTo(result.wav.duration, 0);
  expect(result.mp3.layer).toBe(3);
  expect(result.fromPcm.seconds).toBeCloseTo(2, 0);
  expect(result.progress.at(-1)).toBe(1);
  expect([...result.progress].sort((a, b) => a - b)).toEqual(result.progress);
  expect(result.loadProgress).toBeGreaterThan(0);
  expect(result.probed.audio).toMatchObject({ codec: 'mp3', sampleRate: 24000, channels: 1 });
  expect(result.probed.video).toBeNull();
  expect(result.probed.duration).toBeGreaterThan(3.1);
  expect(problems).toEqual([]);
});

test('joins and trims video clips into playable MP4 files', async ({ page }) => {
  const problems = await openMediaPage(page);

  const result = await page.evaluate(async (clip) => {
    const { ffmpeg, ffmpegCore, video, helpers } = window.__media as NonNullable<Window['__media']>;
    const blob = helpers.blobOf(clip);
    const timings: Record<string, number> = {};
    const time = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      try {
        return await work();
      } finally {
        timings[name] = Math.round(performance.now() - started);
      }
    };
    const describe = async (output: Blob) => {
      const metadata = await video.getVideoMetadata(output);
      const info = await ffmpeg.probeMedia(output);
      return {
        type: output.type,
        bytes: output.size,
        ...metadata,
        probed: info.video?.codec,
        audio: info.audio?.codec,
      };
    };

    const progress: number[] = [];
    const copied = await time('concat 2 x 1 s (stream copy, includes core load)', () =>
      ffmpeg.concatVideos([{ blob }, { blob }], { onProgress: (ratio) => progress.push(ratio) }),
    );
    const copiedLast = await video.captureFrame(copied, 'last');
    const firstFrame = await video.captureFrame(copied, 'first');
    const afterSeam = await video.captureFrame(copied, 1.2);

    const reencoded = await time('concat 2 x 1 s, drop first frame of the second (re-encode)', () =>
      ffmpeg.concatVideos([{ blob }, { blob, dropFirstFrame: true }]),
    );
    const trimmedClips = await time('concat with trims (re-encode)', () =>
      ffmpeg.concatVideos([
        { blob, trimEnd: 0.5 },
        { blob, trimStart: 0.25 },
      ]),
    );
    const trimmed = await time('trim 0.2 s to 0.7 s', () => ffmpeg.trimMedia(blob, 0.2, 0.7));

    // Every file the jobs wrote is gone from ffmpeg's in-memory file system.
    const { ffmpeg: instance } = await ffmpegCore.loadFfmpeg();
    const leftovers = (await instance.listDir('/')).filter((node) => /^j\d+-/.test(node.name));

    return {
      timings,
      progress,
      leftovers: leftovers.map((node) => node.name),
      copied: await describe(copied),
      copiedLastToFirst: helpers.meanDifference(
        await helpers.pixels(copiedLast),
        await helpers.pixels(firstFrame),
      ),
      afterSeamToFirst: helpers.meanDifference(
        await helpers.pixels(afterSeam),
        await helpers.pixels(firstFrame),
      ),
      reencoded: await describe(reencoded),
      trimmedClips: await describe(trimmedClips),
      trimmed: await describe(trimmed),
    };
  }, fixture('video-1s.mp4'));

  console.info(`ffmpeg video timings (ms): ${JSON.stringify(result.timings)}`);
  // video-1s.mp4 is 1.04 s: two copies joined are about 2.08 s and still 544 x 544 H.264 with sound.
  expect(result.copied).toMatchObject({
    type: 'video/mp4',
    width: 544,
    height: 544,
    probed: 'h264',
    audio: 'aac',
  });
  expect(result.copied.duration).toBeGreaterThan(2.0);
  expect(result.copied.duration).toBeLessThan(2.2);
  // The second half plays: its last frame is the clip's last frame, not a repeat of the first.
  expect(result.copiedLastToFirst).toBeGreaterThan(1);
  expect(result.afterSeamToFirst).toBeLessThan(result.copiedLastToFirst);
  expect(result.progress.at(-1)).toBe(1);
  expect(result.leftovers).toEqual([]);

  // One frame (1/24 s) fewer than the plain join.
  expect(result.reencoded).toMatchObject({ width: 544, height: 544, probed: 'h264', audio: 'aac' });
  expect(result.reencoded.duration).toBeGreaterThan(result.copied.duration - 0.15);
  expect(result.reencoded.duration).toBeLessThan(result.copied.duration);

  // (1.04 - 0.5) + (1.04 - 0.25) = 1.33 s.
  expect(result.trimmedClips.duration).toBeGreaterThan(1.2);
  expect(result.trimmedClips.duration).toBeLessThan(1.45);

  expect(result.trimmed).toMatchObject({ type: 'video/mp4', width: 544, height: 544 });
  expect(result.trimmed.duration).toBeGreaterThan(0.45);
  expect(result.trimmed.duration).toBeLessThan(0.6);
  expect(problems).toEqual([]);
});

test('aborting stops ffmpeg, rejects with an AbortError and leaves the next job working', async ({
  page,
}) => {
  const problems = await openMediaPage(page);

  const result = await page.evaluate(async (clip) => {
    const { ffmpeg, helpers } = window.__media as NonNullable<Window['__media']>;
    const blob = helpers.blobOf(clip);

    // Warm the core up, so the abort lands in an encode and not in the download.
    await ffmpeg.probeMedia(blob);

    const controller = new AbortController();
    const started = performance.now();
    const aborted = ffmpeg
      .concatVideos([{ blob, trimEnd: 0.1 }, { blob }, { blob }, { blob }], {
        signal: controller.signal,
        onProgress: (ratio) => {
          if (ratio > 0) controller.abort();
        },
      })
      .then(
        () => 'finished',
        (error: unknown) => (error instanceof DOMException ? error.name : String(error)),
      );
    // Fall back to a timed abort in case progress never fires.
    setTimeout(() => controller.abort(), 15_000);
    const outcome = await aborted;
    const abortedAfterMs = Math.round(performance.now() - started);

    const before = new AbortController();
    before.abort();
    const alreadyAborted = await ffmpeg.probeMedia(blob, { signal: before.signal }).then(
      () => 'finished',
      (error: unknown) => (error instanceof DOMException ? error.name : String(error)),
    );

    // The next job starts a fresh instance and works.
    const info = await ffmpeg.probeMedia(blob);
    return {
      outcome,
      abortedAfterMs,
      alreadyAborted,
      duration: info.duration,
      codec: info.video?.codec,
    };
  }, fixture('video-1s.mp4'));

  expect(result.outcome).toBe('AbortError');
  // Stopped by the first progress report, not by the 15 s fallback timer.
  expect(result.abortedAfterMs).toBeLessThan(14_000);
  expect(result.alreadyAborted).toBe('AbortError');
  expect(result.duration).toBeGreaterThan(1);
  expect(result.codec).toBe('h264');
  expect(problems).toEqual([]);
});
