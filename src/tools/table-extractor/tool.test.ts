import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest, ChatResponse, RawModel } from '../../core/api/types';
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
    cell.dispatchEvent(new Event('change'));
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
});
