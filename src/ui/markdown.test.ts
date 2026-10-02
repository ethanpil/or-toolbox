import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

/** Renders into a detached container so the result can be queried. */
async function render(markdown: string): Promise<HTMLElement> {
  const container = document.createElement('div');
  container.append(await renderMarkdown(markdown));
  return container;
}

/** True if any element carries an inline event handler attribute. */
function hasEventHandlerAttribute(root: HTMLElement): boolean {
  return [...root.querySelectorAll('*')].some((el) =>
    el.getAttributeNames().some((name) => name.toLowerCase().startsWith('on')),
  );
}

describe('renderMarkdown', () => {
  it('returns a DocumentFragment', async () => {
    expect(await renderMarkdown('hello')).toBeInstanceOf(DocumentFragment);
  });

  it('renders common Markdown', async () => {
    const out = await render(
      [
        '# Title',
        '',
        'Some **bold** and `code`.',
        '',
        '- one',
        '- two',
        '',
        '```js',
        'x()',
        '```',
      ].join('\n'),
    );
    expect(out.querySelector('h1')?.textContent).toBe('Title');
    expect(out.querySelector('strong')?.textContent).toBe('bold');
    expect(out.querySelectorAll('li')).toHaveLength(2);
    expect(out.querySelector('pre code')?.textContent).toContain('x()');
  });

  it('renders GFM tables', async () => {
    const out = await render('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(out.querySelectorAll('th')).toHaveLength(2);
    expect(out.querySelectorAll('td')).toHaveLength(2);
  });

  it('opens links in a new tab without opener or referrer', async () => {
    const link = (await render('[site](https://example.com/)')).querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  describe('neutralises XSS payloads', () => {
    it('removes script elements', async () => {
      const out = await render('before <script>window.pwned = 1</script> after');
      expect(out.querySelector('script')).toBeNull();
      expect(out.textContent).not.toContain('pwned');
    });

    it('removes inline event handlers', async () => {
      const out = await render(
        [
          '<img src="x" onerror="alert(1)">',
          '<svg onload="alert(1)"><circle r="1"/></svg>',
          '<details open ontoggle="alert(1)">x</details>',
          '<a href="#" onclick="alert(1)">click</a>',
        ].join('\n\n'),
      );
      expect(hasEventHandlerAttribute(out)).toBe(false);
      // The harmless part of the payload survives.
      expect(out.querySelector('img')?.getAttribute('src')).toBe('x');
    });

    it('removes javascript: URLs from Markdown and HTML links', async () => {
      const out = await render(
        '[md](javascript:alert(1))\n\n<a href="javascript:alert(1)">html</a>\n\n<a href="JaVaScRiPt:alert(1)">mixed</a>',
      );
      for (const link of out.querySelectorAll('a')) {
        expect(link.getAttribute('href') ?? '').not.toMatch(/^\s*javascript:/i);
      }
    });

    it('removes frames, objects, forms and style', async () => {
      const out = await render(
        [
          '<iframe src="https://example.com/"></iframe>',
          '<object data="x"></object>',
          '<embed src="x">',
          '<form action="https://example.com/"><input name="key"><button>Send</button></form>',
          '<style>body { display: none }</style>',
          '<p style="position:fixed;inset:0">overlay</p>',
        ].join('\n\n'),
      );
      expect(out.querySelector('iframe, object, embed, form, input, button, style')).toBeNull();
      expect(out.querySelector('[style]')).toBeNull();
      expect(out.textContent).toContain('overlay');
    });

    it('survives a payload hidden in a code block as text', async () => {
      const out = await render('```html\n<script>alert(1)</script>\n```');
      expect(out.querySelector('script')).toBeNull();
      expect(out.querySelector('code')?.textContent).toContain('<script>alert(1)</script>');
    });
  });
});
