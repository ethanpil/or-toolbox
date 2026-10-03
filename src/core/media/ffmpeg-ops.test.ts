// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInputError, isAbortError } from '../errors';
import { concatVideos, probeMedia, transcodeAudio, trimMedia } from './ffmpeg-ops';

/**
 * A stand-in for the shared ffmpeg loader and instance. `exec` records its arguments, can be held
 * open with `gate`, and answers `ffmpeg -i <file>` probes with `probeLog`.
 */
const fake = vi.hoisted(() => {
  type Listener = (event: unknown) => void;

  class FakeFFmpeg {
    loaded = true;
    terminated = false;
    files = new Map<string, Uint8Array>();
    execs: string[][] = [];
    probeLog = '';
    gate: Promise<void> | undefined;
    private readonly logListeners: Listener[] = [];

    on = (event: string, listener: Listener): void => {
      if (event === 'log') this.logListeners.push(listener);
    };
    off = (event: string, listener: Listener): void => {
      const at = this.logListeners.indexOf(listener);
      if (event === 'log' && at >= 0) this.logListeners.splice(at, 1);
    };
    writeFile = (name: string, data: Uint8Array | string): Promise<boolean> => {
      this.files.set(name, typeof data === 'string' ? new TextEncoder().encode(data) : data);
      return Promise.resolve(true);
    };
    readFile = (name: string): Promise<Uint8Array> => {
      const file = this.files.get(name);
      return file ? Promise.resolve(file) : Promise.reject(new Error(`no such file ${name}`));
    };
    deleteFile = (name: string): Promise<boolean> =>
      this.files.delete(name) ? Promise.resolve(true) : Promise.reject(new Error('missing'));
    exec = async (args: string[]): Promise<number> => {
      this.execs.push(args);
      if (this.gate) await this.gate;
      if (this.terminated) throw new Error('called FFmpeg.terminate()');
      if (args.length === 2 && args[0] === '-i') {
        for (const message of this.probeLog.split('\n')) {
          for (const listener of this.logListeners) listener({ type: 'stderr', message });
        }
        return 1;
      }
      const output = args.at(-1);
      if (output) this.files.set(output, new Uint8Array([1, 2, 3]));
      return 0;
    };
    terminate = (): void => {
      this.terminated = true;
      this.loaded = false;
    };
  }

  const state = {
    instance: new FakeFFmpeg(),
    loadGate: undefined as Promise<void> | undefined,
    loads: 0,
    disposed: 0,
  };
  return { FakeFFmpeg, state };
});

vi.mock('./ffmpeg', () => ({
  loadFfmpeg: async () => {
    fake.state.loads++;
    if (fake.state.loadGate) await fake.state.loadGate;
    if (!fake.state.instance.loaded) fake.state.instance = new fake.FakeFFmpeg();
    return { ffmpeg: fake.state.instance, multiThreaded: false };
  },
  disposeFfmpeg: () => {
    fake.state.disposed++;
    fake.state.instance.terminate();
  },
}));

const VIDEO_LOG = `  Duration: 00:00:02.00, start: 0.000000, bitrate: 900 kb/s
  Stream #0:0: Video: h264 (High), yuv420p(progressive), 543x543 [SAR 1:1 DAR 1:1], 24 fps, 24 tbr, 12288 tbn
  Stream #0:1: Audio: aac (LC), 44100 Hz, stereo, fltp, 69 kb/s`;
const AUDIO_ONLY_LOG = `  Duration: 00:00:02.00, start: 0.000000, bitrate: 128 kb/s
  Stream #0:0: Audio: opus, 48000 Hz, stereo, fltp`;

/** `head` followed by zeros, 40 bytes in all. */
const padded = (head: number[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(40);
  out.set(head);
  return out;
};
/** Starts with the bytes that make `sniffMime` call it an MP4 (the brand says video; the streams may not). */
const mp4 = (): Blob =>
  new Blob([padded([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])]);
/** Starts with an ID3 tag: an MP3. */
const mp3 = (): Blob => new Blob([padded([0x49, 0x44, 0x33, 4])]);

/** A promise that resolves when `open()` is called. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Lets pending promise callbacks run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  fake.state.instance = new fake.FakeFFmpeg();
  fake.state.loadGate = undefined;
  fake.state.loads = 0;
  fake.state.disposed = 0;
});

describe('job queue', () => {
  it('runs one job at a time, in order', async () => {
    const { instance } = fake.state;
    const hold = gate();
    instance.gate = hold.promise;
    const first = transcodeAudio(mp3(), 'wav');
    const second = transcodeAudio(mp3(), 'wav');
    await settle();
    expect(instance.execs).toHaveLength(1);
    hold.open();
    await Promise.all([first, second]);
    expect(instance.execs).toHaveLength(2);
  });

  it('rejects at once when aborted while waiting its turn, and never starts', async () => {
    const { instance } = fake.state;
    const hold = gate();
    instance.gate = hold.promise;
    const running = transcodeAudio(mp3(), 'wav');
    const controller = new AbortController();
    const queued = transcodeAudio(mp3(), 'mp3', { signal: controller.signal });
    const after = transcodeAudio(mp3(), 'wav');
    await settle();

    controller.abort();
    // It settles while the first job is still held: no waiting for its turn.
    const outcome = await Promise.race([
      queued.then(
        () => 'finished',
        (error: unknown) => (isAbortError(error) ? 'aborted' : 'other error'),
      ),
      settle().then(() => 'still waiting'),
    ]);
    expect(outcome).toBe('aborted');
    expect(fake.state.disposed).toBe(0); // the running job was not touched

    hold.open();
    await Promise.all([running, after]);
    // The aborted job never reached ffmpeg: two execs (first and third), none with libmp3lame.
    expect(instance.execs).toHaveLength(2);
    expect(instance.execs.flat()).not.toContain('libmp3lame');
  });

  it('keeps a job queued behind an aborted one waiting for the running one', async () => {
    const { instance } = fake.state;
    const hold = gate();
    instance.gate = hold.promise;
    const running = transcodeAudio(mp3(), 'wav');
    const controller = new AbortController();
    const aborted = transcodeAudio(mp3(), 'wav', { signal: controller.signal });
    const third = transcodeAudio(mp3(), 'wav');
    await settle();
    controller.abort();
    await expect(aborted).rejects.toSatisfy(isAbortError);
    await settle();
    expect(instance.execs).toHaveLength(1); // the third did not jump the queue
    hold.open();
    await Promise.all([running, third]);
    expect(instance.execs).toHaveLength(2);
  });

  it('rejects immediately for a signal that is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(transcodeAudio(mp3(), 'wav', { signal: controller.signal })).rejects.toSatisfy(
      isAbortError,
    );
    expect(fake.state.loads).toBe(0);
  });

  it('stops waiting for the core to load when aborted, and does not run afterwards', async () => {
    const hold = gate();
    fake.state.loadGate = hold.promise;
    const controller = new AbortController();
    const job = transcodeAudio(mp3(), 'wav', { signal: controller.signal });
    await settle();
    expect(fake.state.loads).toBe(1);

    controller.abort();
    await expect(job).rejects.toSatisfy(isAbortError);

    hold.open();
    await settle();
    expect(fake.state.instance.execs).toHaveLength(0);
    // The queue moved on: the next job runs.
    fake.state.loadGate = undefined;
    await transcodeAudio(mp3(), 'wav');
    expect(fake.state.instance.execs).toHaveLength(1);
  });

  it('terminates ffmpeg when aborted mid-run, and the next job gets a fresh instance', async () => {
    const hold = gate();
    fake.state.instance.gate = hold.promise;
    const controller = new AbortController();
    const job = transcodeAudio(mp3(), 'wav', { signal: controller.signal });
    await settle();
    controller.abort();
    hold.open();
    await expect(job).rejects.toSatisfy(isAbortError);
    expect(fake.state.disposed).toBe(1);

    const stale = fake.state.instance;
    await transcodeAudio(mp3(), 'wav');
    expect(fake.state.instance).not.toBe(stale);
  });

  it('deletes every file it wrote, also when the job fails', async () => {
    const { instance } = fake.state;
    await transcodeAudio(mp3(), 'wav');
    expect([...instance.files.keys()]).toEqual([]);

    instance.exec = (args: string[]): Promise<number> => {
      instance.execs.push(args);
      return Promise.resolve(1);
    };
    await expect(transcodeAudio(mp3(), 'wav')).rejects.toThrow(InvalidInputError);
    expect([...instance.files.keys()]).toEqual([]);
  });
});

describe('trimMedia', () => {
  const trimArgs = (): string[] => fake.state.instance.execs.at(-1) ?? [];

  it('trusts a caller hint without probing', async () => {
    const out = await trimMedia(mp4(), 1, 2, { kind: 'audio' });
    expect(fake.state.instance.execs).toHaveLength(1);
    expect(trimArgs()).toContain('pcm_s16le');
    expect(trimArgs()).not.toContain('libx264');
    expect(out.type).toBe('audio/wav');

    const video = await trimMedia(mp4(), 1, 2, { kind: 'video' });
    expect(trimArgs()).toContain('libx264');
    expect(video.type).toBe('video/mp4');
  });

  it('probes the streams: an audio-only MP4 or WebM stays audio even though its container says video', async () => {
    fake.state.instance.probeLog = AUDIO_ONLY_LOG;
    const out = await trimMedia(mp4(), 0.5, 1.5);
    const [probe, trim] = fake.state.instance.execs;
    expect(probe).toEqual(['-i', expect.stringMatching(/^j\d+-in\.mp4$/)]);
    expect(trim).toContain('pcm_s16le');
    expect(trim).not.toContain('libx264');
    expect(out.type).toBe('audio/wav');
  });

  it('keeps MP3 as MP3', async () => {
    fake.state.instance.probeLog = AUDIO_ONLY_LOG;
    const out = await trimMedia(mp3(), 0, 1);
    expect(trimArgs()).toContain('libmp3lame');
    expect(out.type).toBe('audio/mpeg');
  });

  it('makes real video H.264 with even dimensions', async () => {
    fake.state.instance.probeLog = VIDEO_LOG;
    const out = await trimMedia(mp4(), 0, 1);
    const args = trimArgs();
    expect(args).toContain('libx264');
    expect(args[args.indexOf('-vf') + 1]).toBe('pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:black');
    expect(out.type).toBe('video/mp4');
  });

  it('reads the extension of ffmpeg input from the one sniff it does', async () => {
    fake.state.instance.probeLog = VIDEO_LOG;
    await trimMedia(mp4(), 0, 1);
    const inputs = fake.state.instance.execs.map((args) => args[args.indexOf('-i') + 1]);
    expect(inputs.every((name) => /-in\.mp4$/.test(name ?? ''))).toBe(true);
  });

  it('rejects impossible ranges', () => {
    expect(() => trimMedia(mp4(), -1, 2)).toThrow(RangeError);
    expect(() => trimMedia(mp4(), 2, 1)).toThrow(RangeError);
  });
});

describe('probeMedia and concatVideos', () => {
  it('reads the streams from the log', async () => {
    fake.state.instance.probeLog = VIDEO_LOG;
    const info = await probeMedia(mp4());
    expect(info.video).toMatchObject({ codec: 'h264', width: 543, height: 543, fps: 24 });
    expect(info.audio).toMatchObject({ codec: 'aac', sampleRate: 44100, channels: 2 });
  });

  it('refuses a clip without video with an input error', async () => {
    fake.state.instance.probeLog = AUDIO_ONLY_LOG;
    await expect(concatVideos([{ blob: mp3() }])).rejects.toThrow(InvalidInputError);
  });

  it('normalises odd-sized clips to even dimensions when it re-encodes', async () => {
    fake.state.instance.probeLog = VIDEO_LOG;
    await concatVideos([{ blob: mp4() }, { blob: mp4(), dropFirstFrame: true }]);
    const filters = fake.state.instance.execs
      .filter((args) => args.includes('-vf'))
      .map((args) => args[args.indexOf('-vf') + 1] ?? '');
    expect(filters.length).toBe(2);
    for (const filter of filters) expect(filter).toContain('scale=544:544');
  });
});
