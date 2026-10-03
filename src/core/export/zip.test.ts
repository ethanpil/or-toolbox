// @vitest-environment node
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { InvalidInputError } from '../errors';
import { zipFiles } from './zip';

async function unzip(blob: Blob): Promise<Record<string, Uint8Array>> {
  return unzipSync(new Uint8Array(await blob.arrayBuffer()));
}

describe('zipFiles', () => {
  it('stores every kind of data', async () => {
    const zip = await zipFiles([
      { name: 'text.txt', data: 'héllo' },
      { name: 'blob.bin', data: new Blob([new Uint8Array([1, 2, 3])]) },
      { name: 'bytes.bin', data: new Uint8Array([4, 5]) },
      { name: 'buffer.bin', data: new Uint8Array([6]).buffer },
    ]);
    expect(zip.type).toBe('application/zip');
    const files = await unzip(zip);
    expect(strFromU8(files['text.txt'] ?? new Uint8Array())).toBe('héllo');
    expect([...(files['blob.bin'] ?? [])]).toEqual([1, 2, 3]);
    expect([...(files['bytes.bin'] ?? [])]).toEqual([4, 5]);
    expect([...(files['buffer.bin'] ?? [])]).toEqual([6]);
  });

  it('makes names unique, ignoring case, per folder', async () => {
    const zip = await zipFiles([
      { name: 'a.txt', data: '1' },
      { name: 'a.txt', data: '2' },
      { name: 'A.TXT', data: '3' },
      { name: 'dir/a.txt', data: '4' },
      { name: 'dir/a.txt', data: '5' },
    ]);
    const files = await unzip(zip);
    expect(Object.keys(files).sort()).toEqual([
      'A (3).TXT',
      'a (2).txt',
      'a.txt',
      'dir/a (2).txt',
      'dir/a.txt',
    ]);
    expect(strFromU8(files['a (2).txt'] ?? new Uint8Array())).toBe('2');
    expect(strFromU8(files['dir/a (2).txt'] ?? new Uint8Array())).toBe('5');
  });

  it('keeps names free of characters Windows forbids and fills in empty ones', async () => {
    const zip = await zipFiles([
      { name: 'a/./b/c?.txt', data: '1' },
      { name: 'x\\y<z>.txt', data: '2' },
      { name: '', data: '3' },
    ]);
    expect(Object.keys(await unzip(zip)).sort()).toEqual(['a/b/c_.txt', 'file', 'x/y_z_.txt']);
  });

  it('rejects names that climb out of the archive or are absolute', async () => {
    for (const name of [
      '../evil.txt',
      'a/../b.txt',
      '..\\evil.txt',
      '/abs/path.txt',
      '\\share\\x',
      'C:\\x\\y.txt',
      'c:/x.txt',
    ]) {
      await expect(zipFiles([{ name, data: 'x' }]), name).rejects.toThrow(InvalidInputError);
    }
  });

  it('treats folders case-insensitively, like Windows and macOS', async () => {
    const zip = await zipFiles([
      { name: 'Dir/a.txt', data: '1' },
      { name: 'dir/a.txt', data: '2' },
      { name: 'DIR/b.txt', data: '3' },
    ]);
    expect(Object.keys(await unzip(zip)).sort()).toEqual([
      'Dir/a (2).txt',
      'Dir/a.txt',
      'Dir/b.txt',
    ]);
  });

  it('never lets a file and a folder share a name', async () => {
    const fileFirst = await zipFiles([
      { name: 'a', data: '1' },
      { name: 'a/b.txt', data: '2' },
    ]);
    expect(Object.keys(await unzip(fileFirst)).sort()).toEqual(['a', 'a (2)/b.txt']);

    const folderFirst = await zipFiles([
      { name: 'a/b.txt', data: '1' },
      { name: 'A', data: '2' },
    ]);
    expect(Object.keys(await unzip(folderFirst)).sort()).toEqual(['A (2)', 'a/b.txt']);
  });

  it('deflates text but stores formats that are already compressed', async () => {
    const repetitive = 'abcdefgh'.repeat(5000);
    const bytes = new TextEncoder().encode(repetitive);
    const text = await zipFiles([{ name: 'a.txt', data: bytes }]);
    const png = await zipFiles([{ name: 'a.png', data: bytes }]);
    expect(text.size).toBeLessThan(bytes.length / 10);
    expect(png.size).toBeGreaterThan(bytes.length);
  });

  it('writes an empty archive for no files', async () => {
    expect(Object.keys(await unzip(await zipFiles([])))).toEqual([]);
  });
});
