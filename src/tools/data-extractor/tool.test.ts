import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest, ChatResponse, RawModel } from '../../core/api/types';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import { createToolTestContext, type ToolTestContext } from '../../ui/tool/testing';
import { getTool } from '../registry';
import { presetById } from './presets';
import { setup } from './tool';

vi.mock('../../core/media/image', () => ({
  toDataUrl: (blob: File) => Promise.resolve(`data:image/png;base64,${blob.name}`),
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
  isolateChannels();
  await resetDb();
  localStorage.clear();
});
afterEach(() => {
  t?.cleanup();
  t = null;
});

const $$ = (root: ParentNode, testId: string): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];

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
