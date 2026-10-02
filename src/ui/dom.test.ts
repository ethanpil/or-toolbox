import { describe, expect, it, vi } from 'vitest';
import { append, clear, h, on, type Props } from './dom';

describe('h', () => {
  it('creates an element of the requested type', () => {
    const el = h('button');
    expect(el).toBeInstanceOf(HTMLButtonElement);
    expect(el.childNodes).toHaveLength(0);
  });

  it('sets classes from a string or a list with falsy entries skipped', () => {
    expect(h('div', { class: 'a b' }).className).toBe('a b');
    expect(h('div', { class: ['a', false, 'b', null, undefined] }).className).toBe('a b');
  });

  it('assigns DOM properties', () => {
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

  it('skips null and undefined props', () => {
    const el = h('a', { href: undefined, 'aria-label': null, title: undefined });
    expect(el.hasAttribute('href')).toBe(false);
    expect(el.hasAttribute('aria-label')).toBe(false);
    expect(el.hasAttribute('title')).toBe(false);
  });

  it('applies style through the CSSOM and dataset by name', () => {
    const el = h('div', { style: { width: '10px' }, dataset: { toolId: 'ocr' } });
    expect(el.style.width).toBe('10px');
    expect(el.dataset.toolId).toBe('ocr');
  });

  it('wires event handlers given as functions', () => {
    const onclick = vi.fn();
    const el = h('button', { onclick });
    el.click();
    expect(onclick).toHaveBeenCalledTimes(1);
  });

  it('appends children, flattening arrays and skipping falsy values', () => {
    const el = h('p', null, 'a', 1, null, false, undefined, [h('b', null, 'c'), ['d']]);
    expect(el.textContent).toBe('a1cd');
    expect(el.childNodes).toHaveLength(4);
  });

  it('never interprets strings as markup', () => {
    const payload = '<img src=x onerror="alert(1)">';
    const el = h('div', { title: payload }, payload);
    expect(el.children).toHaveLength(0);
    expect(el.textContent).toBe(payload);
    expect(el.querySelector('img')).toBeNull();
  });

  it('refuses innerHTML, outerHTML and string event handlers', () => {
    // Deliberately bypass the types: these keys are not part of Props.
    const unsafe = (props: Record<string, unknown>) => () => h('div', props as Props);
    expect(unsafe({ innerHTML: '<b>x</b>' })).toThrow(/innerHTML/);
    expect(unsafe({ outerHTML: '<b>x</b>' })).toThrow(/outerHTML/);
    expect(unsafe({ onclick: 'alert(1)' })).toThrow(/onclick/);
  });
});

describe('append', () => {
  it('adds nodes and text to an existing parent', () => {
    const parent = h('div', null, 'a');
    append(parent, 'b', h('span', null, 'c'));
    expect(parent.textContent).toBe('abc');
  });
});

describe('clear', () => {
  it('removes all children', () => {
    const el = h('ul', null, h('li'), h('li'), 'text');
    clear(el);
    expect(el.childNodes).toHaveLength(0);
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
