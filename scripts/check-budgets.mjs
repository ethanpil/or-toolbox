// Checks the JavaScript budgets of a build (CLAUDE.md, architecture rule 8): the shell, the JS every page loads
// before it runs, at most 150 KB gzipped, and each tool page at most 80 KB more. Only what a page loads eagerly
// counts (its module script, modulepreloads and classic scripts); lazy chunks (pdf.js, ffmpeg, the markdown
// renderer, chart.js) load on use and are not part of a page's budget.
//
// Usage: node scripts/check-budgets.mjs [dist]   (after `npm run build`; exits 1 when a budget is exceeded)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

const SHELL_BUDGET_KB = 150;
const TOOL_BUDGET_KB = 80;

const dist = process.argv[2] ?? 'dist';
const base = process.env.BASE_PATH ?? '/or-toolbox/';

if (!existsSync(join(dist, 'index.html'))) {
  console.error(`No build in ${dist}/: run \`npm run build\` first.`);
  process.exit(1);
}

/** Every page's index.html, keyed by its route (`''` for Home, `tools/chat/`, …); vendor/ holds no pages. */
function pages(dir = dist) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'vendor' && entry.name !== 'assets') found.push(...pages(path));
    } else if (entry.name === 'index.html') {
      const route = relative(dist, dir).split(sep).join('/');
      found.push({ route: route ? `${route}/` : '', file: path });
    }
  }
  return found;
}

/** The JS files a page loads before it runs, as paths inside dist. */
function eagerScripts(html) {
  const files = new Set();
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/g)) {
    const isScript = tag.startsWith('<script');
    if (!isScript && !/\brel="modulepreload"/.test(tag)) continue;
    const url = /\b(?:src|href)="([^"]+\.js)"/.exec(tag)?.[1];
    if (!url || /^[a-z]+:/i.test(url)) continue;
    files.add(url.startsWith(base) ? url.slice(base.length) : url.replace(/^\//, ''));
  }
  return files;
}

const sizes = new Map();
const gzipped = (file) => {
  if (!sizes.has(file))
    sizes.set(file, gzipSync(readFileSync(join(dist, file)), { level: 9 }).length);
  return sizes.get(file);
};
const kb = (bytes) => bytes / 1024;
const total = (files) => [...files].reduce((sum, file) => sum + gzipped(file), 0);

const loaded = pages().map((page) => ({
  ...page,
  files: eagerScripts(readFileSync(page.file, 'utf8')),
}));
const shell = new Set(
  [...loaded[0].files].filter((file) => loaded.every((page) => page.files.has(file))),
);

let failed = false;
const shellKb = kb(total(shell));
const shellOk = shellKb <= SHELL_BUDGET_KB;
failed ||= !shellOk;
console.log(
  `${shellOk ? 'ok  ' : 'OVER'} shell (every page)  ${shellKb.toFixed(1).padStart(6)} KB gzipped of ${SHELL_BUDGET_KB} KB`,
);

for (const page of loaded.sort((a, b) => a.route.localeCompare(b.route))) {
  const extra = kb(total([...page.files].filter((file) => !shell.has(file))));
  const isTool = page.route.startsWith('tools/');
  const ok = !isTool || extra <= TOOL_BUDGET_KB;
  failed ||= !ok;
  const budget = isTool ? ` of ${TOOL_BUDGET_KB} KB` : '';
  console.log(
    `${ok ? 'ok  ' : 'OVER'} /${page.route.padEnd(24)} +${extra.toFixed(1).padStart(5)} KB beyond the shell${budget}`,
  );
}

if (failed) {
  console.error(
    '\nA JavaScript budget is exceeded: make a heavy import lazy (`import()` on use) or split the page.',
  );
  process.exit(1);
}
