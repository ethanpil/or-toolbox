import { describe, expect, it, vi } from 'vitest';
import { h } from '../dom';
import { stableBoundary, streamMarkdown } from './stream-markdown';

describe('streamMarkdown', () => {
  it('leaves the target alone until text arrives, then draws complete blocks once', async () => {
    const target = h('div', null, h('p', { class: 'skeleton' }, '…'));
    const renders = vi.fn();
    const stream = streamMarkdown(target, { onRender: renders });
    expect(target.querySelector('.skeleton')).not.toBeNull();

    stream.append('# Title\n\nFirst paragraph.\n\n');
    await vi.waitFor(() => expect(target.querySelector('h1')?.textContent).toBe('Title'));
    expect(target.querySelector('.skeleton')).toBeNull();
    const heading = target.querySelector('h1');
    for (let i = 0; i < 20; i++) stream.append(`word${i} `);
    await vi.waitFor(() => expect(target.textContent).toContain('word19'));
    expect(target.querySelector('h1')).toBe(heading); // the stable block was not rendered again
    expect(target.querySelector('.or-caret')).not.toBeNull();
    expect(renders).toHaveBeenCalled();

    await stream.finish();
    expect(target.querySelector('.or-caret')).toBeNull();
    expect(target.textContent).toContain('word0 word1');
    expect(stream.text()).toContain('First paragraph.');
  });

  it('redraws from scratch on set, and keeps the `after` node last', async () => {
    const target = h('div');
    const note = h('p', { class: 'note' }, 'Error');
    const stream = streamMarkdown(target, { after: () => note });
    stream.append('Old **text**\n\n');
    await vi.waitFor(() => expect(target.querySelector('strong')).not.toBeNull());
    stream.set('New *text*');
    await stream.finish();
    expect(target.querySelector('strong')).toBeNull();
    expect(target.querySelector('em')?.textContent).toBe('text');
    expect(target.lastElementChild).toBe(note);
  });

  it('draws plain text as is', async () => {
    const target = h('div');
    const stream = streamMarkdown(target, { format: 'text', caret: false });
    stream.append('# not a heading');
    await stream.finish();
    expect(target.querySelector('h1')).toBeNull();
    expect(target.textContent).toBe('# not a heading');
  });

  it('never touches the target after dispose', async () => {
    const target = h('div');
    const stream = streamMarkdown(target);
    stream.append('Some text');
    stream.dispose();
    target.replaceChildren('replaced');
    stream.append(' more');
    await stream.finish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(target.textContent).toBe('replaced');
  });

  it('finds the end of the stable part outside code fences', () => {
    expect(stableBoundary('a\n\nb', 0)).toBe(3);
    expect(stableBoundary('```\na\n\nb', 0)).toBe(0);
  });
});
