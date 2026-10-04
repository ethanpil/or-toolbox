import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { InvalidInputError } from '../../core/errors';
import {
  imageThumbnail,
  referencePicker,
  type ReferencePickerOptions,
  referenceProblem,
} from './reference-picker';

const hoisted = vi.hoisted(() => ({
  /** Decoded size of every picture. */
  size: { width: 4000, height: 3000 },
  loadImage: vi.fn((): Promise<object> =>
    Promise.resolve({ ...hoisted.size, close: () => undefined }),
  ),
  fitWithin: (width: number, height: number, max: number) => {
    const scale = Math.min(1, max / width, max / height);
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
  },
  resizeCanvas: vi.fn((_source: unknown, width: number, height: number) => ({ width, height })),
  toBlob: vi.fn((canvas: { width: number; height: number }, options: { type?: string }) =>
    Promise.resolve(
      new Blob([`thumb ${canvas.width}x${canvas.height}`], { type: options.type ?? '' }),
    ),
  ),
  toDataUrl: vi.fn((blob: Blob, options: { maxDimension?: number; maxBytes?: number }) =>
    Promise.resolve(`data:${blob.type};${options.maxDimension}/${options.maxBytes}`),
  ),
}));
vi.mock('../../core/media/image', () => ({
  fitWithin: hoisted.fitWithin,
  loadImage: hoisted.loadImage,
  resizeCanvas: hoisted.resizeCanvas,
  toBlob: hoisted.toBlob,
  toDataUrl: hoisted.toDataUrl,
}));

const $ = <T extends HTMLElement = HTMLElement>(root: ParentNode, id: string): T | null =>
  root.querySelector<T>(`[data-testid="${id}"]`);
const $$ = (root: ParentNode, id: string): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
];

const objectUrls = new Map<string, Blob>();
const revoked: string[] = [];
beforeAll(() => {
  URL.createObjectURL = (blob) => {
    const url = `blob:test-${objectUrls.size + 1}`;
    objectUrls.set(url, blob as Blob);
    return url;
  };
  URL.revokeObjectURL = (url) => void revoked.push(url);
});
afterEach(() => {
  document.body.replaceChildren();
  objectUrls.clear();
  revoked.length = 0;
  hoisted.size = { width: 4000, height: 3000 };
  vi.clearAllMocks();
});

const png = (name: string): File => new File([name], name, { type: 'image/png' });

function picker(options: Partial<ReferencePickerOptions> = {}) {
  const status = vi.fn();
  const made = referencePicker({ ui: { status }, max: 4, testId: 'gen', ...options });
  document.body.append(made.element);
  return { ...made, status };
}

/** Delivers files through the drop zone's file dialog. */
function choose(root: ParentNode, files: File[]): void {
  const input = root.querySelector('input[type=file]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change'));
}

const removeButtons = (root: ParentNode): HTMLButtonElement[] =>
  $$(root, 'gen-reference-remove') as HTMLButtonElement[];
const zoneButton = (root: ParentNode): HTMLButtonElement | null =>
  $<HTMLButtonElement>(root, 'drop-zone-button');

describe('referencePicker', () => {
  it('adds files, Blobs and Send to items up to max, and says what did not fit', () => {
    const p = picker({ max: 3, owner: 'FLUX.2' });
    const blob = new Blob(['b'], { type: 'image/jpeg' });
    const taken = p.add([png('a.png'), blob, { blob: png('c'), name: 'c.png' }, png('d.png')]);
    expect(taken.map((reference) => reference.name)).toEqual(['a.png', 'reference.jpg', 'c.png']);
    expect(p.references()).toEqual(taken);
    expect(p.references()[1]?.blob).toBe(blob);
    expect($$(p.element, 'gen-reference')).toHaveLength(3);
    expect($(p.element, 'gen-reference-count')?.textContent).toBe('3 of 3');
    expect($(p.element, 'gen-reference-note')?.textContent).toBe(
      'That is as many as FLUX.2 takes.',
    );
    expect($(p.element, 'gen-reference-drop')).toBeNull();
    expect(p.status).toHaveBeenCalledWith('Added 3 reference images; 1 did not fit.');

    p.add([png('e.png')]);
    expect(p.status).toHaveBeenLastCalledWith('FLUX.2 takes at most 3 reference images.');
    expect(p.references()).toHaveLength(3);
  });

  it('skips files of other types', () => {
    const p = picker();
    const taken = p.add([new File(['%PDF'], 'doc.pdf', { type: 'application/pdf' }), png('a.png')]);
    expect(taken).toHaveLength(1);
    expect(p.status).toHaveBeenCalledWith(
      'Added a.png as a reference image. Skipped 1 file: reference images can be PNG, JPEG or WebP.',
    );
  });

  it('shows small thumbnails, never the full-size original', async () => {
    const p = picker();
    const [a] = p.add([png('a.png')]);
    const thumb = $(p.element, 'gen-reference')!.querySelector('img')!;
    await vi.waitFor(() => expect(thumb.hidden).toBe(false));
    expect(hoisted.resizeCanvas).toHaveBeenCalledWith(expect.anything(), 144, 108);
    const shown = objectUrls.get(thumb.getAttribute('src')!);
    expect(shown).not.toBe(a!.blob);
    expect(await shown!.text()).toBe('thumb 144x108');
    expect($(p.element, 'gen-reference')!.firstElementChild?.getAttribute('aria-label')).toBe(
      'Reference 1: a.png',
    );

    p.remove(a!.id);
    expect(revoked).toContain(thumb.getAttribute('src'));
  });

  it('marks a picture it cannot read, and keeps it for the user to remove', async () => {
    hoisted.loadImage.mockRejectedValueOnce(new Error('not an image'));
    const p = picker();
    p.add([png('broken.png')]);
    const tile = $(p.element, 'gen-reference')!.firstElementChild as HTMLElement;
    await vi.waitFor(() =>
      expect(tile.getAttribute('aria-label')).toBe('Reference 1: broken.png (cannot be read)'),
    );
    expect(p.references()).toHaveLength(1);
  });

  it('keeps focus on the drop zone button while files are added, then the newest Remove takes it', () => {
    const p = picker({ max: 2 });
    zoneButton(p.element)!.focus();
    choose(p.element, [png('a.png')]);
    expect(zoneButton(p.element)?.textContent).toContain('Choose a file');
    expect(document.activeElement).toBe(zoneButton(p.element));
    choose(p.element, [png('b.png')]);
    expect(zoneButton(p.element)).toBeNull();
    expect(document.activeElement).toBe(removeButtons(p.element)[1]);
  });

  it('leaves focus alone when a tool adds references (paste, Send to, Use as reference)', () => {
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    const p = picker({ max: 1 });
    p.add([png('a.png')]);
    expect(document.activeElement).toBe(elsewhere);
  });

  it('Remove hands focus to the next reference, the previous one, then the drop zone button', () => {
    const p = picker();
    p.add([png('a.png'), png('b.png'), png('c.png')]);
    const [a, b, c] = removeButtons(p.element);
    b!.focus();
    b!.click();
    expect(document.activeElement).toBe(c);
    expect(c!.getAttribute('aria-label')).toBe('Remove reference 2, c.png');
    c!.click();
    expect(document.activeElement).toBe(a);
    a!.click();
    expect(p.references()).toHaveLength(0);
    expect(document.activeElement).toBe(zoneButton(p.element));
  });

  it('remove() from code moves focus only when it was on that reference', () => {
    const p = picker();
    const [a, b] = p.add([png('a.png'), png('b.png')]);
    removeButtons(p.element)[0]!.focus();
    p.remove(b!.id);
    expect(document.activeElement).toBe(removeButtons(p.element)[0]);
    p.remove(a!.id);
    expect(document.activeElement).toBe(zoneButton(p.element));
  });

  it('removing what a model that takes none still holds hides the picker and focuses the fallback', () => {
    const fallback = document.createElement('button');
    document.body.append(fallback);
    const p = picker({ focusFallback: () => fallback });
    p.add([png('a.png')]);
    p.setLimits({ max: 0, owner: 'Seedream' });
    expect(p.element.hidden).toBe(false);
    expect(p.problem()).toBe(
      'Seedream does not take reference images; remove them or choose another model.',
    );
    expect($(p.element, 'gen-reference-note')?.textContent).toBe(p.problem());
    removeButtons(p.element)[0]!.click();
    expect(p.element.hidden).toBe(true);
    expect(document.activeElement).toBe(fallback);
  });

  it('follows the model limits: hidden at 0, a note for min and max, problem() and focus() for Run', () => {
    const p = picker({ max: 0 });
    expect(p.element.hidden).toBe(true);
    p.setLimits({ min: 1, max: 2, owner: 'Kontext' });
    expect(p.element.hidden).toBe(false);
    expect(p.problem()).toBe('Kontext needs at least 1 reference image.');
    expect(p.focus()).toBe(true);
    expect(document.activeElement).toBe(zoneButton(p.element));
    p.add([png('a.png')]);
    expect(p.problem()).toBeNull();
    expect($(p.element, 'gen-reference-note')?.textContent).toBe(
      'Kontext needs 1 to 2 reference images.',
    );
    p.setLimits({ max: 4 });
    expect($(p.element, 'gen-reference-note')?.textContent).toBe(
      'Optional. This model takes up to 4 reference images.',
    );
    expect($(p.element, 'gen-reference-drop')?.textContent).toContain(
      'Drop reference images (optional)',
    );
    p.add([png('b.png'), png('c.png')]);
    p.setLimits({ max: 1 });
    expect(p.problem()).toBe('This model takes at most 1 reference image; remove 2.');
    expect(p.focus()).toBe(true);
    expect(document.activeElement).toBe(removeButtons(p.element)[0]);
  });

  it('encodes each reference once per size, in order, and re-encodes only when the size changes', async () => {
    const p = picker();
    const [a, b] = p.add([png('a.png'), new File(['j'], 'b.jpg', { type: 'image/jpeg' })]);
    const small = { maxSide: 1024, maxBytes: 1_000_000 };
    expect(await p.dataUrls(small)).toEqual([
      'data:image/png;1024/1000000',
      'data:image/jpeg;1024/1000000',
    ]);
    await p.dataUrls(small);
    expect(hoisted.toDataUrl).toHaveBeenCalledTimes(2);
    expect(hoisted.toDataUrl).toHaveBeenCalledWith(a!.blob, {
      maxDimension: 1024,
      maxBytes: 1_000_000,
    });
    expect(await p.dataUrls()).toEqual([
      `data:image/png;2048/${4 * 1024 * 1024}`,
      `data:image/jpeg;2048/${4 * 1024 * 1024}`,
    ]);
    expect(hoisted.toDataUrl).toHaveBeenCalledTimes(4);
    p.remove(a!.id);
    expect(await p.dataUrls()).toEqual([`data:image/jpeg;2048/${4 * 1024 * 1024}`]);
    expect(hoisted.toDataUrl).toHaveBeenCalledTimes(4);
    expect(p.references()[0]).toBe(b);
  });

  it('names a reference that cannot be encoded, and tries it again next time', async () => {
    const p = picker();
    p.add([png('a.png'), png('bad.png')]);
    hoisted.toDataUrl
      .mockResolvedValueOnce('data:a')
      .mockRejectedValueOnce(new InvalidInputError('Not an image the browser can read.'));
    await expect(p.dataUrls()).rejects.toMatchObject({
      code: 'invalid-input',
      message:
        'Reference 2 (bad.png) could not be read (Not an image the browser can read). Remove it or choose another.',
    });
    expect(await p.dataUrls()).toHaveLength(2);
    expect(hoisted.toDataUrl).toHaveBeenCalledTimes(3);
  });

  it('tells listeners about every change; clear() frees the thumbnails', async () => {
    const p = picker();
    const listener = vi.fn();
    const off = p.onChange(listener);
    const [a] = p.add([png('a.png'), png('b.png')]);
    expect(listener).toHaveBeenLastCalledWith(p.references());
    await vi.waitFor(() => expect(objectUrls.size).toBe(2));
    p.remove(a!.id);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(revoked).toHaveLength(1);
    p.clear();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenLastCalledWith([]);
    expect(revoked.sort()).toEqual([...objectUrls.keys()].sort());
    p.clear();
    off();
    p.add([png('c.png')]);
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

describe('imageThumbnail', () => {
  it('scales a large picture down and passes a small one through', async () => {
    const big = png('big.png');
    expect(await (await imageThumbnail(big, 100)).text()).toBe('thumb 100x75');
    hoisted.size = { width: 80, height: 60 };
    expect(await imageThumbnail(big, 100)).toBe(big);
  });
});

describe('referenceProblem', () => {
  it('names what is missing or too much', () => {
    expect(referenceProblem(0, { max: 0 })).toBeNull();
    expect(referenceProblem(2, { max: 0, owner: 'X' })).toBe(
      'X does not take reference images; remove them or choose another model.',
    );
    expect(referenceProblem(0, { min: 2, max: 4 })).toBe(
      'This model needs at least 2 reference images.',
    );
    expect(referenceProblem(5, { max: 4 })).toBe(
      'This model takes at most 4 reference images; remove 1.',
    );
    expect(referenceProblem(3, { min: 1, max: 4 })).toBeNull();
  });
});
