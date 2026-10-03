// @vitest-environment node
/**
 * Proves the architecture rules in eslint.config.js catch what they claim to:
 * each snippet is linted with the real configuration, as if it were a page
 * module (src/pages/, outside src/core), and must trigger the expected rule.
 * The snippets are never written to disk.
 */
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
/** Linted under this name, so the page-code rules apply. The file itself is not read. */
const AS_FILE = join(ROOT, 'src', 'pages', 'home.ts');

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: ROOT });
});

async function rulesHit(code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: AS_FILE });
  return (result?.messages ?? []).map((message) => message.ruleId ?? message.message);
}

const declarations =
  'declare const el: HTMLElement; declare const range: Range; declare const html: string;\n';

describe('HTML string sinks are rejected', () => {
  it.each([
    ['innerHTML assignment', 'el.innerHTML = html;'],
    ['outerHTML compound assignment', 'el.outerHTML += html;'],
    ['computed innerHTML assignment', "el['innerHTML'] = html;"],
    ['Object.assign with innerHTML', 'Object.assign(el, { innerHTML: html });'],
    ['Object.assign with a quoted innerHTML key', "Object.assign(el, { 'innerHTML': html });"],
    ['insertAdjacentHTML', "el.insertAdjacentHTML('beforeend', html);"],
    ['setHTMLUnsafe', 'el.setHTMLUnsafe(html);'],
    ['parseHTMLUnsafe', 'Document.parseHTMLUnsafe(html);'],
    ['createContextualFragment', 'range.createContextualFragment(html);'],
    ['document.write', 'document.write(html);'],
    ['document.writeln', 'document.writeln(html);'],
  ])(
    '%s',
    async (_name, code) => {
      expect(await rulesHit(declarations + code)).toContain('no-restricted-syntax');
    },
    60_000,
  );

  it('allows reading innerHTML and building DOM with textContent', async () => {
    const hits = await rulesHit(`${declarations}const copy = el.innerHTML; el.textContent = copy;`);
    expect(hits).not.toContain('no-restricted-syntax');
  }, 60_000);
});

describe('browser storage is rejected outside src/core', () => {
  it.each([
    ['localStorage global', "localStorage.getItem('k');", 'no-restricted-globals'],
    ['sessionStorage global', "sessionStorage.setItem('k', 'v');", 'no-restricted-globals'],
    ['indexedDB global', "indexedDB.open('db');", 'no-restricted-globals'],
    ['window.localStorage', "window.localStorage.getItem('k');", 'no-restricted-properties'],
    ['globalThis.sessionStorage', 'globalThis.sessionStorage.clear();', 'no-restricted-properties'],
    ['self.indexedDB', "self.indexedDB.open('db');", 'no-restricted-properties'],
    ['top.localStorage', 'top?.localStorage.clear();', 'no-restricted-properties'],
    ['parent.localStorage', 'parent.localStorage.clear();', 'no-restricted-properties'],
  ])(
    '%s',
    async (_name, code, rule) => {
      expect(await rulesHit(code)).toContain(rule);
    },
    60_000,
  );
});
