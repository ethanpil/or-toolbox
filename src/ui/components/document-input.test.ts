import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { documentInput, type DocumentInput } from './document-input';

const opened: string[] = [];
const closed: string[] = [];

// pdf.js does not run in jsdom: a fake document per file, named after the file's text content.
vi.mock('../../core/media/pdf', () => ({
  openPdf: async (blob: Blob) => {
    const name = await blob.text();
    if (name === 'broken') throw new Error('This file is not a valid PDF.');
    opened.push(name);
    const pages = Number(/pages=(\d+)/.exec(name)?.[1] ?? 3);
    return {
      numPages: pages,
      renderPage: (n: number) => Promise.resolve(new Blob([`page ${n}`], { type: 'image/jpeg' })),
      pageText: (n: number) => Promise.resolve(`text of ${name} page ${n}`),
      close: () => {
        closed.push(name);
        return Promise.resolve();
      },
    };
  },
}));

vi.mock('../../core/media/image', () => ({
  toDataUrl: (blob: Blob, options: { maxDimension: number }) =>
    Promise.resolve(`data:image/png;base64,max${options.maxDimension}-${blob.size}`),
}));

const pdf = (name: string, pages: number): File =>
  new File([`${name}?pages=${pages}`], `${name}.pdf`, { type: 'application/pdf' });
const png = (name: string): File => new File(['png'], name, { type: 'image/png' });

const $$ = (root: ParentNode, testId: string): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];

let input: DocumentInput;
let changes = 0;
const revoked: string[] = [];
let createUrl = vi.fn<(blob: Blob) => string>(() => '');

beforeEach(() => {
  opened.length = 0;
  closed.length = 0;
  revoked.length = 0;
  changes = 0;
  let n = 0;
  createUrl = vi.fn<(blob: Blob) => string>(() => `blob:thumb-${++n}`);
  URL.createObjectURL = createUrl;
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
  input = documentInput({ maxSide: () => 1200, onChange: () => changes++ });
  document.body.append(input.element);
});

afterEach(() => {
  input.dispose();
  document.body.replaceChildren();
});

describe('documentInput', () => {
  it('lists images and PDFs with their page counts and selects every page', async () => {
    await input.add([
      png('a.png'),
      pdf('report', 20),
      new File(['x'], 'notes.txt', { type: 'text/plain' }),
    ]);
    expect($$(input.element, 'doc-name').map((el) => el.textContent)).toEqual([
      'a.png',
      'report.pdf',
    ]);
    expect($$(input.element, 'doc-count')[0]?.textContent).toBe('2 files · 21 pages');
    expect(input.totalPages()).toBe(21);
    const selection = input.selection();
    expect(selection).toHaveLength(21);
    expect(selection[0]).toMatchObject({
      fileName: 'a.png',
      pageNumber: 1,
      pageCount: 1,
      kind: 'image',
    });
    expect(selection[20]).toMatchObject({
      fileName: 'report.pdf',
      pageNumber: 20,
      pageCount: 20,
      kind: 'pdf',
    });
    expect(changes).toBe(1);
    // The skipped text file is named in a toast.
    expect(document.body.textContent).toContain('Skipped 1 file: only images and PDFs are read.');
  });

  it('chooses pages by range, refusing a bad one with a field error', async () => {
    await input.add([pdf('report', 10)]);
    const range = $$(input.element, 'doc-pages-input')[0] as HTMLInputElement;
    expect(range.value).toBe('1-10');

    range.value = '2-4, 9';
    range.dispatchEvent(new Event('change'));
    expect(input.selection().map((ref) => ref.pageNumber)).toEqual([2, 3, 4, 9]);
    expect($$(input.element, 'doc-count')[0]?.textContent).toBe('1 file · 4 of 10 pages selected');

    const field = $$(input.element, 'doc-pages-input')[0] as HTMLInputElement;
    field.value = '12';
    field.dispatchEvent(new Event('change'));
    expect(field.classList.contains('is-invalid')).toBe(true);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(input.element.textContent).toContain('Page 12 does not exist');
    // The last good selection stands.
    expect(input.selection().map((ref) => ref.pageNumber)).toEqual([2, 3, 4, 9]);
  });

  it('toggles pages from the tile grid with the keyboard-reachable buttons', async () => {
    await input.add([pdf('report', 5)]);
    $$(input.element, 'doc-pages-toggle')[0]!.click();
    const tiles = $$(input.element, 'doc-page');
    expect(tiles).toHaveLength(5);
    expect(tiles.every((tile) => tile.getAttribute('aria-pressed') === 'true')).toBe(true);
    expect(tiles[2]?.getAttribute('aria-label')).toBe('Page 3');

    tiles[2]!.focus();
    tiles[2]!.click();
    expect(input.selection().map((ref) => ref.pageNumber)).toEqual([1, 2, 4, 5]);
    const redrawn = $$(input.element, 'doc-page');
    expect(redrawn[2]?.getAttribute('aria-pressed')).toBe('false');
    // Focus survives the redraw.
    expect(document.activeElement).toBe(redrawn[2]);
    expect(($$(input.element, 'doc-pages-input')[0] as HTMLInputElement).value).toBe('1-2, 4-5');

    $$(input.element, 'doc-pages-none')[0]!.click();
    expect(input.selection()).toEqual([]);
    $$(input.element, 'doc-pages-all')[0]!.click();
    expect(input.selection()).toHaveLength(5);
  });

  it('loads a page sized for upload, with the PDF text layer', async () => {
    await input.add([pdf('report', 3), png('photo.png')]);
    const [first] = input.selection();
    const page = await input.loadPage(first!);
    expect(page).toMatchObject({
      fileName: 'report.pdf',
      pageNumber: 1,
      text: 'text of report?pages=3 page 1',
    });
    expect(page.imageDataUrl).toMatch(/^data:image\/jpeg;base64,/);
    const photo = await input.loadPage(input.selection()[3]!);
    expect(photo.imageDataUrl).toBe('data:image/png;base64,max1200-3');
    expect(photo.text).toBeUndefined();
  });

  it('keeps at most two PDFs open and closes the rest', async () => {
    await input.add([pdf('one', 2), pdf('two', 2), pdf('three', 2)]);
    // Each card's thumbnail (page 1) is rendered, reopening an evicted PDF when needed.
    await vi.waitFor(() => expect(createUrl).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(opened.length - closed.length).toBe(2));
    // Reading a page of each one reopens what was closed, and still only two stay open.
    for (const ref of input.selection()) await input.loadPage(ref);
    await vi.waitFor(() => expect(opened.length - closed.length).toBe(2));
    expect(opened.length).toBeGreaterThan(3);
  });

  it('removes a file: thumbnails revoked, PDF closed, focus moved on', async () => {
    await input.add([png('a.png'), png('b.png')]);
    expect(createUrl).toHaveBeenCalledTimes(2);
    const remove = $$(input.element, 'doc-remove');
    remove[0]!.focus();
    remove[0]!.click();
    expect($$(input.element, 'doc-name').map((el) => el.textContent)).toEqual(['b.png']);
    expect(revoked).toEqual(['blob:thumb-1']);
    expect(document.activeElement).toBe($$(input.element, 'doc-remove')[0]);

    await input.add([pdf('report', 2)]);
    input.clear();
    expect(input.files()).toEqual([]);
    await vi.waitFor(() => expect(closed).toContain('report?pages=2'));
    expect($$(input.element, 'doc-name')).toEqual([]);
  });

  it('reports a PDF it cannot open and keeps the others', async () => {
    await input.add([new File(['broken'], 'bad.pdf', { type: 'application/pdf' }), png('ok.png')]);
    expect($$(input.element, 'doc-name').map((el) => el.textContent)).toEqual(['ok.png']);
    expect(document.body.textContent).toContain('bad.pdf');
  });

  it('refuses to load a page of a removed file', async () => {
    await input.add([png('a.png')]);
    const [ref] = input.selection();
    input.clear();
    await expect(input.loadPage(ref!)).rejects.toThrow(/removed/);
  });
});
