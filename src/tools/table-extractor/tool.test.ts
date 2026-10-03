import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest, ChatResponse, RawModel } from '../../core/api/types';
import { ApiError, FreeOnlyError, RunCancelledError } from '../../core/errors';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import { createToolTestContext, type ToolTestContext } from '../../ui/tool/testing';
import { getTool } from '../registry';
import { setup } from './tool';

vi.mock('../../core/media/image', () => ({
  toDataUrl: (blob: File) => Promise.resolve(`data:image/png;base64,${blob.name}`),
}));
vi.mock('../../core/media/pdf', () => ({
  openPdf: () =>
    Promise.resolve({
      numPages: 2,
      renderPage: (n: number) => Promise.resolve(new Blob([`page${n}`], { type: 'image/jpeg' })),
      pageText: () => Promise.resolve(''),
      close: () => Promise.resolve(),
    }),
}));

const MODEL: RawModel = {
  id: 'test/vision',
  name: 'Test vision',
  created: 1,
  context_length: 100_000,
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  pricing: { prompt: '0.000001', completion: '0.000002' },
  supported_parameters: ['max_tokens', 'response_format', 'structured_outputs'],
};

const answer = (tables: unknown[]): ChatResponse => ({
  id: 'gen-1',
  model: 'test/vision',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: JSON.stringify({ tables }) },
    },
  ],
});

const pageOf = (body: ChatRequest): number =>
  Number(
    /^Page (\d+) of/.exec((body.messages[1]?.content as { text?: string }[])[0]?.text ?? '')?.[1],
  );

let t: ToolTestContext | null = null;
beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  t?.cleanup();
  t = null;
});

const $$ = (root: ParentNode, testId: string): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];

describe('Table extractor tool', { timeout: 30_000 }, () => {
  it('round-trips its state', async () => {
    t = createToolTestContext(getTool('table-extractor'), {
      catalog: [MODEL],
      modelOverride: 'test/vision',
    });
    const tool = await t.mount(setup);
    const state = {
      prompt: 'Only 2025',
      settings: { charts: false, textHint: false, maxSide: 1600, concurrency: 1 },
    };
    tool.applyState(state);
    expect(tool.getState()).toEqual(state);
    tool.applyState(tool.getState());
    expect(tool.getState()).toEqual(state);
  });

  it('finds two tables on a page, edits them and keeps the edits for export', async () => {
    const chat = vi.fn(() =>
      Promise.resolve(
        answer([
          {
            title: 'Revenue',
            kind: 'table',
            headers: ['Region', 'Q1'],
            rows: [
              ['North', '120'],
              ['South', '98'],
            ],
            notes: '',
          },
          {
            title: 'Sales by year',
            kind: 'chart',
            headers: ['Year', 'Sales'],
            rows: [['2025', '10']],
            notes: 'Read from a chart',
          },
        ]),
      ),
    );
    t = createToolTestContext(getTool('table-extractor'), {
      catalog: [MODEL],
      modelOverride: 'test/vision',
      api: { chat },
    });
    const tool = await t.mount(setup);
    tool.onFiles?.([new File(['png'], 'page.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(1));
    await t.runners[0]!.trigger();

    const body = (chat.mock.calls[0] as unknown as [ChatRequest])[0];
    expect(body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'tables' },
    });
    expect($$(t.zones.output, 'te-table')).toHaveLength(2);
    expect($$(t.zones.output, 'te-summary')[0]?.textContent).toBe(
      '2 tables · 3 rows · 1 of 1 page read',
    );
    expect($$(t.zones.output, 'te-table')[1]?.textContent).toContain('From a chart');

    const cell = $$(t.zones.output, 'te-cell')[1] as HTMLInputElement;
    expect(cell.value).toBe('120');
    cell.value = '125';
    cell.dispatchEvent(new Event('input'));
    $$(t.zones.output, 'te-add-row')[0]!.click();
    expect($$($$(t.zones.output, 'te-table')[0]!, 'te-row')).toHaveLength(3);
    expect($$(t.zones.output, 'te-table-meta')[0]?.textContent).toBe(
      'page.png · 3 rows × 2 columns',
    );
    // The edit survived the redraw.
    expect(($$(t.zones.output, 'te-cell')[1] as HTMLInputElement).value).toBe('125');

    $$(t.zones.output, 'te-delete')[1]!.click();
    expect($$(t.zones.output, 'te-table')).toHaveLength(1);

    const run = (await t.core.history.query({ tool: 'table-extractor' }))[0]!;
    expect(run).toMatchObject({
      status: 'ok',
      meta: { pages: 1, tables: 2, failed: 0, mode: 'schema' },
    });
    expect(run.output).toContain('## Revenue');
  });

  it('merges a table that continues on the next page', async () => {
    const chat = vi.fn((body: ChatRequest) =>
      Promise.resolve(
        pageOf(body) === 1
          ? answer([
              {
                title: 'Staff',
                kind: 'table',
                headers: ['Name', 'Team'],
                rows: [['Ana', 'A']],
                notes: '',
              },
            ])
          : answer([
              {
                title: 'Staff (continued)',
                kind: 'table',
                headers: ['Ben', 'B'],
                rows: [['Chloe', 'C']],
                notes: '',
              },
            ]),
      ),
    );
    t = createToolTestContext(getTool('table-extractor'), {
      catalog: [MODEL],
      modelOverride: 'test/vision',
      api: { chat },
    });
    const tool = await t.mount(setup);
    tool.onFiles?.([new File(['%PDF'], 'staff.pdf', { type: 'application/pdf' })]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(1));
    await t.runners[0]!.trigger();
    expect(chat).toHaveBeenCalledTimes(2);
    expect($$(t.zones.output, 'te-table')).toHaveLength(2);
    expect($$(t.zones.output, 'te-merge')).toHaveLength(1);

    $$(t.zones.output, 'te-merge')[0]!.click();
    const tables = $$(t.zones.output, 'te-table');
    expect(tables).toHaveLength(1);
    expect($$(tables[0]!, 'te-row')).toHaveLength(3);
    expect($$(t.zones.output, 'te-table-meta')[0]?.textContent).toBe(
      'staff.pdf · pages 1–2 · 3 rows × 2 columns',
    );
  });

  it('reports a page whose answer cannot be read, and retries it', async () => {
    let calls = 0;
    const chat = vi.fn(() => {
      calls++;
      return Promise.resolve(
        calls === 1
          ? {
              ...answer([]),
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: { role: 'assistant' as const, content: 'no' },
                },
              ],
            }
          : answer([{ title: 'T', kind: 'table', headers: ['a'], rows: [['1']], notes: '' }]),
      );
    });
    t = createToolTestContext(getTool('table-extractor'), {
      catalog: [MODEL],
      modelOverride: 'test/vision',
      api: { chat },
    });
    const tool = await t.mount(setup);
    tool.onFiles?.([new File(['png'], 'page.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(1));
    await t.runners[0]!.trigger();
    expect($$(t.zones.output, 'te-failed')[0]?.hidden).toBe(false);
    expect($$(t.zones.output, 'te-failed')[0]?.textContent).toContain(
      'The answer was not valid JSON',
    );
    const runs = await t.core.history.query({ tool: 'table-extractor' });
    expect(runs[0]?.status).toBe('error');

    $$(t.zones.output, 'te-retry-failed')[0]!.click();
    await vi.waitFor(() => expect($$(t!.zones.output, 'te-table')).toHaveLength(1));
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));
    expect($$(t.zones.output, 'te-failed')[0]?.hidden).toBe(true);
  });

  /** Two pages: page 1 has "Revenue", page 2 "Costs" (or fails while `failing` holds 2). */
  const twoPages = (failing = new Set<number>()) =>
    vi.fn((body: ChatRequest) => {
      const page = pageOf(body);
      if (failing.has(page)) return Promise.reject(new ApiError('Mocked error 400', 400));
      return Promise.resolve(
        answer([
          {
            title: page === 1 ? 'Revenue' : 'Costs',
            kind: 'table',
            headers: ['Region', 'Q1'],
            rows: [[page === 1 ? 'North' : 'Rent', '120']],
            notes: '',
          },
        ]),
      );
    });
  const mountPdf = async (chat: ReturnType<typeof twoPages>) => {
    t = createToolTestContext(getTool('table-extractor'), {
      catalog: [MODEL],
      modelOverride: 'test/vision',
      api: { chat },
    });
    const tool = await t.mount(setup);
    tool.onFiles?.([new File(['%PDF'], 'report.pdf', { type: 'application/pdf' })]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(1));
    return tool;
  };
  const titles = () =>
    $$(t!.zones.output, 'te-title').map((input) => (input as HTMLInputElement).value);

  it('a refused run or retry leaves the tables and the failed list as they were', async () => {
    const chat = twoPages(new Set([2]));
    await mountPdf(chat);
    await t!.runners[0]!.trigger();
    const snapshot = () => ({
      tables: titles(),
      summary: $$(t!.zones.output, 'te-summary')[0]?.textContent,
      failed: $$(t!.zones.output, 'te-failed')[0]?.textContent,
    });
    const before = snapshot();
    expect(before.tables).toEqual(['Revenue']);
    t!.ctx.beginRun = vi
      .fn()
      .mockRejectedValueOnce(new RunCancelledError())
      .mockRejectedValueOnce(new FreeOnlyError(['test/vision']));
    await t!.runners[0]!.trigger();
    expect(snapshot()).toEqual(before);
    $$(t!.zones.output, 'te-retry-failed')[0]!.click();
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));
    expect(t!.ctx.beginRun).toHaveBeenCalledTimes(2);
    expect(snapshot()).toEqual(before);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('Retry: disabled with the reason while Run cannot start, and never kept for the next Run', async () => {
    const failing = new Set([2]);
    const chat = twoPages(failing);
    await mountPdf(chat);
    await t!.runners[0]!.trigger();
    t!.runners[0]!.setDisabled('Not now.');
    const button = $$(t!.zones.output, 'te-retry-failed')[0]!;
    await vi.waitFor(() => expect(button.getAttribute('aria-disabled')).toBe('true'));
    expect(button.title).toBe('Not now.');
    button.click();
    expect(chat).toHaveBeenCalledTimes(2);
    t!.runners[0]!.setDisabled(null);
    failing.clear();
    await t!.runners[0]!.trigger();
    expect(chat).toHaveBeenCalledTimes(4);
    expect((await t!.core.history.query({ tool: 'table-extractor' }))[0]?.title).toBe('report.pdf');
  });

  it('the toast Retry after a refused retry retries the same pages', async () => {
    const failing = new Set([2]);
    const chat = twoPages(failing);
    await mountPdf(chat);
    await t!.runners[0]!.trigger();
    failing.clear();
    const begin = t!.ctx.beginRun.bind(t!.ctx);
    t!.ctx.beginRun = vi.fn().mockRejectedValueOnce(new ApiError('Mocked refusal', 500));
    $$(t!.zones.output, 'te-retry-failed')[0]!.click();
    const retryToast = await vi.waitFor(() => {
      const button = document.querySelector<HTMLElement>('[data-testid="toast-retry"]');
      expect(button).not.toBeNull();
      return button!;
    });
    t!.ctx.beginRun = begin;
    retryToast.click();
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));
    expect(pageOf(chat.mock.calls.at(-1)![0])).toBe(2);
    expect(titles()).toEqual(['Revenue', 'Costs']);
  });

  it('a retry whose pages all fail again is a failed run', async () => {
    const chat = twoPages(new Set([2]));
    await mountPdf(chat);
    await t!.runners[0]!.trigger();
    $$(t!.zones.output, 'te-retry-failed')[0]!.click();
    await vi.waitFor(async () =>
      expect(await t!.core.history.query({ tool: 'table-extractor' })).toHaveLength(2),
    );
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));
    const runs = await t!.core.history.query({ tool: 'table-extractor' });
    expect(runs[0]).toMatchObject({ title: 'Retry: report.pdf', status: 'error' });
  });

  it('Undo puts a deleted table back between its neighbours, and not after a new extraction', async () => {
    const chat = vi.fn(() =>
      Promise.resolve(
        answer(
          ['A', 'B', 'C'].map((title) => ({
            title,
            kind: 'table',
            headers: ['x'],
            rows: [['1']],
            notes: '',
          })),
        ),
      ),
    );
    t = createToolTestContext(getTool('table-extractor'), {
      catalog: [MODEL],
      modelOverride: 'test/vision',
      api: { chat },
    });
    const tool = await t.mount(setup);
    tool.onFiles?.([new File(['png'], 'page.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(1));
    await t.runners[0]!.trigger();
    expect(titles()).toEqual(['A', 'B', 'C']);

    $$(t.zones.output, 'te-delete')[1]!.click(); // B
    const undoB = document.querySelectorAll<HTMLElement>('[data-testid="toast-undo"]');
    $$(t.zones.output, 'te-delete')[0]!.click(); // A
    expect(titles()).toEqual(['C']);
    undoB[undoB.length - 1]!.click();
    // B comes back before C (its old neighbour), not at its old index.
    expect(titles()).toEqual(['B', 'C']);
    const undoA = [...document.querySelectorAll<HTMLElement>('[data-testid="toast-undo"]')].at(-1)!;
    undoA.click();
    expect(titles()).toEqual(['A', 'B', 'C']);

    $$(t.zones.output, 'te-delete')[2]!.click(); // C
    const undoC = [...document.querySelectorAll<HTMLElement>('[data-testid="toast-undo"]')].at(-1)!;
    await t.runners[0]!.trigger();
    expect(titles()).toEqual(['A', 'B', 'C']);
    undoC.click();
    // The new extraction replaced the tables: the old C is not added again.
    expect(titles()).toEqual(['A', 'B', 'C']);
    expect(document.body.textContent).toContain('earlier extraction');
  });

  it('keeps typed text through other pages finishing and redraws only the cards that changed', async () => {
    let release: () => void = () => undefined;
    const chat = vi.fn((body: ChatRequest) =>
      pageOf(body) === 1
        ? Promise.resolve(
            answer([{ title: 'First', kind: 'table', headers: ['x'], rows: [['1']], notes: '' }]),
          )
        : new Promise<ChatResponse>((resolve) => {
            release = () =>
              resolve(
                answer([
                  { title: 'Second', kind: 'table', headers: ['y'], rows: [['2']], notes: '' },
                ]),
              );
          }),
    );
    t = createToolTestContext(getTool('table-extractor'), {
      catalog: [MODEL],
      modelOverride: 'test/vision',
      api: { chat },
    });
    const tool = await t.mount(setup);
    tool.onFiles?.([new File(['%PDF'], 'report.pdf', { type: 'application/pdf' })]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(1));
    const running = t.runners[0]!.trigger();
    await vi.waitFor(() => expect(titles()).toEqual(['First']));
    const card = $$(t.zones.output, 'te-table')[0]!;
    const cell = $$(card, 'te-cell')[0] as HTMLInputElement;
    cell.focus();
    cell.value = 'typed, not committed';
    cell.dispatchEvent(new Event('input'));
    const title = $$(card, 'te-title')[0] as HTMLInputElement;
    title.value = 'Renamed while reading';
    title.dispatchEvent(new Event('input'));
    release();
    await running;
    expect(titles()).toEqual(['Renamed while reading', 'Second']);
    // The first card was not redrawn: same element, same input, still focused, text kept.
    expect($$(t.zones.output, 'te-table')[0]).toBe(card);
    expect(document.activeElement).toBe(cell);
    expect(cell.value).toBe('typed, not committed');
    const run = (await t.core.history.query({ tool: 'table-extractor' }))[0]!;
    expect(run.output).toContain('typed, not committed');
    expect(run.output).toContain('## Renamed while reading');
  });

  it('names controls after their table, keeps header labels current, and moves with arrow keys', async () => {
    const chat = vi.fn(() =>
      Promise.resolve(
        answer([
          {
            title: 'Revenue',
            kind: 'table',
            headers: ['Region', 'Q1'],
            rows: [
              ['North', '120'],
              ['South', '98'],
            ],
            notes: '',
          },
        ]),
      ),
    );
    t = createToolTestContext(getTool('table-extractor'), {
      catalog: [MODEL],
      modelOverride: 'test/vision',
      api: { chat },
    });
    const tool = await t.mount(setup);
    tool.onFiles?.([new File(['png'], 'page.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(1));
    await t.runners[0]!.trigger();
    const card = () => $$(t!.zones.output, 'te-table')[0]!;
    const name = (testId: string) =>
      $$(card(), testId)[0]!.textContent?.replace(/\s+/g, ' ').trim();
    expect(name('te-add-row')).toBe('Add row to Revenue');
    expect(name('te-copy')).toBe('Copy for a spreadsheet: Revenue');
    expect(name('te-delete')).toBe('Delete table Revenue');
    // Remove-column buttons are not part of a column header.
    expect(card().querySelector('th [data-testid="te-remove-column"]')).toBeNull();
    expect($$(card(), 'te-remove-column')[0]?.getAttribute('aria-label')).toBe(
      'Remove column Region of Revenue',
    );

    const header = $$(card(), 'te-header')[0] as HTMLInputElement;
    header.value = 'Area';
    header.dispatchEvent(new Event('input'));
    header.dispatchEvent(new Event('change'));
    expect($$(card(), 'te-cell')[0]?.getAttribute('aria-label')).toBe('Area, row 1, Revenue');
    expect($$(card(), 'te-remove-column')[0]?.getAttribute('aria-label')).toBe(
      'Remove column Area of Revenue',
    );
    const title = $$(card(), 'te-title')[0] as HTMLInputElement;
    title.value = 'Sales';
    title.dispatchEvent(new Event('input'));
    title.dispatchEvent(new Event('change'));
    expect(name('te-add-row')).toBe('Add row to Sales');
    expect($$(card(), 'te-cell')[3]?.getAttribute('aria-label')).toBe('Q1, row 2, Sales');

    // One Tab stop for the whole grid; the arrow keys move between cells.
    const cells = $$(card(), 'te-cell') as HTMLInputElement[];
    const stops = [...card().querySelectorAll<HTMLElement>('table input, table button')].filter(
      (element) => element.tabIndex === 0,
    );
    expect(stops).toHaveLength(1);
    cells[0]!.focus();
    const press = (key: string) =>
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    press('ArrowDown');
    expect(document.activeElement).toBe(cells[2]);
    // Left/right move only when the caret is at the edge of the text.
    cells[2]!.setSelectionRange(0, 0);
    press('ArrowRight');
    expect(document.activeElement).toBe(cells[2]);
    cells[2]!.setSelectionRange(cells[2]!.value.length, cells[2]!.value.length);
    press('ArrowRight');
    expect(document.activeElement).toBe(cells[3]);
    press('ArrowUp');
    expect(document.activeElement).toBe(cells[1]);
    expect(cells[1]!.tabIndex).toBe(0);
    expect(cells[0]!.tabIndex).toBe(-1);
  });

  it('keeps the complete rows of an answer cut off at the length limit and says so', async () => {
    const full = JSON.stringify({
      tables: [
        { title: 'Long', kind: 'table', headers: ['n'], rows: [['1'], ['2'], ['3']], notes: '' },
      ],
    });
    const chat = vi.fn(() =>
      Promise.resolve({
        id: 'gen-1',
        model: 'test/vision',
        choices: [
          {
            index: 0,
            finish_reason: 'length',
            message: {
              role: 'assistant' as const,
              content: full.slice(0, full.indexOf('["3') + 3),
            },
          },
        ],
      }),
    );
    t = createToolTestContext(getTool('table-extractor'), {
      catalog: [MODEL],
      modelOverride: 'test/vision',
      api: { chat },
    });
    const tool = await t.mount(setup);
    tool.onFiles?.([new File(['png'], 'page.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(1));
    await t.runners[0]!.trigger();
    const rows = $$($$(t.zones.output, 'te-table')[0]!, 'te-row');
    expect(rows).toHaveLength(2);
    expect($$(t.zones.output, 'te-truncated')[0]?.hidden).toBe(false);
    expect($$(t.zones.output, 'te-truncated')[0]?.textContent).toContain('page.png');
    expect($$(t.zones.output, 'te-table')[0]?.textContent).toContain('cut off');
    const run = (await t.core.history.query({ tool: 'table-extractor' }))[0]!;
    expect(run.status).toBe('ok');
    expect(run.output).toContain('cut off');
  });
});
