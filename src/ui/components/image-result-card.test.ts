import { afterEach, beforeAll, describe, expect, it, type MockInstance, vi } from 'vitest';
import { getCore } from '../../core/index';
import { resultHandle } from '../tool/results';
import type { ResultHandle, SendItem } from '../tool/types';
import { imageResultCard, type ImageResultCardOptions } from './image-result-card';

const hoisted = vi.hoisted(() => {
  /** What the fake browser writes when asked for a type (Safari writes PNG when asked for WebP). */
  const writes = new Map<string, string>();
  return {
    close: vi.fn(),
    writes,
    toBlob: vi.fn((_source: unknown, options: { type?: string; quality?: number }) =>
      Promise.resolve(
        new Blob([`as ${options.type} q${options.quality ?? '-'}`], {
          type: writes.get(options.type ?? '') ?? options.type,
        }),
      ),
    ),
  };
});
vi.mock('../../core/media/image', () => ({
  loadImage: () => Promise.resolve({ close: hoisted.close }),
  toBlob: hoisted.toBlob,
}));

const $ = <T extends HTMLElement = HTMLElement>(root: ParentNode, id: string): T | null =>
  root.querySelector<T>(`[data-testid="${id}"]`);
const labels = (root: ParentNode): (string | null)[] =>
  [...root.querySelectorAll('.dropdown-item')].map((item) => item.textContent);

const core = getCore();
const handles = new Map<ResultHandle, MockInstance>();
const removeSpy = (handle: ResultHandle): MockInstance => handles.get(handle)!;
const sent: SendItem[][] = [];
const ui: ImageResultCardOptions['ui'] = {
  addResult: (input) => {
    const handle = resultHandle(core, core.results.add({ tool: 'image-generation', ...input }));
    handles.set(handle, vi.spyOn(handle, 'remove'));
    return handle;
  },
  sendTo: (items) => void sent.push(items),
};
const saved: { name: string; blob: Blob }[] = [];

beforeAll(() => {
  let lastBlob: Blob | null = null;
  URL.createObjectURL = (blob) => {
    lastBlob = blob as Blob;
    return 'blob:test';
  };
  URL.revokeObjectURL = () => undefined;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push({ name: this.download, blob: lastBlob! });
  });
});
afterEach(() => {
  for (const handle of handles.keys()) handle.remove();
  handles.clear();
  sent.length = 0;
  saved.length = 0;
  hoisted.toBlob.mockClear();
  hoisted.close.mockClear();
  hoisted.writes.clear();
  document.body.replaceChildren();
});

const png = (): Blob => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });

function card(options: Partial<ImageResultCardOptions> = {}) {
  const onRemove = vi.fn();
  const made = imageResultCard({
    ui,
    blob: png(),
    name: 'lighthouse-1.png',
    meta: ['1024 × 1024', null, 'seed 42', false],
    formats: ['png', 'jpg', 'webp'],
    onRemove,
    testId: 'gen',
    ...options,
  });
  return { ...made, onRemove };
}

describe('imageResultCard', () => {
  it('registers the result with the leave guard and shows the image', () => {
    const { element, handle, viewer } = card();
    expect(handle.result).toMatchObject({ kind: 'image', name: 'lighthouse-1.png' });
    expect(core.results.pending()).toContain(handle.result);
    expect(element.querySelector('h3')?.textContent).toBe('lighthouse-1.png');
    expect($(element, 'gen-result-meta')?.textContent).toBe('1024 × 1024 · seed 42');
    expect(viewer?.image.alt).toBe('lighthouse-1.png');
    expect($(element, 'gen-viewer')).not.toBeNull();
  });

  it('takes a title, an alt text, a heading level, extra content, and can leave the viewer out', () => {
    const note = document.createElement('p');
    const { element, viewer } = card({
      title: 'Image 2',
      alt: 'A lighthouse at dusk',
      headingLevel: 4,
      extra: note,
    });
    expect(element.querySelector('h4')?.textContent).toBe('Image 2');
    expect(viewer?.image.alt).toBe('A lighthouse at dusk');
    expect(element.contains(note)).toBe(true);
    const bare = card({ viewer: false });
    expect(bare.viewer).toBeNull();
    expect($(bare.element, 'gen-viewer')).toBeNull();
  });

  it('saves the image as it is in its own format, converts it to the others, and marks it downloaded', async () => {
    const { element, handle } = card();
    document.body.append(element);
    expect([...element.querySelectorAll('.dropdown-item')].map((item) => item.textContent)).toEqual(
      ['PNG.png', 'JPG.jpg', 'WEBP.webp'],
    );
    $<HTMLButtonElement>(element, 'export-png')!.click();
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({ name: 'lighthouse-1.png', blob: handle.result.blob });
    expect(hoisted.toBlob).not.toHaveBeenCalled();
    expect(handle.result.downloaded).toBe(true);

    $<HTMLButtonElement>(element, 'export-jpg')!.click();
    await vi.waitFor(() => expect(saved).toHaveLength(2));
    expect(saved[1]?.name).toBe('lighthouse-1.jpg');
    expect(await saved[1]?.blob.text()).toBe('as image/jpeg q0.92');
    expect(hoisted.close).toHaveBeenCalledOnce();
  });

  it('offers an SVG as it is only, never converted', () => {
    const svg = card({
      blob: new Blob(['<svg/>'], { type: 'image/svg+xml' }),
      name: 'logo.svg',
      formats: ['png', 'jpg', 'webp'],
    });
    expect(svg.element.querySelectorAll('.dropdown-item')).toHaveLength(0);
    expect($(svg.element, 'gen-download')?.textContent).toBe('Download .svg');
    const unnamed = card({
      blob: new Blob(['<svg/>'], { type: 'image/svg+xml' }),
      name: 'logo',
      formats: ['png'],
    });
    expect($(unnamed.element, 'gen-download')?.textContent).toBe('Download .svg');
  });

  it('always offers the image itself next to the conversions; JPEG counts as jpg', () => {
    const gif = card({
      blob: new Blob(['x'], { type: 'image/gif' }),
      name: 'a.gif',
      formats: ['png'],
    });
    expect(labels(gif.element)).toEqual(['GIF.gif', 'PNG.png']);
    const jpeg = card({
      blob: new Blob(['x'], { type: 'image/jpeg' }),
      name: 'photo',
      formats: ['jpg'],
    });
    expect($(jpeg.element, 'gen-download')?.textContent).toBe('Download .jpg');
  });

  it('sends the image to another tool and runs its actions', () => {
    const vary = vi.fn();
    const { element, handle } = card({
      actions: [{ label: 'Variations', icon: 'shuffle', onClick: vary, testId: 'gen-vary' }],
    });
    $<HTMLButtonElement>(element, 'gen-send')!.click();
    expect(sent).toEqual([[{ kind: 'file', blob: handle.result.blob, name: 'lighthouse-1.png' }]]);
    $<HTMLButtonElement>(element, 'gen-vary')!.click();
    expect(vary).toHaveBeenCalledOnce();
  });

  it('Remove drops the result and hands focus to the next card, the previous one, then the fallback', async () => {
    const fallback = document.createElement('button');
    const list = document.createElement('div');
    document.body.append(fallback, list);
    const [a, b, c] = ['a.png', 'b.png', 'c.png'].map((name) =>
      card({ name, focusFallback: () => fallback }),
    );
    list.append(a!.element, b!.element, c!.element);
    const remove = (item: typeof a) => $<HTMLButtonElement>(item!.element, 'gen-remove')!;

    remove(a).focus();
    remove(a).click();
    await vi.waitFor(() => expect(a!.onRemove).toHaveBeenCalledOnce());
    expect(a!.element.isConnected).toBe(false);
    expect(removeSpy(a!.handle)).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(remove(b));

    remove(c).click();
    await vi.waitFor(() => expect(c!.onRemove).toHaveBeenCalledOnce());
    expect(document.activeElement).toBe(remove(b));

    remove(b).click();
    await vi.waitFor(() => expect(b!.onRemove).toHaveBeenCalledOnce());
    expect(document.activeElement).toBe(fallback);
  });

  it('asks focusFallback only after onRemove updated the page, so an empty state it shows takes focus', async () => {
    const empty = document.createElement('p');
    empty.tabIndex = -1;
    empty.hidden = true;
    const item = card({
      onRemove: () => {
        empty.hidden = false;
      },
      focusFallback: () => (empty.hidden ? null : empty),
    });
    document.body.append(item.element, empty);
    $<HTMLButtonElement>(item.element, 'gen-remove')!.focus();
    $<HTMLButtonElement>(item.element, 'gen-remove')!.click();
    await vi.waitFor(() => expect(item.element.isConnected).toBe(false));
    expect(document.activeElement).toBe(empty);
  });

  it('leaves focus where onRemove put it', async () => {
    const elsewhere = document.createElement('button');
    const fallback = document.createElement('button');
    const item = card({ onRemove: () => elsewhere.focus(), focusFallback: () => fallback });
    document.body.append(item.element, elsewhere, fallback);
    $<HTMLButtonElement>(item.element, 'gen-remove')!.click();
    await vi.waitFor(() => expect(item.element.isConnected).toBe(false));
    expect(document.activeElement).toBe(elsewhere);
  });

  it('keeps the card when beforeRemove says no; remove() from code drops it once without onRemove', async () => {
    const beforeRemove = vi.fn(() => Promise.resolve(false));
    const item = card({ beforeRemove });
    document.body.append(item.element);
    $<HTMLButtonElement>(item.element, 'gen-remove')!.click();
    await vi.waitFor(() => expect(beforeRemove).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(item.element.isConnected).toBe(true);
    expect(removeSpy(item.handle)).not.toHaveBeenCalled();

    item.remove();
    item.remove();
    expect(item.element.isConnected).toBe(false);
    expect(removeSpy(item.handle)).toHaveBeenCalledOnce();
    expect(item.onRemove).not.toHaveBeenCalled();
  });

  // Keep this test last: once a format turns out not to encode, the page stops offering it on every card.
  it('drops a format the browser cannot encode instead of saving a PNG named .webp', async () => {
    hoisted.writes.set('image/webp', 'image/png');
    const first = card();
    const second = card({ name: 'second.png' });
    document.body.append(first.element, second.element);
    $<HTMLButtonElement>(first.element, 'export-webp')!.click();
    await vi.waitFor(() => expect(labels(first.element)).toEqual(['PNG.png', 'JPG.jpg']));
    expect(saved).toHaveLength(0);
    expect(first.handle.result.downloaded).toBe(false);
    expect(document.body.textContent).toContain('This browser cannot save WEBP images');
    expect(labels(second.element)).toEqual(['PNG.png', 'JPG.jpg']);
    expect(labels(card({ name: 'later.png' }).element)).toEqual(['PNG.png', 'JPG.jpg']);
    // A WebP original is still saved as it is.
    const webp = card({ blob: new Blob(['x'], { type: 'image/webp' }), name: 'photo.webp' });
    expect(labels(webp.element)).toEqual(['PNG.png', 'JPG.jpg', 'WEBP.webp']);
  });
});
