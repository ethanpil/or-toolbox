import { describe, expect, it, vi } from 'vitest';
import { append, clear, h, isSafeUrl, on, replace, type Props } from './dom';

/** Calls h() with props the types forbid, to test the runtime guards. */
const unsafe = (tag: string, props: Record<string, unknown>) =>
  h(tag as 'div', props as Props<HTMLDivElement>);

describe('h: elements', () => {
  it('creates an element of the requested type', () => {
    const el = h('button');
    expect(el).toBeInstanceOf(HTMLButtonElement);
    expect(el.childNodes).toHaveLength(0);
  });

  it.each(['script', 'iframe', 'object', 'embed', 'SCRIPT'])('refuses to create <%s>', (tag) => {
    expect(() => h(tag as 'script')).toThrow(/not allowed/);
  });
});

describe('h: children', () => {
  it('flattens arrays and renders numbers, including 0', () => {
    const el = h('p', null, 'a', 0, 1, [h('b', null, 'c'), ['d']]);
    expect(el.textContent).toBe('a01cd');
    expect(el.childNodes).toHaveLength(5);
  });

  it('skips null, undefined, false and the empty string', () => {
    const el = h('p', null, null, undefined, false, '', 'x');
    expect(el.childNodes).toHaveLength(1);
    expect(el.textContent).toBe('x');
  });

  it('handles very large and very deep child lists without overflowing the stack', () => {
    const many = Array.from({ length: 200_000 }, (_, i) => i % 10);
    expect(h('div', null, many).childNodes).toHaveLength(200_000);

    let deep: unknown[] = ['leaf'];
    for (let level = 0; level < 20_000; level++) deep = [deep];
    expect(h('div', null, deep as never).textContent).toBe('leaf');
  });

  it('never interprets strings as markup', () => {
    const payload = '<img src=x onerror="alert(1)">';
    const el = h('div', { title: payload }, payload);
    expect(el.children).toHaveLength(0);
    expect(el.textContent).toBe(payload);
  });
});

describe('h: props', () => {
  it('sets classes from a string or a list with falsy entries skipped', () => {
    expect(h('div', { class: 'a b' }).className).toBe('a b');
    expect(h('div', { class: ['a', false, 'b', null, undefined] }).className).toBe('a b');
  });

  it('assigns writable DOM properties', () => {
    const input = h('input', { type: 'checkbox', checked: true, disabled: true, id: 'x' });
    expect(input.type).toBe('checkbox');
    expect(input.checked).toBe(true);
    expect(input.disabled).toBe(true);
    expect(input.id).toBe('x');
  });

  it('sets data-*, aria-* and role as attributes', () => {
    const el = h('div', {
      'data-testid': 'panel',
      'aria-expanded': false,
      'aria-label': 'Panel',
      role: 'region',
    });
    expect(el.getAttribute('data-testid')).toBe('panel');
    expect(el.getAttribute('aria-expanded')).toBe('false');
    expect(el.getAttribute('aria-label')).toBe('Panel');
    expect(el.getAttribute('role')).toBe('region');
  });

  it('sets getter-only properties as attributes', () => {
    // `list` and `form` are read-only properties on <input>; assigning them would be lost.
    const input = unsafe('input', { list: 'suggestions', form: 'f1' });
    expect(input.getAttribute('list')).toBe('suggestions');
    expect(input.getAttribute('form')).toBe('f1');
  });

  it('skips null and undefined props', () => {
    const el = h('a', { href: undefined, 'aria-label': null, title: undefined });
    expect(el.hasAttribute('href')).toBe(false);
    expect(el.hasAttribute('aria-label')).toBe(false);
    expect(el.hasAttribute('title')).toBe(false);
  });

  it('applies value after children, so a select can pick one of its options', () => {
    const select = h(
      'select',
      { value: 'b' },
      h('option', { value: 'a' }),
      h('option', { value: 'b' }),
    );
    expect(select.value).toBe('b');
  });

  it('applies type and min/max/step before value', () => {
    // Written with value first on purpose: h() reorders.
    const range = h('input', { value: '150', max: '200', min: '100', step: '50', type: 'range' });
    expect(range.type).toBe('range');
    expect(range.value).toBe('150');
  });

  it('applies style objects (including custom properties and kebab-case) through the CSSOM', () => {
    const el = h('div', { style: { width: '10px', '--gap': '4px' } });
    el.style.setProperty('margin-top', '2px');
    expect(el.style.width).toBe('10px');
    expect(el.style.getPropertyValue('--gap')).toBe('4px');

    const kebab = unsafe('div', { style: { 'margin-left': '3px' } });
    expect(kebab.style.marginLeft).toBe('3px');
  });

  it('applies style strings through cssText', () => {
    expect(h('div', { style: 'width: 5px; height: 6px' }).style.height).toBe('6px');
  });

  it('applies dataset by name', () => {
    expect(h('div', { dataset: { toolId: 'ocr' } }).dataset.toolId).toBe('ocr');
  });
});

describe('h: event handlers', () => {
  it('wires function-valued handlers, whatever the key case', () => {
    const lower = vi.fn();
    const camel = vi.fn();
    h('button', { onclick: lower }).click();
    unsafe('button', { onClick: camel }).click();
    expect(lower).toHaveBeenCalledTimes(1);
    expect(camel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['onclick', 'alert(1)'],
    ['ONCLICK', 'alert(1)'],
    ['onClick', 'alert(1)'],
    ['onerror', 1],
    ['onload', { handleEvent: () => undefined }],
  ])('refuses %s with a non-function value', (key, value) => {
    expect(() => unsafe('img', { [key]: value })).toThrow(/must be a function/);
  });

  it('refuses unknown event handler names', () => {
    expect(() => unsafe('div', { onnotanevent: () => undefined })).toThrow(/not an event handler/);
  });
});

describe('h: forbidden props', () => {
  it.each(['innerHTML', 'outerHTML', 'srcdoc', 'INNERHTML', 'srcDoc'])('refuses %s', (key) => {
    expect(() => unsafe('div', { [key]: '<b>x</b>' })).toThrow(/not allowed/);
  });
});

describe('h: URL props', () => {
  it.each([
    'https://example.com/',
    'http://example.com/',
    'mailto:me@example.com',
    'tel:+15550100',
    'blob:https://example.com/0f1e',
    '/or-toolbox/settings/',
    'settings/',
    '../up',
    '#section',
    '?q=1',
    '//example.com/x',
  ])('keeps %s', (href) => {
    expect(h('a', { href }).getAttribute('href')).toBe(href);
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    '\u0001javascript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
  ])('drops %s', (href) => {
    expect(h('a', { href }).hasAttribute('href')).toBe(false);
  });

  it('checks every URL-bearing prop', () => {
    expect(h('img', { src: 'javascript:x' }).hasAttribute('src')).toBe(false);
    expect(h('form', { action: 'javascript:x' }).hasAttribute('action')).toBe(false);
    expect(h('button', { formAction: 'javascript:x' }).hasAttribute('formaction')).toBe(false);
    expect(h('video', { poster: 'javascript:x' }).hasAttribute('poster')).toBe(false);
    expect(unsafe('a', { 'xlink:href': 'javascript:x' }).hasAttribute('xlink:href')).toBe(false);
  });

  it('allows data: URLs only as an image source', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(h('img', { src: png }).getAttribute('src')).toBe(png);
    expect(h('a', { href: png }).hasAttribute('href')).toBe(false);
    expect(h('video', { src: png }).hasAttribute('src')).toBe(false);
  });

  it('exposes the same check for other code', () => {
    expect(isSafeUrl('https://x.test/')).toBe(true);
    expect(isSafeUrl('javascript:x')).toBe(false);
    expect(isSafeUrl('data:image/png;base64,AA==', true)).toBe(true);
    expect(isSafeUrl(42)).toBe(false);
  });
});

describe('append', () => {
  it('adds nodes and text to an existing parent', () => {
    const parent = h('div', null, 'a');
    append(parent, 'b', h('span', null, 'c'), null, 0);
    expect(parent.textContent).toBe('abc0');
  });
});

describe('clear', () => {
  it('removes all children', () => {
    const el = h('ul', null, h('li'), h('li'), 'text');
    clear(el);
    expect(el.childNodes).toHaveLength(0);
  });
});

describe('replace', () => {
  it('replaces the children with the same child rules as h()', () => {
    const el = h('div', null, 'old', h('span', null, 'old'));
    replace(el, null, 'a', false, [h('b', null, 'b')], undefined, 0);
    expect(el.childNodes).toHaveLength(3);
    expect(el.textContent).toBe('ab0');
  });
});

describe('on', () => {
  it('adds a listener and returns a function that removes it', () => {
    const el = h('button');
    const listener = vi.fn();
    const off = on(el, 'click', listener);
    el.click();
    off();
    el.click();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('accepts non-element targets and custom event names', () => {
    const listener = vi.fn();
    const off = on(window, 'ortoolbox:test', listener);
    window.dispatchEvent(new Event('ortoolbox:test'));
    off();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
