/** @vitest-environment node */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Manifest } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { contentSecurityPolicy, documentHeaderPolicy, workerPolicy } from './csp.ts';
import { PRECACHE_MAX_BYTES, swManifest } from './service-worker.ts';

let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(files: Record<string, string | number>): void {
  dir = mkdtempSync(join(tmpdir(), 'sw-manifest-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof body === 'number' ? Buffer.alloc(body, 1) : body);
  }
}

describe('swManifest', () => {
  const VITE: Manifest = {
    'index.html': {
      file: 'assets/index-a.js',
      isEntry: true,
      imports: ['_shell'],
      css: ['assets/shell-a.css'],
    },
    _shell: { file: 'assets/shell-a.js', assets: ['assets/icons-a.woff2'] },
  };

  it('hashes every asset and precaches the eager closure plus small lazy JS/CSS', () => {
    write({
      'index.html': '<!doctype html>',
      'settings/index.html': '<!doctype html>',
      'theme-init.js': 'x',
      'licenses.txt': 'notices',
      'assets/index-a.js': 'a',
      'assets/shell-a.js': 'b',
      'assets/shell-a.css': 'c',
      'assets/icons-a.woff2': 'd',
      'assets/lazy-a.js': 'e',
      'assets/lazy-a.css': 'f',
      'assets/pdf.worker.min-a.mjs': PRECACHE_MAX_BYTES + 1,
      'assets/openjpeg-a.wasm': 10,
      'assets/font-a.ttf': 10,
      'vendor/ffmpeg/core-1/ffmpeg-core.js': 'g',
    });
    const manifest = swManifest(dir, VITE);

    expect(Object.keys(manifest.pages)).toEqual([
      'index.html',
      'settings/index.html',
      'theme-init.js',
    ]);
    expect(manifest.pages['theme-init.js']).toBe(createHash('sha256').update('x').digest('hex'));
    expect(Object.keys(manifest.assets).sort()).toEqual(
      [
        'assets/font-a.ttf',
        'assets/icons-a.woff2',
        'assets/index-a.js',
        'assets/lazy-a.css',
        'assets/lazy-a.js',
        'assets/openjpeg-a.wasm',
        'assets/pdf.worker.min-a.mjs',
        'assets/shell-a.css',
        'assets/shell-a.js',
        'vendor/ffmpeg/core-1/ffmpeg-core.js',
      ].sort(),
    );
    expect(manifest.precache.sort()).toEqual([
      'assets/icons-a.woff2',
      'assets/index-a.js',
      'assets/lazy-a.css',
      'assets/lazy-a.js',
      'assets/shell-a.css',
      'assets/shell-a.js',
    ]);
    expect(manifest.csp).toEqual({ document: documentHeaderPolicy(), worker: workerPolicy() });
  });

  it('changes version when any byte changes', () => {
    write({ 'index.html': 'a', 'assets/index-a.js': 'a' });
    const first = swManifest(dir, VITE).version;
    writeFileSync(join(dir, 'assets/index-a.js'), 'b');
    expect(swManifest(dir, VITE).version).not.toBe(first);
  });
});

describe('header policies', () => {
  it('documents get the meta policy plus frame-ancestors', () => {
    expect(documentHeaderPolicy()).toBe(`${contentSecurityPolicy()}; frame-ancestors 'none'`);
  });

  it('workers get the same sources without document-only directives', () => {
    const worker = workerPolicy();
    expect(worker).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(worker).toContain("worker-src 'self'");
    expect(worker).toContain('connect-src');
    expect(worker).not.toMatch(/base-uri|form-action|frame-src|frame-ancestors/);
  });
});
