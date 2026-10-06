import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest, ChatResponse, RawModel } from '../../core/api/types';
import { ApiError, FreeOnlyError, KeyLockedError, RunCancelledError } from '../../core/errors';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import { createToolTestContext, type ToolTestContext } from '../../ui/tool/testing';
import { getTool } from '../registry';
import { presetById } from './presets';
import { setup } from './tool';

const imageSizes = vi.hoisted(() => [] as (number | undefined)[]);
vi.mock('../../core/media/image', () => ({
  toDataUrl: (blob: File, options?: { maxDimension?: number }) => {
    imageSizes.push(options?.maxDimension);
    return Promise.resolve(`data:image/png;base64,${blob.name}`);
  },
}));
// The unlock dialog: the user enters the passphrase at once, and the tool's Retry follows.
vi.mock('../../ui/feedback/unlock', () => ({ unlockDialog: () => Promise.resolve(true) }));
// Saving a file is not what these tests check; building it is.
vi.mock('../../core/files', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  downloadBlob: vi.fn(),
}));

const model = (id: string, parameters: string[]): RawModel => ({
  id,
  name: id,
  created: 1,
  context_length: 100_000,
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  pricing: { prompt: '0.000001', completion: '0.000002' },
  supported_parameters: parameters,
});
const STRUCTURED = model('test/structured', [
  'max_tokens',
  'response_format',
  'structured_outputs',
]);
const JSON_MODE = model('test/json', ['max_tokens', 'response_format']);

const png = (name: string): File => new File(['png'], name, { type: 'image/png' });

const response = (content: string): ChatResponse => ({
  id: 'gen-1',
  model: 'm',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
});

/** The file name the request is about (the first text part names it). */
const fileOf = (body: ChatRequest): string =>
  /“(.+?)”/.exec(
    (body.messages[1]?.content as { type: string; text?: string }[])[0]?.text ?? '',
  )?.[1] ?? '?';

let t: ToolTestContext | null = null;
beforeEach(async () => {
  imageSizes.length = 0;
  isolateChannels();
  await resetDb();
  localStorage.clear();
});
afterEach(async () => {
  await t?.cleanup();
  t = null;
});

const $$ = (root: ParentNode, testId: string): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];

/** Answers the "Replace your corrections?" question that Extract asks over a grid with unexported corrections. */
const answerDiscard = async (accept: boolean): Promise<void> => {
  const dialog = await vi.waitFor(() => {
    const element = document.querySelector<HTMLElement>('[data-testid="discard-dialog"]');
    expect(element).not.toBeNull();
    return element!;
  });
  dialog
    .querySelector<HTMLElement>(`[data-testid="${accept ? 'dialog-confirm' : 'dialog-cancel'}"]`)!
    .click();
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="discard-dialog"]')).toBeNull(),
  );
};

describe('Data extractor tool', { timeout: 30_000 }, () => {
  it('round-trips its state, schema included', async () => {
    t = createToolTestContext(getTool('data-extractor'), {
      catalog: [STRUCTURED],
      modelOverride: 'test/structured',
    });
    const tool = await t.mount(setup);
    expect(t.zones.input.querySelector('[data-testid="tool-prompt"]')).not.toBeNull();
    const initial = tool.getState();
    expect(initial.settings['schema']).toBe('preset:invoice');
    expect(initial.settings['fields']).toEqual(presetById('invoice')!.fields);

    const state = {
      prompt: 'Amounts in CHF',
      settings: {
        schema: 'custom',
        fields: [
          { name: 'name', type: 'text', description: 'Who', required: true },
          { name: 'kind', type: 'enum', description: '', required: false, options: ['a', 'b'] },
          {
            name: 'rows',
            type: 'table',
            description: '',
            required: false,
            columns: [{ name: 'qty', type: 'number', description: 'How many' }],
          },
        ],
        perPage: true,
        textHint: false,
        maxSide: 2048,
        concurrency: 1,
      },
    };
    tool.applyState(state);
    expect(tool.getState()).toEqual(state);
    tool.applyState(tool.getState());
    expect(tool.getState()).toEqual(state);
    expect($$(t.zones.input, 'de-field')).toHaveLength(3);
  });

  it('extracts a batch with strict structured outputs and fills the review grid', async () => {
    const chat = vi.fn((body: ChatRequest) => {
      const name = fileOf(body);
      const n = Number(/(\d+)/.exec(name)?.[1] ?? 0);
      return Promise.resolve(
        response(
          JSON.stringify({
            vendor_name: `Shop ${n}`,
            invoice_date: `2026-10-0${n}`,
            total: n * 10,
            line_items: [],
          }),
        ),
      );
    });
    t = createToolTestContext(getTool('data-extractor'), {
      catalog: [STRUCTURED],
      modelOverride: 'test/structured',
      api: { chat },
    });
    const tool = await t.mount(setup);
    tool.onFiles?.([png('receipt-1.png'), png('receipt-2.png'), png('receipt-3.png')]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(3));
    await t.runners[0]!.trigger();

    expect(chat).toHaveBeenCalledTimes(3);
    const body = chat.mock.calls[0]![0];
    expect(body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { strict: true },
    });
    expect($$(t.zones.output, 'de-row').map((row) => row.dataset['status'])).toEqual([
      'done',
      'done',
      'done',
    ]);
    const run = (await t.core.history.query({ tool: 'data-extractor' }))[0]!;
    expect(run.status).toBe('ok');
    const output = JSON.parse(run.output ?? '[]') as {
      file: string;
      data: Record<string, unknown>;
    }[];
    expect(output.map((entry) => [entry.file, entry.data['total']])).toEqual([
      ['receipt-1.png', 10],
      ['receipt-2.png', 20],
      ['receipt-3.png', 30],
    ]);
    expect(run.meta).toMatchObject({ documents: 3, failed: 0, mode: 'schema' });
    expect($$(t.zones.output, 'de-summary')[0]?.textContent).toBe('3 of 3 documents extracted');
  });

  it('falls back to JSON mode, repairs one bad answer, and reports a document it cannot read', async () => {
    const chat = vi.fn((body: ChatRequest) => {
      const name = fileOf(body);
      if (name === 'a.png') {
        // First answer is chatter; the repair request (4 messages) gets JSON.
        return Promise.resolve(
          response(
            body.messages.length === 4
              ? '{"vendor_name":"A","invoice_date":"2026-01-02","total":1}'
              : 'Sorry, no.',
          ),
        );
      }
      return Promise.resolve(response('still not json'));
    });
    t = createToolTestContext(getTool('data-extractor'), {
      catalog: [JSON_MODE],
      modelOverride: 'test/json',
      api: { chat },
    });
    const tool = await t.mount(setup);
    tool.onFiles?.([png('a.png'), png('b.png')]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(2));
    await t.runners[0]!.trigger();

    expect(chat).toHaveBeenCalledTimes(4);
    expect(chat.mock.calls[0]![0].response_format).toEqual({ type: 'json_object' });
    const rows = $$(t.zones.output, 'de-row');
    expect(rows.map((row) => row.dataset['status'])).toEqual(['done', 'failed']);
    expect(rows[1]?.textContent).toContain("The model's answer could not be read");
    const run = (await t.core.history.query({ tool: 'data-extractor' }))[0]!;
    expect(run.status).toBe('ok');
    expect(run.meta).toMatchObject({ documents: 2, failed: 1, mode: 'json' });
  });

  it('falls back to JSON mode for the batch when no provider serves the strict request', async () => {
    const chat = vi.fn((body: ChatRequest) => {
      if (body.response_format?.type === 'json_schema') {
        return Promise.reject(
          new ApiError('No endpoints found that can handle the requested parameters.', 404),
        );
      }
      return Promise.resolve(
        response('{"vendor_name":"A","invoice_date":"2026-01-02","total":1,"line_items":[]}'),
      );
    });
    t = createToolTestContext(getTool('data-extractor'), {
      catalog: [STRUCTURED],
      modelOverride: 'test/structured',
      api: { chat },
    });
    const tool = await t.mount(setup);
    tool.applyState({ prompt: '', settings: { concurrency: 1 } });
    tool.onFiles?.([png('a.png'), png('b.png')]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(2));
    await t.runners[0]!.trigger();
    // One strict attempt, then JSON mode for that document and the rest of the batch.
    expect(chat.mock.calls.map((call) => call[0].response_format?.type)).toEqual([
      'json_schema',
      'json_object',
      'json_object',
    ]);
    expect($$(t.zones.output, 'de-row').map((row) => row.dataset['status'])).toEqual([
      'done',
      'done',
    ]);
    const run = (await t.core.history.query({ tool: 'data-extractor' }))[0]!;
    expect(run.meta).toMatchObject({ mode: 'json' });
  });

  it('a refused run or retry leaves the grid and its corrections as they were', async () => {
    const chat = vi.fn((body: ChatRequest) =>
      fileOf(body) === 'b.png'
        ? Promise.reject(new ApiError('Mocked error 400', 400))
        : Promise.resolve(
            response('{"vendor_name":"A","invoice_date":"2026-01-02","total":1,"line_items":[]}'),
          ),
    );
    t = createToolTestContext(getTool('data-extractor'), {
      catalog: [STRUCTURED],
      modelOverride: 'test/structured',
      api: { chat },
    });
    const tool = await t.mount(setup);
    tool.onFiles?.([png('a.png'), png('b.png')]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(2));
    await t.runners[0]!.trigger();
    const vendor = t.zones.output.querySelector<HTMLInputElement>(
      '[aria-label="Vendor name, document 1"]',
    )!;
    vendor.value = 'Corrected';
    vendor.dispatchEvent(new Event('change'));
    const snapshot = () => ({
      rows: $$(t!.zones.output, 'de-row').map((row) => row.outerHTML),
      summary: $$(t!.zones.output, 'de-summary')[0]?.textContent,
    });
    const before = snapshot();
    expect(before.summary).toBe('1 of 2 documents extracted · 1 corrected · 1 failed');

    t.ctx.beginRun = vi
      .fn()
      .mockRejectedValueOnce(new RunCancelledError())
      .mockRejectedValueOnce(new FreeOnlyError(['test/structured']));
    // Extract asks about the corrections first; a refusal after that still leaves the grid as it was.
    const refused = t.runners[0]!.trigger();
    await answerDiscard(true);
    await refused;
    expect(snapshot()).toEqual(before);
    $$(t.zones.output, 'de-retry')[0]!.click();
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));
    expect(t.ctx.beginRun).toHaveBeenCalledTimes(2);
    expect(snapshot()).toEqual(before);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('Retry: disabled with the reason while Run cannot start, and never kept for the next Run', async () => {
    const failing = new Set(['b.png']);
    const chat = vi.fn((body: ChatRequest) =>
      failing.has(fileOf(body))
        ? Promise.reject(new ApiError('Mocked error 400', 400))
        : Promise.resolve(
            response('{"vendor_name":"A","invoice_date":"2026-01-02","total":1,"line_items":[]}'),
          ),
    );
    t = createToolTestContext(getTool('data-extractor'), {
      catalog: [STRUCTURED],
      modelOverride: 'test/structured',
      api: { chat },
    });
    const tool = await t.mount(setup);
    tool.onFiles?.([png('a.png'), png('b.png')]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(2));
    await t.runners[0]!.trigger();

    t.runners[0]!.setDisabled('Not now.');
    await vi.waitFor(() =>
      expect($$(t!.zones.output, 'de-retry')[0]?.getAttribute('aria-disabled')).toBe('true'),
    );
    expect($$(t.zones.output, 'de-retry')[0]?.title).toBe('Not now.');
    expect($$(t.zones.output, 'de-retry-failed')[0]?.getAttribute('aria-disabled')).toBe('true');
    $$(t.zones.output, 'de-retry')[0]!.click();
    $$(t.zones.output, 'de-retry-failed')[0]!.click();
    expect(chat).toHaveBeenCalledTimes(2);

    t.runners[0]!.setDisabled(null);
    failing.clear();
    await t.runners[0]!.trigger();
    // A full run of both documents, not the refused retry of b.png.
    expect(chat).toHaveBeenCalledTimes(4);
    expect((await t.core.history.query({ tool: 'data-extractor' }))[0]?.title).toBe(
      'a.png and 1 more file',
    );
  });

  it('the toast Retry after a refused retry retries the same documents', async () => {
    const failing = new Set(['b.png']);
    const chat = vi.fn((body: ChatRequest) =>
      failing.has(fileOf(body))
        ? Promise.reject(new ApiError('Mocked error 400', 400))
        : Promise.resolve(
            response('{"vendor_name":"A","invoice_date":"2026-01-02","total":1,"line_items":[]}'),
          ),
    );
    t = createToolTestContext(getTool('data-extractor'), {
      catalog: [STRUCTURED],
      modelOverride: 'test/structured',
      api: { chat },
    });
    const tool = await t.mount(setup);
    tool.onFiles?.([png('a.png'), png('b.png'), png('c.png')]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(3));
    await t.runners[0]!.trigger();
    failing.clear();

    const begin = t.ctx.beginRun.bind(t.ctx);
    t.ctx.beginRun = vi.fn().mockRejectedValueOnce(new ApiError('Mocked refusal', 500));
    $$(t.zones.output, 'de-retry')[0]!.click();
    const retryToast = await vi.waitFor(() => {
      const button = document.querySelector<HTMLElement>('[data-testid="toast-retry"]');
      expect(button).not.toBeNull();
      return button!;
    });
    t.ctx.beginRun = begin;
    retryToast.click();
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));
    expect(fileOf(chat.mock.calls.at(-1)![0])).toBe('b.png');
    expect((await t.core.history.query({ tool: 'data-extractor' }))[0]?.title).toBe('Retry: b.png');
  });

  it('a retry whose documents all fail again is a failed run', async () => {
    const chat = vi.fn((body: ChatRequest) =>
      fileOf(body) === 'b.png'
        ? Promise.reject(new ApiError('Mocked error 400', 400))
        : Promise.resolve(
            response('{"vendor_name":"A","invoice_date":"2026-01-02","total":1,"line_items":[]}'),
          ),
    );
    t = createToolTestContext(getTool('data-extractor'), {
      catalog: [STRUCTURED],
      modelOverride: 'test/structured',
      api: { chat },
    });
    const tool = await t.mount(setup);
    tool.onFiles?.([png('a.png'), png('b.png')]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(2));
    await t.runners[0]!.trigger();
    $$(t.zones.output, 'de-retry')[0]!.click();
    await vi.waitFor(async () =>
      expect(await t!.core.history.query({ tool: 'data-extractor' })).toHaveLength(2),
    );
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));
    const runs = await t.core.history.query({ tool: 'data-extractor' });
    expect(runs[0]).toMatchObject({ title: 'Retry: b.png', status: 'error' });
  });

  it('refuses to run with a broken schema and opens the field editor', async () => {
    const chat = vi.fn();
    t = createToolTestContext(getTool('data-extractor'), {
      catalog: [STRUCTURED],
      modelOverride: 'test/structured',
      api: { chat },
    });
    const tool = await t.mount(setup);
    tool.applyState({ prompt: '', settings: { fields: [] } });
    tool.onFiles?.([png('a.png')]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(1));
    await t.runners[0]!.trigger();
    expect(chat).not.toHaveBeenCalled();
    expect(t.status()).toBe('Fix the fields first.');
    expect($$(t.zones.input, 'de-edit-fields')[0]?.getAttribute('aria-expanded')).toBe('true');
  });

  it('lists saved schemas from the tool state', async () => {
    t = createToolTestContext(getTool('data-extractor'), { catalog: [STRUCTURED] });
    await t.ctx.state.set('schemas', [
      {
        id: 's1',
        name: 'Supplier invoices',
        fields: [{ name: 'supplier', type: 'text', description: '', required: true }],
      },
      { id: 'broken' },
    ]);
    await t.mount(setup);
    const select = $$(t.zones.input, 'de-schema-select')[0] as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toContain('Supplier invoices');
    select.value = 'saved:s1';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect($$(t!.zones.input, 'de-field')).toHaveLength(1));
    expect($$(t.zones.input, 'de-schema-summary')[0]?.textContent).toBe('1 field: Supplier');
  });
});

const GOOD = '{"vendor_name":"A","invoice_date":"2026-01-02","total":1,"line_items":[]}';

describe('Data extractor tool: run safety', { timeout: 30_000 }, () => {
  const unknown = (): ApiError =>
    Object.assign(new ApiError('Bad gateway', 502), { outcomeUnknown: true });

  /** Answers wait in `release`, in the order the requests came. */
  const held = (bodies: ChatRequest[], release: (() => void)[]) =>
    vi.fn(
      (body: ChatRequest) =>
        new Promise<ChatResponse>((resolve) => {
          bodies.push(body);
          release.push(() => resolve(response(GOOD)));
        }),
    );

  const mountWith = async (
    chat: (body: ChatRequest) => Promise<ChatResponse>,
    catalog: RawModel[] = [STRUCTURED],
  ) => {
    t = createToolTestContext(getTool('data-extractor'), {
      catalog,
      modelOverride: catalog[0]!.id,
      api: { chat: vi.fn(chat) },
    });
    return t.mount(setup);
  };

  const addFiles = async (tool: { onFiles?: (files: File[]) => void }, names: string[]) => {
    tool.onFiles?.(names.map(png));
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(names.length));
  };

  it('the Retry after a fatal error part-way (keys locked) extracts only the documents without a result', async () => {
    const seen: string[] = [];
    let broke = false;
    const tool = await mountWith((body) => {
      const name = fileOf(body);
      seen.push(name);
      if (name === 'b.png' && !broke) {
        broke = true;
        return Promise.reject(new KeyLockedError());
      }
      return Promise.resolve(response(GOOD));
    });
    tool.applyState({ prompt: '', settings: { concurrency: 1 } });
    await addFiles(tool, ['a.png', 'b.png', 'c.png']);
    await t!.runners[0]!.trigger();
    await vi.waitFor(() => expect(seen).toHaveLength(4));
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));
    expect(seen).toEqual(['a.png', 'b.png', 'b.png', 'c.png']);
    expect($$(t!.zones.output, 'de-row').map((row) => row.dataset['status'])).toEqual([
      'done',
      'done',
      'done',
    ]);
  });

  it('words a document that may have been billed with the caution and the link, and asks before its Retry', async () => {
    const seen: string[] = [];
    let failB = true;
    const tool = await mountWith((body) => {
      const name = fileOf(body);
      seen.push(name);
      return name === 'b.png' && failB
        ? Promise.reject(unknown())
        : Promise.resolve(response(GOOD));
    });
    await addFiles(tool, ['a.png', 'b.png']);
    await t!.runners[0]!.trigger();
    expect($$(t!.zones.output, 'de-error')[0]?.textContent).toContain(
      'may still have done the work',
    );
    expect($$(t!.zones.output, 'de-error-activity')[0]?.getAttribute('href')).toMatch(
      /openrouter\.ai\/activity/,
    );

    $$(t!.zones.output, 'de-retry')[0]!.click();
    const dialog = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-testid="retry-unknown-confirm"]');
      expect(element).not.toBeNull();
      return element!;
    });
    dialog.querySelector<HTMLElement>('[data-testid="dialog-cancel"]')!.click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="retry-unknown-confirm"]')).toBeNull(),
    );
    expect(seen).toHaveLength(2);

    failB = false;
    $$(t!.zones.output, 'de-retry')[0]!.click();
    const again = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-testid="retry-unknown-confirm"]');
      expect(element).not.toBeNull();
      return element!;
    });
    again.querySelector<HTMLElement>('[data-testid="dialog-confirm"]')!.click();
    await vi.waitFor(() => expect(seen).toHaveLength(3));
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));
  });

  it('reads every document with the instructions, hint and image size of the moment Extract was pressed', async () => {
    const bodies: ChatRequest[] = [];
    const release: (() => void)[] = [];
    const tool = await mountWith(held(bodies, release));
    tool.applyState({
      prompt: 'First instructions',
      settings: { concurrency: 1, textHint: true, maxSide: 1024 },
    });
    await addFiles(tool, ['a.png', 'b.png']);
    const running = t!.runners[0]!.trigger();
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    tool.applyState({
      prompt: 'Other instructions',
      settings: { textHint: false, maxSide: 2048 },
    });
    release.shift()!();
    await vi.waitFor(() => expect(bodies).toHaveLength(2));
    release.shift()!();
    await running;
    expect(JSON.stringify(bodies[1]!.messages[0])).toContain('First instructions');
    expect(JSON.stringify(bodies[1]!.messages[0])).not.toContain('Other instructions');
    expect(imageSizes).toEqual([1024, 1024]);
    const run = (await t!.core.history.query({ tool: 'data-extractor' }))[0]!;
    expect(run.prompt).toBe('First instructions');
    expect(run.settings).toMatchObject({ textHint: true, maxSide: 1024 });
  });

  it('announces progress as a counter, not as a status per document', async () => {
    const tool = await mountWith(() => Promise.resolve(response(GOOD)));
    const status = vi.spyOn(t!.ctx.ui, 'status');
    const progress = vi.spyOn(t!.ctx.ui, 'progress');
    await addFiles(tool, ['a.png', 'b.png', 'c.png']);
    await t!.runners[0]!.trigger();
    expect(progress.mock.calls.map((call) => call[0])).toContain('Extracted 3 of 3 documents');
    expect(
      status.mock.calls.map((call) => call[0]).filter((text) => /^Extracted/.test(text)),
    ).toEqual([]);
    expect(t!.status()).toBe('Done · 3 documents');
  });

  it('asks for no more output than the model can give', async () => {
    const small: RawModel = { ...STRUCTURED, top_provider: { max_completion_tokens: 2000 } };
    const chat = vi.fn<(body: ChatRequest) => Promise<ChatResponse>>(() =>
      Promise.resolve(response(GOOD)),
    );
    t = createToolTestContext(getTool('data-extractor'), {
      catalog: [small],
      modelOverride: 'test/structured',
      api: { chat },
    });
    const tool = await t.mount(setup);
    await addFiles(tool, ['a.png']);
    await t.runners[0]!.trigger();
    expect(chat.mock.calls[0]![0].max_tokens).toBe(2000);
  });

  it('estimates from the image size and the PDF text hint', async () => {
    const tool = await mountWith(() => Promise.resolve(response(GOOD)));
    await addFiles(tool, ['a.png']);
    tool.applyState({ prompt: '', settings: { maxSide: 1024 } });
    const small = (await tool.estimate?.('test/structured'))!;
    tool.applyState({ prompt: '', settings: { maxSide: 2048 } });
    const large = (await tool.estimate?.('test/structured'))!;
    expect(large).toBeGreaterThan(small);
    // A 1,024 px page is 989 tokens, a 2,048 px page 3,954 (× $1 per million).
    expect(large - small).toBeCloseTo((3954 - 989) / 1_000_000, 5);
  });

  it('a refusal marks the document failed with its words and is not repaired', async () => {
    let calls = 0;
    const tool = await mountWith((body) => {
      calls++;
      if (fileOf(body) === 'b.png') {
        return Promise.resolve({
          id: 'g',
          model: 'm',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: null, refusal: 'I cannot read this.' },
            },
          ],
        } as ChatResponse);
      }
      return Promise.resolve(response(GOOD));
    });
    await addFiles(tool, ['a.png', 'b.png']);
    await t!.runners[0]!.trigger();
    // One request per document: no repair request for the refusal.
    expect(calls).toBe(2);
    const rows = $$(t!.zones.output, 'de-row');
    expect(rows.map((row) => row.dataset['status'])).toEqual(['done', 'failed']);
    expect($$(t!.zones.output, 'de-error')[0]?.textContent).toContain('I cannot read this.');
  });

  it('asks before Extract replaces corrected values, and holds them until they are exported', async () => {
    const chat = vi.fn(() => Promise.resolve(response(GOOD)));
    const tool = await mountWith(chat);
    await addFiles(tool, ['a.png']);
    await t!.runners[0]!.trigger();
    expect(t!.core.results.holds()).toEqual([]);

    const vendor = t!.zones.output.querySelector<HTMLInputElement>(
      '[aria-label="Vendor name, document 1"]',
    )!;
    vendor.value = 'Corrected';
    vendor.dispatchEvent(new Event('change'));
    expect(t!.core.results.holds()).toEqual(['Corrected values not exported yet']);

    // Declined: nothing is sent, and the correction stays.
    const declined = t!.runners[0]!.trigger();
    await answerDiscard(false);
    await declined;
    expect(chat).toHaveBeenCalledTimes(1);
    expect(
      t!.zones.output.querySelector<HTMLInputElement>('[aria-label="Vendor name, document 1"]')
        ?.value,
    ).toBe('Corrected');
    expect(t!.core.results.holds()).toHaveLength(1);

    // Exporting releases the hold.
    $$(t!.zones.output, 'de-export')[0]!.click();
    document.querySelector<HTMLElement>('[data-testid="export-json"]')!.click();
    await vi.waitFor(() => expect(t!.core.results.holds()).toEqual([]));

    // A correction after the export holds again; accepting the question replaces the grid.
    vendor.value = 'Corrected again';
    vendor.dispatchEvent(new Event('change'));
    expect(t!.core.results.holds()).toHaveLength(1);
    const accepted = t!.runners[0]!.trigger();
    await answerDiscard(true);
    await accepted;
    expect(chat).toHaveBeenCalledTimes(2);
    expect(t!.core.results.holds()).toEqual([]);
  });

  it('lets Extract run at once over a grid with no corrections', async () => {
    const chat = vi.fn(() => Promise.resolve(response(GOOD)));
    const tool = await mountWith(chat);
    await addFiles(tool, ['a.png']);
    await t!.runners[0]!.trigger();
    await t!.runners[0]!.trigger();
    expect(chat).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-testid="discard-dialog"]')).toBeNull();
  });
});

describe('Data extractor tool: saved fields', { timeout: 30_000 }, () => {
  const fieldsOf = (name: string) => [{ name, type: 'text', description: '', required: true }];
  const select = () => $$(t!.zones.input, 'de-schema-select')[0] as HTMLSelectElement;
  const optionsOf = () => [...select().options].map((option) => option.textContent);

  it('keeps what another tab saved, and shows it', async () => {
    t = createToolTestContext(getTool('data-extractor'), { catalog: [STRUCTURED] });
    await t.ctx.state.set('schemas', [{ id: 's1', name: 'Mine', fields: fieldsOf('mine') }]);
    await t.mount(setup);
    expect(optionsOf()).toContain('Mine');

    // Another tab saves a set; this tab learns of it (and the list it shows is the stored one).
    await t.core
      .toolState('data-extractor')
      .update('schemas', (current) => [
        ...((current as unknown[] | undefined) ?? []),
        { id: 's2', name: 'Theirs', fields: fieldsOf('theirs') },
      ]);
    await vi.waitFor(() => expect(optionsOf()).toContain('Theirs'));

    const stored = await t.ctx.state.get<{ name: string }[]>('schemas');
    expect(stored?.map((item) => item.name)).toEqual(['Mine', 'Theirs']);
  });

  it('writes a save as a change to the stored list, never the list it read earlier', async () => {
    t = createToolTestContext(getTool('data-extractor'), { catalog: [STRUCTURED] });
    await t.mount(setup);
    // The stored list changed behind this tab's back (no event reached it).
    const raw = t.core.toolState('data-extractor');
    const bus = t.core.bus.emit.bind(t.core.bus);
    t.core.bus.emit = () => undefined;
    await raw.set('schemas', [{ id: 'x1', name: 'Other', fields: fieldsOf('other') }]);
    t.core.bus.emit = bus;

    $$(t.zones.input, 'de-edit-fields')[0]!.click();
    $$(t.zones.input, 'de-schema-save')[0]!.click();
    const input = await vi.waitFor(() => {
      const element = document.querySelector<HTMLInputElement>('[data-testid="prompt-input"]');
      expect(element).not.toBeNull();
      return element!;
    });
    input.value = 'Mine';
    document.querySelector<HTMLElement>('[data-testid="dialog-confirm"]')!.click();
    await vi.waitFor(async () => {
      const stored = await t!.ctx.state.get<{ name: string }[]>('schemas');
      expect(stored?.map((item) => item.name).sort()).toEqual(['Mine', 'Other']);
    });
  });

  it('leaves the fields in the form when the set in use is deleted in another tab', async () => {
    t = createToolTestContext(getTool('data-extractor'), { catalog: [STRUCTURED] });
    await t.ctx.state.set('schemas', [{ id: 's1', name: 'Mine', fields: fieldsOf('mine') }]);
    await t.mount(setup);
    select().value = 'saved:s1';
    select().dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect($$(t!.zones.input, 'de-field')).toHaveLength(1));
    await t.core.toolState('data-extractor').delete('schemas');
    await vi.waitFor(() => expect(optionsOf()).not.toContain('Mine'));
    expect(select().value).toBe('custom');
    expect($$(t.zones.input, 'de-field')).toHaveLength(1);
  });

  it('remembers the saved set in use for the next visit', async () => {
    t = createToolTestContext(getTool('data-extractor'), { catalog: [STRUCTURED] });
    await t.ctx.state.set('schemas', [{ id: 's1', name: 'Mine', fields: fieldsOf('mine') }]);
    await t.mount(setup);
    select().value = 'saved:s1';
    select().dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect($$(t!.zones.input, 'de-field')).toHaveLength(1));
    await t.cleanup();

    t = createToolTestContext(getTool('data-extractor'), { catalog: [STRUCTURED] });
    await t.ctx.state.set('schemas', [{ id: 's1', name: 'Mine', fields: fieldsOf('mine') }]);
    t.ctx.options.set({ schema: 'saved:s1' });
    await t.mount(setup);
    expect(select().value).toBe('saved:s1');
    expect($$(t.zones.input, 'de-schema-summary')[0]?.textContent).toBe('1 field: Mine');
  });

  it('shows Custom for a history run whose saved set is gone, instead of a blank picker', async () => {
    t = createToolTestContext(getTool('data-extractor'), { catalog: [STRUCTURED] });
    const tool = await t.mount(setup);
    tool.applyState({
      prompt: '',
      settings: { schema: 'saved:gone', fields: fieldsOf('total') },
    });
    expect(select().value).toBe('custom');
    expect(tool.getState().settings['schema']).toBe('custom');
  });
});
