import { expect, test } from '../../mock/index.ts';
import { fixture, openMediaPage } from './support.ts';

test.setTimeout(180_000);

test('decodes, measures, splits and re-encodes audio', async ({ page }) => {
  const problems = await openMediaPage(page);

  const result = await page.evaluate(async (speech) => {
    const { audio, helpers } = window.__media as NonNullable<Window['__media']>;
    const blob = helpers.blobOf(speech);

    // Decoding, with the browser resampling to 16 kHz mono (the speech-to-text default).
    const decoded = await audio.decodeAudio(blob, { sampleRate: 16000, mono: true });
    const native = await audio.decodeAudio(blob);
    const waveform = audio.peaks(decoded, 20);

    // Durations: exact from the MP3 frames, and from a WAV header.
    const mp3Seconds = await audio.getAudioDuration(blob);
    const wav = audio.encodeWav(decoded.channels, decoded.sampleRate);
    const wavSeconds = await audio.getAudioDuration(wav);

    // Round trip: our WAV decodes back to the same samples.
    const again = await audio.decodeAudio(wav, { sampleRate: 16000, mono: true });
    let largestError = 0;
    for (let i = 0; i < decoded.channels[0]!.length; i++) {
      largestError = Math.max(
        largestError,
        Math.abs((decoded.channels[0]![i] ?? 0) - (again.channels[0]![i] ?? 0)),
      );
    }

    // Splitting a 3.2 s recording with a one second limit.
    const chunks = await audio.splitForTranscription(decoded, { maxSeconds: 1 });
    const chunkInfo = await Promise.all(
      chunks.map(async (chunk) => ({
        start: chunk.start,
        duration: chunk.duration,
        seconds: await audio.getAudioDuration(chunk.blob),
        sampleRate: audio.parseWav(new Uint8Array(await chunk.blob.arrayBuffer())).sampleRate,
      })),
    );

    // Raw PCM from a PCM-only TTS model: wrap, and play back through an <audio> element.
    const pcm = new Int16Array(24000);
    for (let i = 0; i < pcm.length; i++)
      pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24000));
    const format = audio.parsePcmContentType('audio/pcm;rate=24000;channels=1');
    const pcmWav = audio.pcmToWav(
      new Uint8Array(pcm.buffer),
      format?.sampleRate ?? 0,
      format?.channels ?? 0,
    );
    const element = new Audio(URL.createObjectURL(pcmWav));
    await new Promise<void>((resolve, reject) => {
      element.addEventListener('loadedmetadata', () => resolve(), { once: true });
      element.addEventListener('error', () => reject(new Error('cannot play the PCM WAV')), {
        once: true,
      });
    });

    // Stitching two MP3 segments: the joined file is playable and twice as long.
    const joined = await audio.concatMp3([blob, blob]);
    const joinedElement = new Audio(URL.createObjectURL(joined));
    await new Promise<void>((resolve, reject) => {
      joinedElement.addEventListener('loadedmetadata', () => resolve(), { once: true });
      joinedElement.addEventListener(
        'error',
        () => reject(new Error('cannot play the joined MP3')),
        { once: true },
      );
    });

    // Something that is not audio.
    const notAudio = await audio.decodeAudio(new Blob(['not audio at all'])).then(
      () => 'decoded',
      (error: unknown) => (error as Error).message,
    );

    return {
      decoded: {
        rate: decoded.sampleRate,
        channels: decoded.channels.length,
        seconds: audio.audioSeconds(decoded),
      },
      native: { rate: native.sampleRate, channels: native.channels.length },
      peak: Math.max(...waveform),
      waveformLength: waveform.length,
      mp3Seconds,
      wavSeconds,
      largestError,
      chunkInfo,
      pcmSeconds: element.duration,
      joinedSeconds: joinedElement.duration,
      joinedFrameSeconds: await audio.getAudioDuration(joined),
      notAudio,
    };
  }, fixture('speech.mp3'));

  expect(result.decoded.rate).toBe(16000);
  expect(result.decoded.channels).toBe(1);
  expect(result.decoded.seconds).toBeGreaterThan(3.1);
  expect(result.decoded.seconds).toBeLessThan(3.4);
  expect(result.native.rate).toBe(44100);
  expect(result.peak).toBeGreaterThan(0.05);
  expect(result.waveformLength).toBe(20);

  expect(result.mp3Seconds).toBeCloseTo(result.decoded.seconds, 0);
  expect(result.wavSeconds).toBeCloseTo(result.decoded.seconds, 3);
  expect(result.largestError).toBeLessThan(0.001); // 16-bit rounding

  expect(result.chunkInfo).toHaveLength(4);
  for (const chunk of result.chunkInfo) {
    expect(chunk.duration).toBeLessThanOrEqual(1);
    expect(chunk.sampleRate).toBe(16000);
    expect(chunk.seconds).toBeCloseTo(chunk.duration, 3);
  }
  result.chunkInfo.slice(1).forEach((chunk, i) => {
    const before = result.chunkInfo[i];
    expect(chunk.start).toBeCloseTo((before?.start ?? 0) + (before?.duration ?? 0), 9);
  });

  expect(result.pcmSeconds).toBeCloseTo(1, 2);
  expect(result.joinedSeconds).toBeCloseTo(result.joinedFrameSeconds, 1);
  expect(result.joinedFrameSeconds).toBeCloseTo(result.mp3Seconds * 2, 1);
  expect(result.notAudio).toMatch(/cannot be decoded/);
  expect(problems).toEqual([]);
});
