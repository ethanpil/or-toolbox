// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  type AudioData,
  audioSeconds,
  mixToMono,
  pcmDuration,
  peaks,
  planChunks,
  resample,
  splitForTranscription,
} from './audio';
import { parseWav } from './wav';

/** A sine tone at `amplitude`, with the listed time ranges (seconds) set to silence. */
function signal(
  seconds: number,
  rate: number,
  silences: [number, number][] = [],
  amplitude = 0.5,
): AudioData {
  const samples = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < samples.length; i++) {
    const t = i / rate;
    samples[i] = silences.some(([from, to]) => t >= from && t < to)
      ? 0
      : amplitude * Math.sin(2 * Math.PI * 440 * t);
  }
  return { sampleRate: rate, channels: [samples] };
}

describe('planChunks', () => {
  const quiet: [number, number][] = [
    [9.0, 9.4],
    [18.0, 18.5],
  ];

  it('cuts in the middle of a pause near each boundary', () => {
    const ranges = planChunks(signal(25, 8000, quiet), { maxSeconds: 10 });
    expect(ranges).toEqual([
      { start: 0, end: 73600 }, // 9.2 s: the middle of 9.0-9.4
      { start: 73600, end: 146000 }, // 18.25 s: the middle of 18.0-18.5
      { start: 146000, end: 200000 },
    ]);
  });

  it('covers the whole recording with chunks no longer than the limit', () => {
    const audio = signal(95, 8000, [[39.5, 40.5]]);
    const ranges = planChunks(audio, { maxSeconds: 30 });
    expect(ranges[0]?.start).toBe(0);
    expect(ranges.at(-1)?.end).toBe(95 * 8000);
    ranges.forEach((range, i) => {
      expect(range.end - range.start).toBeLessThanOrEqual(30 * 8000);
      expect(range.end).toBeGreaterThan(range.start);
      if (i > 0) expect(range.start).toBe(ranges[i - 1]?.end);
    });
  });

  it('falls back to the quietest frame when there is no real pause', () => {
    const audio = signal(25, 8000);
    // A dip: a 40 ms frame at a quarter of the level, around 9.3 s.
    for (let i = Math.round(9.3 * 8000); i < Math.round(9.34 * 8000); i++) {
      audio.channels[0]![i] = (audio.channels[0]![i] ?? 0) * 0.25;
    }
    const [first] = planChunks(audio, { maxSeconds: 10, minSilenceSeconds: 5 });
    expect(first?.end).toBeGreaterThan(9.28 * 8000);
    expect(first?.end).toBeLessThan(9.36 * 8000);
  });

  it('never cuts later than the limit, and not in the first half of a chunk', () => {
    const ranges = planChunks(signal(35, 8000), { maxSeconds: 10, searchSeconds: 100 });
    for (const range of ranges.slice(0, -1)) {
      expect(range.end - range.start).toBeLessThanOrEqual(10 * 8000);
      expect(range.end - range.start).toBeGreaterThanOrEqual(5 * 8000);
    }
  });

  it('finds the pauses of a quiet recording too: the threshold is relative, not absolute', () => {
    // A very quiet speaker (peak 0.006, far below any fixed "silence" level) with a room-tone pause.
    const rate = 8000;
    const audio = signal(25, rate, [], 0.006);
    const samples = audio.channels[0] as Float32Array;
    for (let i = Math.round(9.0 * rate); i < Math.round(9.4 * rate); i++) {
      samples[i] = 0.0002 * Math.sin(i * 0.37);
    }
    const [first] = planChunks(audio, { maxSeconds: 10 });
    // Cut in the middle of the pause (9.2 s), not at the 10 s limit.
    expect(first?.end).toBeGreaterThan(9.1 * rate);
    expect(first?.end).toBeLessThan(9.3 * rate);
  });

  it('cuts at a clear dip even when no pause is long enough, and never at the limit', () => {
    const rate = 8000;
    const audio = signal(25, rate, [], 0.02);
    const samples = audio.channels[0] as Float32Array;
    for (let i = Math.round(8.6 * rate); i < Math.round(8.7 * rate); i++) {
      samples[i] = (samples[i] ?? 0) * 0.1;
    }
    const [first] = planChunks(audio, { maxSeconds: 10, minSilenceSeconds: 2 });
    expect(first?.end).toBeGreaterThan(8.55 * rate);
    expect(first?.end).toBeLessThan(8.75 * rate);
  });

  it('prefers the latest of several equally good pauses in a quiet recording', () => {
    const rate = 8000;
    const audio = signal(25, rate, [], 0.005);
    const samples = audio.channels[0] as Float32Array;
    for (const [from, to] of [
      [8.0, 8.4],
      [9.3, 9.7],
    ] as const) {
      for (let i = Math.round(from * rate); i < Math.round(to * rate); i++) samples[i] = 0;
    }
    const [first] = planChunks(audio, { maxSeconds: 10 });
    expect(first?.end).toBeGreaterThan(9.4 * rate);
    expect(first?.end).toBeLessThan(9.6 * rate);
  });

  it('merges a tail shorter than one second into the previous chunk', () => {
    // 100 Hz keeps the arrays tiny; the silence makes every cut land exactly on the limit.
    const silent = (seconds: number): AudioData => ({
      sampleRate: 100,
      channels: [new Float32Array(Math.round(seconds * 100))],
    });
    expect(planChunks(silent(10.5), { maxSeconds: 10 })).toEqual([{ start: 0, end: 1050 }]);
    expect(planChunks(silent(10.99), { maxSeconds: 10 })).toEqual([{ start: 0, end: 1099 }]);
    expect(planChunks(silent(11), { maxSeconds: 10 })).toEqual([
      { start: 0, end: 1000 },
      { start: 1000, end: 1100 },
    ]);
    // Sound instead of silence, same rule.
    const ranges = planChunks(signal(10.4, 8000), { maxSeconds: 10 });
    expect(ranges.at(-1)?.end).toBe(Math.round(10.4 * 8000));
    for (const range of ranges) expect(range.end - range.start).toBeGreaterThanOrEqual(8000);
  });

  it('never leaves a short last chunk of a long silent file', () => {
    const rate = 100;
    const audio: AudioData = {
      sampleRate: rate,
      channels: [new Float32Array(Math.round(1800.4 * rate))],
    };
    const ranges = planChunks(audio, { maxSeconds: 600 });
    expect(ranges).toHaveLength(3);
    const last = ranges.at(-1);
    expect((last?.end ?? 0) - (last?.start ?? 0)).toBeGreaterThanOrEqual(rate);
    expect(last?.end).toBe(Math.round(1800.4 * rate));
  });

  it('keeps a recording shorter than one second whole', () => {
    expect(planChunks(signal(0.4, 8000), { maxSeconds: 10 })).toEqual([{ start: 0, end: 3200 }]);
  });

  it('returns one chunk for short audio, none for empty audio', () => {
    expect(planChunks(signal(5, 8000), { maxSeconds: 10 })).toEqual([{ start: 0, end: 40000 }]);
    expect(planChunks({ sampleRate: 8000, channels: [] })).toEqual([]);
    expect(planChunks({ sampleRate: 8000, channels: [new Float32Array(0)] })).toEqual([]);
  });

  it('rejects a non-positive limit', () => {
    expect(() => planChunks(signal(1, 8000), { maxSeconds: 0 })).toThrow(/maxSeconds/);
  });
});

describe('splitForTranscription', () => {
  it('encodes each chunk as 16 kHz mono WAV and reports where it starts', async () => {
    const chunks = await splitForTranscription(
      signal(25, 8000, [
        [9.0, 9.4],
        [18.0, 18.5],
      ]),
      {
        maxSeconds: 10,
      },
    );
    expect(chunks.map((chunk) => chunk.start)).toEqual([0, 9.2, 18.25]);
    expect(chunks.map((chunk) => chunk.duration)).toEqual([9.2, 9.05, 6.75]);

    for (const chunk of chunks) {
      expect(chunk.blob.type).toBe('audio/wav');
      const info = parseWav(new Uint8Array(await chunk.blob.arrayBuffer()));
      expect(info.sampleRate).toBe(16000);
      expect(info.channels).toBe(1);
      expect(info.dataBytes / 2 / 16000).toBeCloseTo(chunk.duration, 3);
    }
    // The timeline is continuous: each chunk starts where the previous one ended.
    chunks.slice(1).forEach((chunk, i) => {
      const before = chunks[i];
      expect(chunk.start).toBeCloseTo((before?.start ?? 0) + (before?.duration ?? 0), 9);
    });
  });

  it('mixes stereo down and keeps 16 kHz input as it is', async () => {
    const left = signal(3, 16000).channels[0] ?? new Float32Array(0);
    const right = new Float32Array(left.length);
    const [only] = await splitForTranscription(
      { sampleRate: 16000, channels: [left, right] },
      { maxSeconds: 60 },
    );
    const bytes = new Uint8Array((await only?.blob.arrayBuffer()) ?? new ArrayBuffer(0));
    const pcm = new Int16Array(bytes.slice(44).buffer);
    expect(pcm.length).toBe(left.length);
    // Half the left channel (the other is silent).
    const peak = Math.max(...Array.from(pcm.subarray(0, 4000), Math.abs));
    expect(peak).toBeGreaterThan(0.2 * 32767);
    expect(peak).toBeLessThan(0.3 * 32767);
  });

  it('plans a 60-minute recording at 16 kHz mono into ten-minute chunks', () => {
    // Untouched zeros cost no memory until they are read, and planning only reads near the cuts.
    const audio: AudioData = { sampleRate: 16000, channels: [new Float32Array(60 * 60 * 16000)] };
    const ranges = planChunks(audio, { maxSeconds: 600 });
    expect(ranges).toHaveLength(6);
    for (const range of ranges) expect(range.end - range.start).toBeLessThanOrEqual(600 * 16000);
    expect(ranges.at(-1)?.end).toBe(3600 * 16000);
  });
});

describe('peaks', () => {
  it('takes the loudest absolute sample in each slice, across channels', () => {
    const audio: AudioData = {
      sampleRate: 8000,
      channels: [new Float32Array([0.1, -0.5, 0.2, 0.3]), new Float32Array([0, 0, -0.9, 0])],
    };
    const result = peaks(audio, 2);
    expect(result[0]).toBeCloseTo(0.5);
    expect(result[1]).toBeCloseTo(0.9);
  });

  it('copes with more buckets than samples and with silence', () => {
    expect(Array.from(peaks({ sampleRate: 8000, channels: [new Float32Array(3)] }, 5))).toEqual([
      0, 0, 0, 0, 0,
    ]);
    expect(peaks({ sampleRate: 8000, channels: [] }, 4)).toHaveLength(4);
  });
});

describe('mixToMono and resample', () => {
  it('averages channels over a range, and returns a view when already mono', () => {
    const a = new Float32Array([1, 1, 1, 1]);
    const b = new Float32Array([0, 0.5, 1, 0]);
    expect(Array.from(mixToMono([a, b], 1, 3))).toEqual([0.75, 1]);
    expect(mixToMono([a], 1, 3).buffer).toBe(a.buffer);
  });

  it('keeps a constant level and the right length', () => {
    const flat = new Float32Array(48000).fill(0.5);
    // One second in, one second out, whatever the rates.
    for (const [from, to] of [
      [48000, 16000],
      [44100, 16000],
      [8000, 16000],
    ] as const) {
      const out = resample(new Float32Array(from).fill(0.5), from, to);
      expect(out.length).toBe(to);
      expect(out[Math.floor(out.length / 2)]).toBeCloseTo(0.5, 5);
    }
    expect(resample(flat, 48000, 48000)).toBe(flat);
  });

  it('removes content above the new Nyquist frequency instead of aliasing it', () => {
    const rate = 48000;
    const tone = new Float32Array(rate);
    for (let i = 0; i < tone.length; i++) tone[i] = Math.sin((2 * Math.PI * 20000 * i) / rate);
    const out = resample(tone, rate, 16000);
    const level = Math.sqrt(out.reduce((sum, value) => sum + value * value, 0) / out.length);
    expect(level).toBeLessThan(0.15); // a 20 kHz tone would otherwise fold back at full strength (0.7)
  });
});

describe('durations', () => {
  it('computes seconds from samples and from PCM bytes', () => {
    expect(audioSeconds(signal(2.5, 8000))).toBe(2.5);
    expect(pcmDuration(48000, 24000, 1)).toBe(1);
    expect(pcmDuration(192000, 24000, 2)).toBe(2);
  });
});
