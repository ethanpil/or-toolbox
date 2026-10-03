/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyFilenamePattern,
  downloadBlob,
  formatBytes,
  formatDuration,
  readAsArrayBuffer,
  readAsBase64,
  readAsDataUrl,
  readAsText,
  sanitizeFilename,
  sniffBlobMime,
  sniffMime,
  uniqueFilename,
} from './files';

const fixture = (name: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(readFileSync(join('tests', 'fixtures', 'media', name))); // tests run from the project root

/** `prefix` then enough zeros to look like the start of a file. */
const bytes = (...values: (number | string)[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(32);
  let at = 0;
  for (const value of values) {
    if (typeof value === 'number') out[at++] = value;
    else for (const char of value) out[at++] = char.charCodeAt(0);
  }
  return out;
};

describe('sniffMime', () => {
  it('recognises the fixture files', () => {
    expect(sniffMime(fixture('speech.mp3'))).toBe('audio/mpeg');
    expect(sniffMime(fixture('video-1s.mp4'))).toBe('video/mp4');
    expect(sniffMime(fixture('invoice.pdf'))).toBe('application/pdf');
    expect(sniffMime(fixture('generated-image.jpg'))).toBe('image/jpeg');
    expect(sniffMime(fixture('edited-image.jpg'))).toBe('image/jpeg');
  });

  it('recognises each format by its signature', () => {
    expect(sniffMime(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
    expect(sniffMime(bytes('GIF89a'))).toBe('image/gif');
    expect(sniffMime(bytes('GIF87a'))).toBe('image/gif');
    expect(sniffMime(bytes('RIFF', 0, 0, 0, 0, 'WEBP'))).toBe('image/webp');
    expect(sniffMime(bytes('RIFF', 0, 0, 0, 0, 'WAVE'))).toBe('audio/wav');
    expect(sniffMime(bytes('OggS'))).toBe('audio/ogg');
    expect(sniffMime(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe('video/webm');
    expect(sniffMime(bytes('PK', 3, 4))).toBe('application/zip');
    expect(sniffMime(bytes('ID3', 4))).toBe('audio/mpeg');
    expect(sniffMime(bytes(0xff, 0xfb, 0x90, 0x00))).toBe('audio/mpeg');
    expect(sniffMime(bytes(0, 0, 0, 0x20, 'ftypisom'))).toBe('video/mp4');
    expect(sniffMime(bytes(0, 0, 0, 0x20, 'ftypM4A '))).toBe('audio/mp4');
    expect(sniffMime(bytes(0, 0, 0, 0x14, 'ftypqt  '))).toBe('video/quicktime');
  });

  it('returns null for anything else, including AAC frames that look like MP3 sync', () => {
    expect(sniffMime(new Uint8Array(0))).toBeNull();
    expect(sniffMime(bytes('hello world'))).toBeNull();
    expect(sniffMime(bytes('RIFF', 0, 0, 0, 0, 'AVI '))).toBeNull();
    expect(sniffMime(bytes(0xff, 0xf1, 0x50, 0x80))).toBeNull(); // ADTS: layer bits 00
  });

  it('sniffs a Blob', async () => {
    expect(await sniffBlobMime(new Blob([fixture('invoice.pdf')]))).toBe('application/pdf');
  });
});

describe('formatBytes', () => {
  it('uses binary units with at most one decimal', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(-4)).toBe('0 B');
  });
});

describe('formatDuration', () => {
  it('shows m:ss, and h:mm:ss from one hour', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9)).toBe('0:09');
    expect(formatDuration(83)).toBe('1:23');
    expect(formatDuration(59.9)).toBe('0:59');
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(Number.NaN)).toBe('0:00');
    expect(formatDuration(-5)).toBe('0:00');
    expect(formatDuration(Infinity)).toBe('0:00');
  });
});

describe('sanitizeFilename', () => {
  it('replaces characters Windows forbids', () => {
    expect(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j.txt')).toBe('a_b_c_d_e_f_g_h_i_j.txt');
    expect(sanitizeFilename('tab\there\u0000nul')).toBe('tab_here_nul');
  });

  it('removes trailing dots and spaces, and bidi overrides', () => {
    expect(sanitizeFilename('report. . ')).toBe('report');
    expect(sanitizeFilename('inv‮gpj.exe')).toBe('invgpj.exe');
  });

  it('avoids reserved device names', () => {
    expect(sanitizeFilename('CON')).toBe('_CON');
    expect(sanitizeFilename('nul.txt')).toBe('_nul.txt');
    expect(sanitizeFilename('LPT1.tar.gz')).toBe('_LPT1.tar.gz');
    expect(sanitizeFilename('console.txt')).toBe('console.txt');
  });

  it('never returns an empty name', () => {
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('...')).toBe('file');
    expect(sanitizeFilename('   ')).toBe('file');
    expect(sanitizeFilename('', 'image')).toBe('image');
  });

  it('caps the length and keeps the extension', () => {
    const name = sanitizeFilename(`${'x'.repeat(300)}.jpg`);
    expect(name.length).toBeLessThanOrEqual(180);
    expect(name.endsWith('.jpg')).toBe(true);
  });

  it('keeps ordinary names as they are', () => {
    expect(sanitizeFilename('Quarterly report (final) v2.xlsx')).toBe(
      'Quarterly report (final) v2.xlsx',
    );
    expect(sanitizeFilename('naïve café 日本語.png')).toBe('naïve café 日本語.png');
  });
});

describe('applyFilenamePattern', () => {
  it('fills placeholders', () => {
    expect(applyFilenamePattern('{name}-{n}.{ext}', { name: 'shoe', n: 2, ext: 'jpg' })).toBe(
      'shoe-2.jpg',
    );
  });

  it('pads numbers with {n:3}', () => {
    expect(applyFilenamePattern('{name}-{n:3}.{ext}', { name: 'shoe', n: 2, ext: 'jpg' })).toBe(
      'shoe-002.jpg',
    );
  });

  it('keeps unknown placeholders visible and sanitises the result', () => {
    expect(applyFilenamePattern('{nope}-{name}.png', { name: 'a/b' })).toBe('{nope}-a_b.png');
  });
});

describe('uniqueFilename', () => {
  it('numbers repeats before the extension, ignoring case', () => {
    const used = new Set<string>();
    expect(uniqueFilename('a.png', used)).toBe('a.png');
    expect(uniqueFilename('a.png', used)).toBe('a (2).png');
    expect(uniqueFilename('A.PNG', used)).toBe('A (3).PNG');
    expect(uniqueFilename('notes', used)).toBe('notes');
    expect(uniqueFilename('notes', used)).toBe('notes (2)');
  });
});

describe('reading Blobs', () => {
  it('reads text, buffers, base64 and data URLs', async () => {
    const hello = new Blob(['hi'], { type: 'text/plain' });
    expect(await readAsText(new Blob(['héllo']))).toBe('héllo');
    expect((await readAsArrayBuffer(hello)).byteLength).toBe(2);
    expect(await readAsBase64(hello)).toBe('aGk=');
    expect(await readAsDataUrl(hello)).toBe('data:text/plain;base64,aGk=');
  });

  it('sniffs a type for a Blob that has none', async () => {
    const png = new Blob([bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a)]);
    expect(await readAsDataUrl(png)).toMatch(/^data:image\/png;base64,/);
  });
});

describe('downloadBlob', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clicks a download link and revokes the URL later', () => {
    vi.useFakeTimers();
    const revoke = vi.fn();
    URL.createObjectURL = vi.fn(() => 'blob:fake');
    URL.revokeObjectURL = revoke;
    const clicked: { download: string; href: string; attached: boolean }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ download: this.download, href: this.href, attached: this.isConnected });
    });

    downloadBlob(new Blob(['x']), 'a:b.txt');

    expect(clicked).toEqual([{ download: 'a_b.txt', href: 'blob:fake', attached: true }]);
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revoke).toHaveBeenCalledWith('blob:fake');
  });
});
