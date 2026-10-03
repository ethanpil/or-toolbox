import { describe, expect, it } from 'vitest';
import { acceptsFile, describeAccept, fileMime, mimeMatches, partitionFiles } from './file-types';

describe('fileMime', () => {
  it('prefers the browser type and falls back to the extension', () => {
    expect(fileMime({ type: 'image/PNG', name: 'a.jpg' })).toBe('image/png');
    expect(fileMime({ type: '', name: 'notes.MD' })).toBe('text/markdown');
    expect(fileMime({ type: '', name: 'clip.mov' })).toBe('video/quicktime');
    expect(fileMime({ type: '', name: 'unknown.xyz' })).toBe('');
    expect(fileMime({ type: '' })).toBe('');
  });
});

describe('mimeMatches', () => {
  it('matches exact types, wildcards and */*', () => {
    expect(mimeMatches('image/png', ['image/png'])).toBe(true);
    expect(mimeMatches('audio/wav', ['audio/*'])).toBe(true);
    expect(mimeMatches('video/mp4', ['audio/*'])).toBe(false);
    expect(mimeMatches('application/pdf', ['*/*'])).toBe(true);
    expect(mimeMatches('', ['*/*'])).toBe(false);
  });
});

describe('acceptsFile and partitionFiles', () => {
  const accept = ['image/png', 'image/jpeg', 'application/pdf'];
  it('splits files into accepted and rejected', () => {
    const files = [
      { type: 'image/png', name: 'a.png' },
      { type: '', name: 'b.pdf' },
      { type: 'text/plain', name: 'c.txt' },
    ];
    const { accepted, rejected } = partitionFiles(files, accept);
    expect(accepted.map((f) => f.name)).toEqual(['a.png', 'b.pdf']);
    expect(rejected.map((f) => f.name)).toEqual(['c.txt']);
    expect(acceptsFile({ type: 'image/webp', name: 'x.webp' }, accept)).toBe(false);
  });
});

describe('describeAccept', () => {
  it('names accepted types for people', () => {
    expect(describeAccept(['image/png', 'image/jpeg', 'image/webp', 'application/pdf'])).toBe(
      'PNG, JPEG, WebP or PDF',
    );
    expect(describeAccept(['audio/*', 'video/*'])).toBe('audio or video');
    expect(describeAccept(['text/plain'])).toBe('text');
    expect(describeAccept([])).toBe('');
  });
});
