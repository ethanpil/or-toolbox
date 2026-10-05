import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatRequest,
  ChatStreamEvent,
  ChatStreamResult,
  RawModel,
} from '../../core/api/types';
import { ApiError, FreeOnlyError, RunCancelledError } from '../../core/errors';
import { MISTRAL_OCR_PAGE_USD } from '../../core/models/pdf-engines';
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
afterEach(async () => {
  await t?.cleanup();
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
  return { chatStream, calls, failing };
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
    // 2 pages × ((300 + 2,413 image tokens at 1,600 px) × $1/M + 1,500 × $2/M)
    expect(t.estimate()).toBeCloseTo(2 * (0.002713 + 0.003), 8);
    // A larger page image costs more input tokens.
    tool.applyState({ prompt: '', settings: { maxSide: 2048 } });
    await t.ctx.ui.refreshEstimate();
    expect(t.estimate()).toBeGreaterThan(2 * (0.002713 + 0.003));
  });

  it('adds the PDF text hint, and declares the paid parser as an add-on', async () => {
    t = createToolTestContext(getTool('ocr'), { catalog: [MODEL], modelOverride: 'test/vision' });
    const tool = await t.mount(setup);
    tool.applyState({ prompt: '', settings: { textHint: false } });
    tool.onFiles?.([new File(['%PDF'], 'scan.pdf', { type: 'application/pdf' })]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(1));
    await t.ctx.ui.refreshEstimate();
    const plain = t.estimate()!;
    tool.applyState({ prompt: '', settings: { textHint: true } });
    await t.ctx.ui.refreshEstimate();
    // 2 pages × 1,500 hint tokens × $1/M
    expect(t.estimate()! - plain).toBeCloseTo(0.003, 8);

    tool.applyState({ prompt: '', settings: { pdfParser: true, engine: 'cloudflare-ai' } });
    await t.ctx.ui.refreshEstimate();
    const free = t.estimate()!;
    expect(tool.addons?.()).toEqual([]);
    tool.applyState({ prompt: '', settings: { engine: 'mistral-ocr' } });
    await t.ctx.ui.refreshEstimate();
    // The parser's per-page fee is an add-on, kept out of the model estimate but shown in the badge.
    expect(tool.addons?.()).toEqual([
      {
        id: 'pdf-engine:mistral-ocr',
        label: 'Mistral OCR (PDF parser)',
        estimateUsd: 2 * MISTRAL_OCR_PAGE_USD,
      },
    ]);
    expect(await tool.estimate?.('test/vision')).toBeCloseTo(free, 8);
    expect(t.estimate()! - free).toBeCloseTo(2 * MISTRAL_OCR_PAGE_USD, 8);
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

  it('a refused run or retry leaves every page as it was', async () => {
    const fake = fakeStream(new Set(['b.png']));
    t = createToolTestContext(getTool('ocr'), {
      catalog: [MODEL],
      modelOverride: 'test/vision',
      api: { chatStream: fake.chatStream },
    });
    const tool = await t.mount(setup);
    tool.onFiles?.([png('a.png'), png('b.png')]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(2));
    await t.runners[0]!.trigger();
    const snapshot = () => ({
      pages: $$(t!.zones.output, 'ocr-page').map((item) => item.outerHTML),
      text: $(t!.zones.output, 'output-content')?.textContent,
    });
    const before = snapshot();

    // A declined budget confirmation, then free-only mode refusing the retry.
    t.ctx.beginRun = vi
      .fn()
      .mockRejectedValueOnce(new RunCancelledError())
      .mockRejectedValueOnce(new FreeOnlyError(['test/vision']));
    tool.onFiles?.([png('c.png')]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(3));
    await t.runners[0]!.trigger();
    expect(snapshot()).toEqual(before);
    $(t.zones.output, 'ocr-page-retry')!.click();
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));
    expect(t.ctx.beginRun).toHaveBeenCalledTimes(2);
    expect(snapshot()).toEqual(before);
    expect(fake.calls).toHaveLength(2);
    expect(await t.core.history.query({ tool: 'ocr' })).toHaveLength(1);
  });

  it('a Retry the runner cannot start is not kept for the next Run', async () => {
    const fake = fakeStream(new Set(['b.png']));
    t = createToolTestContext(getTool('ocr'), {
      catalog: [MODEL],
      modelOverride: 'test/vision',
      api: { chatStream: fake.chatStream },
    });
    const tool = await t.mount(setup);
    tool.onFiles?.([png('a.png'), png('b.png')]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(2));
    await t.runners[0]!.trigger();

    t.runners[0]!.setDisabled('Not now.');
    const retryButton = $(t.zones.output, 'ocr-page-retry')!;
    await vi.waitFor(() => expect(retryButton.getAttribute('aria-disabled')).toBe('true'));
    expect(retryButton.title).toBe('Not now.');
    retryButton.click();
    expect(fake.calls).toHaveLength(2);

    t.runners[0]!.setDisabled(null);
    await vi.waitFor(() =>
      expect($(t!.zones.output, 'ocr-page-retry')?.getAttribute('aria-disabled')).toBe('false'),
    );
    // The next Run press reads every page again, not just the page whose Retry was refused.
    await t.runners[0]!.trigger();
    expect(fake.calls).toHaveLength(4);
    expect((await t.core.history.query({ tool: 'ocr' }))[0]?.title).toBe('a.png and 1 more file');
  });

  it('the toast Retry after a refused retry retries the same pages', async () => {
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

    const begin = t.ctx.beginRun.bind(t.ctx);
    t.ctx.beginRun = vi.fn().mockRejectedValueOnce(new ApiError('Mocked refusal', 500));
    $(t.zones.output, 'ocr-page-retry')!.click();
    const retryToast = await vi.waitFor(() => {
      const button = document.querySelector<HTMLElement>('[data-testid="toast-retry"]');
      expect(button).not.toBeNull();
      return button!;
    });
    expect(document.querySelectorAll('[data-testid="toast-retry"]')).toHaveLength(1);
    t.ctx.beginRun = begin;
    retryToast.click();
    await vi.waitFor(() => expect(fake.calls).toHaveLength(4));
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));
    expect(fake.calls.at(-1)?.messages[1]?.content).toContainEqual(
      expect.objectContaining({ image_url: { url: 'data:image/png;base64,b.png' } }),
    );
    expect((await t.core.history.query({ tool: 'ocr' }))[0]?.title).toBe('Retry: b.png');
  });

  it('a retry whose pages all fail again fails, even when other pages were read before', async () => {
    const fake = fakeStream(new Set(['b.png']));
    t = createToolTestContext(getTool('ocr'), {
      catalog: [MODEL],
      modelOverride: 'test/vision',
      api: { chatStream: fake.chatStream },
    });
    const tool = await t.mount(setup);
    tool.onFiles?.([png('a.png'), png('b.png')]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(2));
    await t.runners[0]!.trigger();
    fake.failing.add('b.png');
    $(t.zones.output, 'ocr-page-retry')!.click();
    await vi.waitFor(async () =>
      expect(await t!.core.history.query({ tool: 'ocr' })).toHaveLength(2),
    );
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));
    const runs = await t.core.history.query({ tool: 'ocr' });
    expect(runs[0]).toMatchObject({ title: 'Retry: b.png', status: 'error' });
  });

  it('shows a page’s text in the page list while it streams, redrawing only that page', async () => {
    const finish = new Map<string, () => void>();
    const chatStream = vi.fn(
      (body: ChatRequest, opts: { onEvent: (event: ChatStreamEvent) => void }) =>
        new Promise<ChatStreamResult>((resolve) => {
          const name = /“(.+?)”/.exec(JSON.stringify(body.messages[1]?.content))?.[1] ?? '?';
          opts.onEvent({ type: 'text', text: `${name} first` });
          finish.set(name, () => {
            opts.onEvent({ type: 'text', text: ', second' });
            resolve(streamResult(`${name} first, second`));
          });
        }),
    );
    t = createToolTestContext(getTool('ocr'), {
      catalog: [MODEL],
      modelOverride: 'test/vision',
      api: { chatStream },
    });
    const tool = await t.mount(setup);
    tool.onFiles?.([png('a.png'), png('b.png')]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(2));
    const running = t.runners[0]!.trigger();
    const texts = () => $$(t!.zones.output, 'ocr-page-text').map((item) => item.textContent);
    await vi.waitFor(() => expect(texts()).toEqual(['a.png first', 'b.png first']));
    const second = $$(t.zones.output, 'ocr-page')[1]!;
    finish.get('a.png')!();
    await vi.waitFor(() =>
      expect($$(t!.zones.output, 'ocr-page')[0]?.dataset['status']).toBe('done'),
    );
    expect(texts()[0]).toBe('a.png first, second');
    // Page a finishing redrew page a only.
    expect($$(t.zones.output, 'ocr-page')[1]).toBe(second);
    finish.get('b.png')!();
    await running;
    expect(texts()).toEqual(['a.png first, second', 'b.png first, second']);
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

  it('free-only mode refuses the paid Mistral parser before anything is sent', async () => {
    const FREE: RawModel = {
      ...MODEL,
      id: 'test/vision:free',
      pricing: { prompt: '0', completion: '0' },
    };
    const fake = fakeStream();
    t = createToolTestContext(getTool('ocr'), {
      catalog: [FREE],
      modelOverride: 'test/vision:free',
      api: { chatStream: fake.chatStream },
    });
    const tool = await t.mount(setup);
    tool.applyState({ prompt: '', settings: { pdfParser: true, engine: 'mistral-ocr' } });
    t.core.settings.update((draft) => {
      draft.freeOnly = true;
    });
    tool.onFiles?.([new File(['%PDF'], 'scan.pdf', { type: 'application/pdf' })]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(1));
    // No notice of its own: the run refuses, naming the parser, and nothing is read or recorded.
    expect($(t.zones.input, 'ocr-engine-notice')).toBeNull();
    const begin = vi.spyOn(t.ctx, 'beginRun');
    await t.runners[0]!.trigger();
    await expect(begin.mock.results[0]?.value).rejects.toMatchObject({
      code: 'free-only',
      addons: ['Mistral OCR (PDF parser)'],
    });
    expect(fake.calls).toHaveLength(0);
    expect(await t.core.history.query({ tool: 'ocr' })).toHaveLength(0);
    expect($$(t.zones.output, 'ocr-page')).toHaveLength(0);
  });
});
