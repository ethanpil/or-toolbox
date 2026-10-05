import { describe, expect, it, vi } from 'vitest';
import { h } from '../dom';
import { createMarkdownCache } from './markdown-cache';

describe('createMarkdownCache', () => {
  it('shows plain text until the Markdown is rendered, then the cached copy at once', async () => {
    const cache = createMarkdownCache();
    const target = h('div');
    cache.fill(target, 'a', '**bold** text');
    expect(target.textContent).toBe('**bold** text');
    await vi.waitFor(() => expect(target.querySelector('strong')?.textContent).toBe('bold'));

    // Drawn again (a redraw of the conversation): synchronous, no flash of plain text.
    const again = h('div');
    cache.fill(again, 'a', '**bold** text');
    expect(again.querySelector('strong')?.textContent).toBe('bold');
    expect(cache.cached('a', '**bold** text')).not.toBeNull();
    expect(cache.cached('a', 'other text')).toBeNull();
  });

  it('prerenders ahead of the redraw, so a finished text never flashes as plain text', async () => {
    const cache = createMarkdownCache();
    await cache.prerender('a', '# Title');
    const target = h('div');
    cache.fill(target, 'a', '# Title');
    expect(target.querySelector('h1')?.textContent).toBe('Title');
  });

  it('gives every caller its own copy, so one placed in the page does not empty the cache', async () => {
    const cache = createMarkdownCache();
    const first = await cache.render('a', 'one *two*');
    document.body.append(first);
    expect(cache.cached('a', 'one *two*')?.querySelector('em')?.textContent).toBe('two');
    first.querySelector('em')?.remove();
    expect(cache.cached('a', 'one *two*')?.querySelector('em')).not.toBeNull();
    document.body.replaceChildren();
  });

  it('runs decorate on each fresh render, once, so cached copies carry its work', async () => {
    const decorate = vi.fn((fragment: DocumentFragment) => {
      for (const pre of fragment.querySelectorAll('pre')) pre.setAttribute('data-decorated', '');
    });
    const cache = createMarkdownCache({ decorate });
    const code = '```\nx = 1\n```';
    const target = h('div');
    cache.fill(target, 'a', code);
    await vi.waitFor(() => expect(target.querySelector('pre[data-decorated]')).not.toBeNull());
    const again = h('div');
    cache.fill(again, 'a', code);
    expect(again.querySelector('pre[data-decorated]')).not.toBeNull();
    expect(decorate).toHaveBeenCalledOnce();
  });

  it('keeps the newest entries only', async () => {
    const cache = createMarkdownCache({ size: 2 });
    await cache.render('a', 'text a');
    await cache.render('b', 'text b');
    await cache.render('c', 'text c');
    expect(cache.cached('a', 'text a')).toBeNull();
    expect(cache.cached('b', 'text b')).not.toBeNull();
    expect(cache.cached('c', 'text c')).not.toBeNull();
  });

  it('does not let a slow render overwrite a newer text in the same place', async () => {
    const cache = createMarkdownCache();
    const target = h('div');
    cache.fill(target, 'a', 'first *draft*');
    cache.fill(target, 'a', 'second *draft*');
    await vi.waitFor(() => expect(target.querySelector('em')?.textContent).toBe('draft'));
    expect(target.textContent?.trim()).toBe('second draft');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(target.textContent?.trim()).toBe('second draft');
  });
});
