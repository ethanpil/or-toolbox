/** @vitest-environment node */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOTICES_FILE, runtimePackages, thirdPartyNotices } from './third-party-notices.ts';

const root = join(import.meta.dirname, '..');

describe('third-party notices', () => {
  it('lists every runtime package and the ffmpeg cores with a source pointer', () => {
    const names = runtimePackages(root).map((pkg) => pkg.name);
    for (const name of ['@ffmpeg/core', '@ffmpeg/core-mt', 'bootstrap', 'dompurify', 'jszip']) {
      expect(names).toContain(name);
    }
    expect(names.some((name) => name.startsWith('@types/'))).toBe(false);
    const text = thirdPartyNotices(root);
    expect(text).toMatch(
      /@ffmpeg\/core-mt [\d.]+: https:\/\/github\.com\/ffmpegwasm\/ffmpeg\.wasm\/tree\/[0-9a-f]{40}/,
    );
    expect(text).toContain('License: GPL-2.0-or-later');
  });

  it('matches the committed copy (regenerate: node vite-plugins/third-party-notices.ts)', () => {
    const committed = readFileSync(join(root, NOTICES_FILE), 'utf8').replace(/\r\n/g, '\n');
    expect(committed).toBe(thirdPartyNotices(root));
  });
});
