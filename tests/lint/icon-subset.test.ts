import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { declaredIcons, iconCodepoints, usedIcons } from '../../vite-plugins/icon-usage.ts';

const root = join(import.meta.dirname, '..', '..');
const known = iconCodepoints(root);
/** Parsing every source file takes seconds on a busy machine. */
const SCAN_TIMEOUT_MS = 60_000;

/** The icon names in the committed subset stylesheet. */
function subsetNames(): Set<string> {
  const scss = readFileSync(join(root, 'src', 'styles', '_icons.scss'), 'utf8');
  return new Set([...scss.matchAll(/^\.bi-([a-z0-9-]+)::before/gm)].map((m) => m[1] as string));
}

describe('icon usage scan', () => {
  it('reads names from string literals, class lists, template text and manifests', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ortoolbox-icons-'));
    mkdirSync(join(dir, 'src', 'tools', 'x'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'a.ts'),
      [
        "icon('gear');",
        "const c = 'bi bi-star-fill text-warning';",
        "const t = cond ? 'play-fill' : `pause-fill`;",
        "// icon('trash') in a comment is not a use",
        "const s = 'Add a heart to the sentence';",
      ].join('\n'),
    );
    writeFileSync(join(dir, 'src', 'a.test.ts'), "icon('house');");
    writeFileSync(join(dir, 'src', 'tools', 'x', 'manifest.json'), '{"id":"x","icon":"film"}');
    const table = new Map([
      ['gear', 1],
      ['star-fill', 2],
      ['play-fill', 3],
      ['pause-fill', 4],
      ['trash', 5],
      ['heart', 6],
      ['house', 7],
      ['film', 8],
    ]);
    expect(usedIcons(dir, table)).toEqual(['film', 'gear', 'pause-fill', 'play-fill', 'star-fill']);
  });
});

describe('the icon subset', () => {
  it(
    'has a rule for every icon the code uses (run `npm run icon-subset` after adding one)',
    () => {
      const subset = subsetNames();
      const missing = usedIcons(root, known).filter((name) => !subset.has(name));
      expect(missing).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    'knows every icon the code asks for by name (a wrong name draws an empty box)',
    () => {
      const unknown = declaredIcons(root).filter(({ name }) => !known.has(name));
      expect(unknown).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );

  it('keeps the code points of the full font', () => {
    const scss = readFileSync(join(root, 'src', 'styles', '_icons.scss'), 'utf8');
    for (const [, name, hex] of scss.matchAll(
      /^\.bi-([a-z0-9-]+)::before \{\s+content: '\\([0-9a-f]+)';/gm,
    )) {
      expect(known.get(name as string), name).toBe(Number.parseInt(hex as string, 16));
    }
  });

  it('ships a font that is far smaller than the full one', () => {
    const font = join(root, 'src', 'styles', 'fonts', 'bootstrap-icons-subset.woff2');
    const full = join(
      root,
      'node_modules',
      'bootstrap-icons',
      'font',
      'fonts',
      'bootstrap-icons.woff2',
    );
    expect(statSync(font).size).toBeLessThan(statSync(full).size / 4);
  });
});
