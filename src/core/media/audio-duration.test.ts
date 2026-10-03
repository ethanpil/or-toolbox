// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAudioDuration } from './audio';
import { encodeWav, wavHeader } from './wav';

const element = vi.hoisted(() => ({ calls: [] as { kind: string }[], seconds: 7.5 }));

vi.mock('./media-element', () => ({
  mediaDuration: (_blob: Blob, kind: string): Promise<number> => {
    element.calls.push({ kind });
    return Promise.resolve(element.seconds);
  },
}));

beforeEach(() => {
  element.calls.length = 0;
});

describe('getAudioDuration', () => {
  it('measures a WAV from its header', async () => {
    expect(await getAudioDuration(encodeWav([new Float32Array(16000)], 16000))).toBe(1);
    expect(element.calls).toEqual([]);
  });

  it('asks the browser when a WAV header cannot be read', async () => {
    // RIFF/WAVE, but the chunks end before any audio data.
    const broken = new Blob([wavHeader(0, 8000, 1).subarray(0, 36)]);
    expect(await getAudioDuration(broken)).toBe(7.5);
    expect(element.calls).toEqual([{ kind: 'audio' }]);
  });

  it('asks the browser for formats it cannot measure itself', async () => {
    expect(
      await getAudioDuration(new Blob([new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0])])),
    ).toBe(7.5);
    expect(element.calls).toEqual([{ kind: 'audio' }]);
  });
});
