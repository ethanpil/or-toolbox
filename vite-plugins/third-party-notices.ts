import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Third-party notices. The minified bundles drop the license comments of the
 * packages they contain, and vendor/ffmpeg/ ships the GPL ffmpeg.wasm cores,
 * so the site carries one plain-text file listing every package it bundles or
 * copies, with its license text:
 *
 * - `licenses.txt` in the build (written by ffmpeg-assets.ts), always
 *   generated from node_modules as installed;
 * - `THIRD-PARTY-NOTICES.txt` in the repository, the same text, kept in step
 *   by third-party-notices.test.ts. Regenerate it with
 *   `node vite-plugins/third-party-notices.ts`.
 *
 * The list is the closure of package.json `dependencies` over each package's
 * own `dependencies` (type packages left out): a superset of what the bundles
 * contain, which is the safe side for a notices file. Versions are left out
 * except for the ffmpeg cores, whose source pointer needs one, so the file
 * changes only when a package or a license does.
 */

/**
 * The commit of github.com/ffmpegwasm/ffmpeg.wasm that released each
 * @ffmpeg/core and @ffmpeg/core-mt version (its tags do not match the core
 * versions). Its Dockerfile and build scripts pin the FFmpeg and library
 * sources the wasm was built from. Add the new commit when upgrading.
 */
const FFMPEG_CORE_SOURCE: Record<string, string> = {
  '0.12.10': '71aa99d37c02a7b4c435275ca9ef50e612f6efa1',
};

const FFMPEG_REPOSITORY = 'https://github.com/ffmpegwasm/ffmpeg.wasm';
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\..*)?$/i;

interface PackageInfo {
  name: string;
  version: string;
  license: string;
  author: string | null;
  repository: string | null;
  /** License (and NOTICE) files the package ships, with their text. */
  files: { name: string; text: string }[];
}

interface PackageJson {
  name: string;
  version: string;
  license?: string;
  author?: string | { name?: string };
  repository?: string | { url?: string };
  dependencies?: Record<string, string>;
}

const readJson = (path: string): PackageJson =>
  JSON.parse(readFileSync(path, 'utf8')) as PackageJson;

/** Normalises line endings and trailing space, so the text is the same on every OS. */
const clean = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();

function repositoryUrl(repository: PackageJson['repository']): string | null {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (!raw) return null;
  return raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '');
}

/** Every runtime package, sorted by name. */
export function runtimePackages(root: string): PackageInfo[] {
  const found = new Map<string, PackageInfo>();
  const queue: { name: string; from: string }[] = Object.keys(
    readJson(join(root, 'package.json')).dependencies ?? {},
  ).map((name) => ({ name, from: root }));

  for (let next = queue.shift(); next; next = queue.shift()) {
    const { name, from } = next;
    if (name.startsWith('@types/') || found.has(name)) continue;
    // Nested copy first (a version conflict), then the hoisted one.
    const nested = join(from, 'node_modules', name);
    const dir = existsSync(join(nested, 'package.json'))
      ? nested
      : join(root, 'node_modules', name);
    const pkg = readJson(join(dir, 'package.json'));
    found.set(name, {
      name,
      version: pkg.version,
      license: pkg.license ?? 'UNKNOWN',
      author: typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name ?? null),
      repository: repositoryUrl(pkg.repository),
      files: readdirSync(dir)
        .filter((file) => LICENSE_FILE.test(file))
        .sort()
        .map((file) => ({ name: file, text: clean(readFileSync(join(dir, file), 'utf8')) })),
    });
    for (const dependency of Object.keys(pkg.dependencies ?? {})) {
      queue.push({ name: dependency, from: dir });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const RULE = '='.repeat(78);

/** The notices text. Throws if an ffmpeg core version has no recorded source commit. */
export function thirdPartyNotices(root: string): string {
  const packages = runtimePackages(root);
  const cores = packages.filter((pkg) => /^@ffmpeg\/core(-mt)?$/.test(pkg.name));
  const coreLines = cores.map((core) => {
    const commit = FFMPEG_CORE_SOURCE[core.version];
    if (!commit) {
      throw new Error(
        `third-party-notices: no source commit recorded for ${core.name} ${core.version}; ` +
          'add it to FFMPEG_CORE_SOURCE in vite-plugins/third-party-notices.ts.',
      );
    }
    return `- ${core.name} ${core.version}: ${FFMPEG_REPOSITORY}/tree/${commit}`;
  });

  const sections = packages.map((pkg) => {
    const head = [
      RULE,
      pkg.name,
      `License: ${pkg.license}`,
      ...(pkg.repository ? [`Repository: ${pkg.repository}`] : []),
      RULE,
    ];
    const body =
      pkg.files.length > 0
        ? pkg.files.map(
            (file) => (pkg.files.length > 1 ? `--- ${file.name} ---\n\n` : '') + file.text,
          )
        : [
            `This package ships no license file. Its package.json declares ${pkg.license}` +
              (pkg.author ? `; author: ${pkg.author}.` : '.') +
              (pkg.license === 'MIT' ? ' The MIT License text is at the end of this file.' : ''),
          ];
    return [...head, '', ...body].join('\n');
  });

  return `${[
    'ORtoolbox: third-party notices',
    '',
    'ORtoolbox bundles or copies the packages below into the site. Each is listed',
    'with its license as shipped in its npm package. Generated from node_modules by',
    'vite-plugins/third-party-notices.ts; do not edit by hand.',
    '',
    'FFmpeg (ffmpeg.wasm cores)',
    '',
    'vendor/ffmpeg/ holds the unmodified ESM builds of FFmpeg compiled to',
    'WebAssembly by the ffmpeg.wasm project, licensed under GPL-2.0-or-later.',
    'Their complete source, with the build scripts that pin the FFmpeg and library',
    'versions they contain, is at:',
    '',
    ...coreLines,
    '',
    'The GNU General Public License, version 2:',
    'https://www.gnu.org/licenses/old-licenses/gpl-2.0.html',
    '',
    ...sections.flatMap((section) => [section, '']),
    RULE,
    'The MIT License (for packages above that ship no license file)',
    RULE,
    '',
    MIT_TEXT,
  ].join('\n')}\n`;
}

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** The committed copy, at the repository root. */
export const NOTICES_FILE = 'THIRD-PARTY-NOTICES.txt';

// `node vite-plugins/third-party-notices.ts` rewrites the committed copy.
if (import.meta.main) {
  const root = join(import.meta.dirname, '..');
  writeFileSync(join(root, NOTICES_FILE), thirdPartyNotices(root));
}
