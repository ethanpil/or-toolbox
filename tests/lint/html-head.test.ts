import { join } from 'node:path';
import type { Plugin } from 'vite';
import { describe, expect, it } from 'vitest';
import { pageDescription } from '../../vite-plugins/descriptions.ts';
import { htmlHead } from '../../vite-plugins/html-head.ts';
import { discoverPages } from '../../vite-plugins/pages.ts';

const root = join(import.meta.dirname, '..', '..');
const pages = discoverPages(root);

interface Tag {
  tag: string;
  attrs?: Record<string, string | boolean>;
}
type HtmlHook = {
  handler: (html: string, ctx: { filename: string; bundle?: Record<string, unknown> }) => unknown;
};

/** The shared <head> tags the plugin adds to the page whose entry is `file`. */
function headTags(file: string): Tag[] {
  const [head] = htmlHead() as [Plugin, Plugin];
  (head.configResolved as (config: unknown) => void)({
    root,
    base: '/or-toolbox/',
    command: 'build',
  });
  const hook = head.transformIndexHtml as unknown as HtmlHook;
  const result = hook.handler('<title>Page</title>', { filename: join(root, file) }) as {
    tags: Tag[];
  };
  return result.tags;
}

describe('the shared <head>', () => {
  it('finds the pages', () => {
    expect(pages.length).toBeGreaterThan(20);
  });

  it.each(pages.map((page) => [page.route || '(home)', page.file] as const))(
    'gives %s a meta description',
    (_route, file) => {
      const meta = headTags(file).find(
        (tag) => tag.tag === 'meta' && tag.attrs?.['name'] === 'description',
      );
      const content = String(meta?.attrs?.['content'] ?? '');
      expect(content.length).toBeGreaterThanOrEqual(20);
      expect(content.length).toBeLessThanOrEqual(300);
    },
  );

  it('builds a tool description from its manifest', () => {
    expect(pageDescription(root, 'tools/chat/')).toContain('Chat with any model');
  });

  it('refuses a page without a description', () => {
    expect(() => pageDescription(root, 'new-page/')).toThrow(/descriptions\.ts/);
  });

  it('links a tool page to its own stylesheet and no other page', () => {
    const styles = (file: string): string[] =>
      headTags(file)
        .filter((tag) => tag.tag === 'link' && tag.attrs?.['rel'] === 'stylesheet')
        .map((tag) => String(tag.attrs?.['href']));
    expect(styles('tools/chat/index.html')).toEqual([
      '/src/styles/main.scss',
      '/src/styles/tools/chat.scss',
    ]);
    expect(styles('tools/ocr/index.html')).toEqual(['/src/styles/main.scss']);
    expect(styles('index.html')).toEqual(['/src/styles/main.scss']);
  });

  it('preloads the icon font by its hashed name', () => {
    const [, preload] = htmlHead() as [Plugin, Plugin];
    const hook = preload.transformIndexHtml as unknown as HtmlHook;
    const bundle = { 'assets/bootstrap-icons-subset-AbC123.woff2': {}, 'assets/shell-x.css': {} };
    const [link] = hook.handler('', { filename: 'x', bundle }) as (Tag & { injectTo: string })[];
    expect(link?.attrs).toMatchObject({
      rel: 'preload',
      as: 'font',
      type: 'font/woff2',
      crossorigin: '',
    });
    // The base is the Vite default here; the real one comes from the config.
    expect(String(link?.attrs?.['href'])).toMatch(/assets\/bootstrap-icons-subset-AbC123\.woff2$/);
    expect(hook.handler('', { filename: 'x', bundle: {} })).toEqual([]);
  });
});
