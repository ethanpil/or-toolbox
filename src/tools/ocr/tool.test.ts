import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatRequest,
  ChatStreamEvent,
  ChatStreamResult,
  RawModel,
} from '../../core/api/types';
import { ApiError } from '../../core/errors';
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
      renderPage: () => Promise.resolve(new Blob(['x'], { type: 'image/jpeg' })),
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

const png = (name: string): File => new File(['png'], name, { type: 'image/png' });

const streamResult = (text: string): ChatStreamResult => ({
  id: 'gen-1',
  model: 'test/vision',
  text,
  reasoning: '',
  images: [],
  audioChunks: [],
  audioTranscript: '',
  finishReason: 'stop',
  usage: null,
});

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

const $ = (root: ParentNode, testId: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const $$ = (root: ParentNode, testId: string): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];

/** Answers each page with "Text of <file name>", failing the files named in `failing` once. */
function fakeStream(failing: Set<string> = new Set()) {
  const calls: ChatRequest[] = [];
  const chatStream = vi.fn(
    (
      body: ChatRequest,
      opts: { onEvent: (event: ChatStreamEvent) => void },
    ): Promise<ChatStreamResult> => {
      calls.push(body);
      const image = (
        body.messages[1]?.content as { type: string; image_url?: { url: string } }[]
      ).find((part) => part.type === 'image_url');
      const name = image?.image_url?.url.split(',')[1] ?? '?';
      if (failing.delete(name)) return Promise.reject(new ApiError('Mocked error 400', 400));
      const text = `Text of ${name}`;
      opts.onEvent({ type: 'text', text });
      return Promise.resolve(streamResult(text));
    },
  );
  return { chatStream, calls };
}

describe('OCR tool', { timeout: 30_000 }, () => {
  it('round-trips its state, maps old modes, and keeps the tool-prompt convention', async () => {
    t = createToolTestContext(getTool('ocr'), { catalog: [MODEL], modelOverride: 'test/vision' });
    const tool = await t.mount(setup);
    expect($(t.zones.input, 'tool-prompt')).not.toBeNull();
    const state = {
      prompt: 'Skip the page headers',
      settings: {
        mode: 'math',
        language: 'German',
        separators: false,
        textHint: false,
        pdfParser: true,
        engine: 'mistral-ocr',
        maxSide: 2048,
        concurrency: 2,
      },
    };
    tool.applyState(state);
    expect(tool.getState()).toEqual(state);
    tool.applyState(tool.getState());
    expect(tool.getState()).toEqual(state);

    tool.applyState({ prompt: '', settings: { mode: 'standard', temperature: 3 } });
    expect(tool.getState().settings['mode']).toBe('printed');
  });

  it('estimates from the selected pages and is unknown without any', async () => {
    t = createToolTestContext(getTool('ocr'), { catalog: [MODEL], modelOverride: 'test/vision' });
    const tool = await t.mount(setup);
    expect(t.estimate()).toBeNull();
    tool.onFiles?.([png('a.png'), png('b.png')]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(2));
    await t.ctx.ui.refreshEstimate();
    // 2 pages × (1,800 × $1/M + 1,500 × $2/M)
    expect(t.estimate()).toBeCloseTo(2 * (0.0018 + 0.003), 8);
  });

  it('reads every page, combines them in order, and retries a failed page', async () => {
    const fake = fakeStream(new Set(['b.png']));
    t = createToolTestContext(getTool('ocr'), {
      catalog: [MODEL],
      modelOverride: 'test/vision',
      api: { chatStream: fake.chatStream },
    });
    const tool = await t.mount(setup);
    tool.onFiles?.([png('a.png'), png('b.png'), png('c.png')]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(3));

    await t.runners[0]!.trigger();
    expect(fake.calls).toHaveLength(3);
    const statuses = () => $$(t!.zones.output, 'ocr-page').map((item) => item.dataset['status']);
    expect(statuses()).toEqual(['done', 'failed', 'done']);
    expect($(t.zones.output, 'ocr-failed')?.hidden).toBe(false);
    const history = await t.core.history.query({ tool: 'ocr' });
    expect(history[0]).toMatchObject({ status: 'ok', meta: { pages: 3, failed: ['b.png'] } });
    expect(history[0]?.output).toContain('Text of a.png');
    expect(history[0]?.output).toContain('*[b.png could not be read: Mocked error 400]*');

    $(t.zones.output, 'ocr-page-retry')!.click();
    await vi.waitFor(() => expect(statuses()).toEqual(['done', 'done', 'done']));
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));
    expect(fake.calls).toHaveLength(4);
    const runs = await t.core.history.query({ tool: 'ocr' });
    expect(runs).toHaveLength(2);
    expect(runs[0]?.title).toBe('Retry: b.png');
    expect(runs[0]?.output).toBe(
      '*a.png*\n\nText of a.png\n\n---\n\n*b.png*\n\nText of b.png\n\n---\n\n*c.png*\n\nText of c.png',
    );
  });

  it('stops: nothing else starts, the run is aborted with the partial text kept', async () => {
    let release: () => void = () => undefined;
    const chatStream = vi.fn(
      (
        _body: ChatRequest,
        opts: { run: { signal: AbortSignal }; onEvent: (event: ChatStreamEvent) => void },
      ) =>
        new Promise<ChatStreamResult>((resolve, reject) => {
          opts.onEvent({ type: 'text', text: 'partial' });
          opts.run.signal.addEventListener('abort', () =>
            reject(new DOMException('Stopped.', 'AbortError')),
          );
          release = () => resolve(streamResult('partial'));
        }),
    );
    t = createToolTestContext(getTool('ocr'), {
      catalog: [MODEL],
      modelOverride: 'test/vision',
      api: { chatStream },
    });
    const tool = await t.mount(setup);
    tool.applyState({ prompt: '', settings: { concurrency: 1 } });
    tool.onFiles?.([png('a.png'), png('b.png'), png('c.png')]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(3));
    const running = t.runners[0]!.trigger();
    await vi.waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1));
    t.runners[0]!.stop();
    release();
    await running;
    expect(chatStream).toHaveBeenCalledTimes(1);
    const runs = await t.core.history.query({ tool: 'ocr' });
    expect(runs[0]?.status).toBe('aborted');
    expect($$(t.zones.output, 'ocr-page').map((item) => item.dataset['status'])).toEqual([
      'stopped',
      'stopped',
      'stopped',
    ]);
  });

  it('blocks the paid Mistral parser in free-only mode, with a notice', async () => {
    t = createToolTestContext(getTool('ocr'), { catalog: [MODEL] });
    const tool = await t.mount(setup);
    tool.applyState({ prompt: '', settings: { pdfParser: true, engine: 'mistral-ocr' } });
    t.core.settings.update((draft) => {
      draft.freeOnly = true;
    });
    expect($(t.zones.input, 'ocr-engine-notice')?.hidden).toBe(true); // no PDF yet
    tool.onFiles?.([new File(['%PDF'], 'scan.pdf', { type: 'application/pdf' })]);
    await vi.waitFor(() => expect($(t!.zones.input, 'ocr-engine-notice')?.hidden).toBe(false));
    expect(t.runners[0]?.button.getAttribute('aria-disabled')).toBe('true');
    expect($(t.zones.input, 'run-hint')?.textContent).toMatch(/Mistral OCR is not free/);

    tool.applyState({ prompt: '', settings: { engine: 'cloudflare-ai' } });
    expect($(t.zones.input, 'ocr-engine-notice')?.hidden).toBe(true);
    expect(t.runners[0]?.button.getAttribute('aria-disabled')).toBe('false');
  });
});
