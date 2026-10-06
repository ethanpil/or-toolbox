import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatRequest,
  ChatStreamEvent,
  ChatStreamResult,
  RawModel,
} from '../../core/api/types';
import { ApiError, FreeOnlyError, KeyLockedError, RunCancelledError } from '../../core/errors';
import { MISTRAL_OCR_PAGE_USD } from '../../core/models/pdf-engines';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import { createToolTestContext, type ToolTestContext } from '../../ui/tool/testing';
import { getTool } from '../registry';
import { setup } from './tool';

// The unlock dialog: the user enters the passphrase at once, and the tool's Retry follows.
vi.mock('../../ui/feedback/unlock', () => ({ unlockDialog: () => Promise.resolve(true) }));
const imageSizes = vi.hoisted(() => [] as (number | undefined)[]);
vi.mock('../../core/media/image', () => ({
  toDataUrl: (blob: File, options?: { maxDimension?: number }) => {
    imageSizes.push(options?.maxDimension);
    return Promise.resolve(`data:image/png;base64,${blob.name}`);
  },
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
const nameOf = (body: ChatRequest): string => {
  const content = body.messages[1]?.content as { type: string; image_url?: { url: string } }[];
  const image = content.find((part) => part.type === 'image_url');
  if (image?.image_url) return image.image_url.url.split(',')[1] ?? '?';
  return /“(.+?)”/.exec(JSON.stringify(content))?.[1] ?? '?';
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
  imageSizes.length = 0;
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

describe('OCR tool: run safety', { timeout: 30_000 }, () => {
  const unknown = (): ApiError =>
    Object.assign(new ApiError('Bad gateway', 502), { outcomeUnknown: true });

  const held =
    (
      bodies: ChatRequest[],
      release: (() => void)[],
    ): ((
      body: ChatRequest,
      opts: { onEvent: (event: ChatStreamEvent) => void },
    ) => Promise<ChatStreamResult>) =>
    (body, opts) => {
      bodies.push(body);
      opts.onEvent({ type: 'text', text: 'x' });
      return new Promise<ChatStreamResult>((resolve) =>
        release.push(() => resolve(streamResult('x'))),
      );
    };

  it('the Retry after a fatal error part-way (keys locked) reads only the pages without a result', async () => {
    const seen: string[] = [];
    let broke = false;
    const chatStream = vi.fn(
      (body: ChatRequest, opts: { onEvent: (event: ChatStreamEvent) => void }) => {
        const name = nameOf(body);
        seen.push(name);
        if (name === 'b.png' && !broke) {
          broke = true;
          return Promise.reject(new KeyLockedError());
        }
        opts.onEvent({ type: 'text', text: `Text of ${name}` });
        return Promise.resolve(streamResult(`Text of ${name}`));
      },
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
    await t.runners[0]!.trigger();
    // The error is the runner's: the unlock dialog (answered at once here), then its replay.
    await vi.waitFor(() => expect(seen).toHaveLength(4));
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));
    // a is not paid for again: the replay covers b and c.
    expect(seen).toEqual(['a.png', 'b.png', 'b.png', 'c.png']);
    expect($$(t.zones.output, 'ocr-page').map((item) => item.dataset['status'])).toEqual([
      'done',
      'done',
      'done',
    ]);
  });

  it('a refused first run is replayed as a whole run', async () => {
    const fake = fakeStream();
    t = createToolTestContext(getTool('ocr'), {
      catalog: [MODEL],
      modelOverride: 'test/vision',
      api: { chatStream: fake.chatStream },
    });
    const tool = await t.mount(setup);
    tool.onFiles?.([png('a.png'), png('b.png')]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(2));
    const begin = t.ctx.beginRun.bind(t.ctx);
    t.ctx.beginRun = vi.fn().mockRejectedValueOnce(new ApiError('Mocked refusal', 500));
    await t.runners[0]!.trigger();
    t.ctx.beginRun = begin;
    document.querySelector<HTMLElement>('[data-testid="toast-retry"]')!.click();
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));
  });

  it('words a page that may have been billed with the caution and the activity link, and asks before its Retry', async () => {
    const seen: string[] = [];
    let failB = true;
    const chatStream = vi.fn(
      (body: ChatRequest, opts: { onEvent: (event: ChatStreamEvent) => void }) => {
        const name = nameOf(body);
        seen.push(name);
        if (name === 'b.png' && failB) return Promise.reject(unknown());
        opts.onEvent({ type: 'text', text: `Text of ${name}` });
        return Promise.resolve(streamResult(`Text of ${name}`));
      },
    );
    t = createToolTestContext(getTool('ocr'), {
      catalog: [MODEL],
      modelOverride: 'test/vision',
      api: { chatStream },
    });
    const tool = await t.mount(setup);
    tool.onFiles?.([png('a.png'), png('b.png')]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(2));
    await t.runners[0]!.trigger();
    expect(seen).toHaveLength(2);

    const error = $(t.zones.output, 'ocr-page-error')!;
    expect(error.textContent).toContain('may still have done the work');
    expect($(t.zones.output, 'ocr-page-error-activity')?.getAttribute('href')).toMatch(
      /openrouter\.ai\/activity/,
    );
    expect($$(t.zones.output, 'ocr-page-retry')).toHaveLength(1);

    // Declining the question sends nothing.
    $(t.zones.output, 'ocr-page-retry')!.click();
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

    // "Retry anyway" sends it.
    failB = false;
    $(t.zones.output, 'ocr-page-retry')!.click();
    const again = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-testid="retry-unknown-confirm"]');
      expect(element).not.toBeNull();
      return element!;
    });
    again.querySelector<HTMLElement>('[data-testid="dialog-confirm"]')!.click();
    await vi.waitFor(() => expect(seen).toHaveLength(3));
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));
  });

  it('reads every page with the settings and instructions of the moment Read was pressed', async () => {
    const release: (() => void)[] = [];
    const bodies: ChatRequest[] = [];
    t = createToolTestContext(getTool('ocr'), {
      catalog: [MODEL],
      modelOverride: 'test/vision',
      api: { chatStream: vi.fn(held(bodies, release)) },
    });
    const tool = await t.mount(setup);
    tool.applyState({
      prompt: 'First instructions',
      settings: { concurrency: 1, mode: 'printed', language: 'German', maxSide: 1024 },
    });
    tool.onFiles?.([png('a.png'), png('b.png')]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(2));
    const running = t.runners[0]!.trigger();
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    // Everything changes while the first page is read.
    tool.applyState({
      prompt: 'Other instructions',
      settings: { mode: 'math', language: 'French', maxSide: 2048 },
    });
    release.shift()!();
    await vi.waitFor(() => expect(bodies).toHaveLength(2));
    release.shift()!();
    await running;

    const [first, second] = bodies;
    expect(second!.messages[0]).toEqual(first!.messages[0]);
    expect(JSON.stringify(second!.messages[1])).toContain('First instructions');
    expect(JSON.stringify(second!.messages[1])).not.toContain('Other instructions');
    expect(JSON.stringify(second!.messages[0])).toContain('German');
    expect(imageSizes).toEqual([1024, 1024]);
    const run = (await t.core.history.query({ tool: 'ocr' }))[0]!;
    expect(run.prompt).toBe('First instructions');
    expect(run.settings).toMatchObject({ mode: 'printed', language: 'German', maxSide: 1024 });
  });

  it('keeps the parser engine it began with, so a switch to the paid one mid-run costs nothing unreserved', async () => {
    const release: (() => void)[] = [];
    const bodies: ChatRequest[] = [];
    t = createToolTestContext(getTool('ocr'), {
      catalog: [MODEL],
      modelOverride: 'test/vision',
      api: { chatStream: vi.fn(held(bodies, release)) },
    });
    const tool = await t.mount(setup);
    tool.applyState({
      prompt: '',
      settings: { concurrency: 1, pdfParser: true, engine: 'cloudflare-ai' },
    });
    tool.onFiles?.([
      new File(['%PDF'], 'one.pdf', { type: 'application/pdf' }),
      new File(['%PDF'], 'two.pdf', { type: 'application/pdf' }),
    ]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(2));
    const running = t.runners[0]!.trigger();
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    tool.applyState({ prompt: '', settings: { engine: 'mistral-ocr', pdfParser: false } });
    release.shift()!();
    await vi.waitFor(() => expect(bodies).toHaveLength(2));
    release.shift()!();
    await running;
    expect(bodies.map((body) => body.plugins)).toEqual([
      [{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }],
      [{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }],
    ]);
  });

  it('asks for no more output than the model can give', async () => {
    const small: RawModel = { ...MODEL, top_provider: { max_completion_tokens: 2000 } };
    const fake = fakeStream();
    t = createToolTestContext(getTool('ocr'), {
      catalog: [small],
      modelOverride: 'test/vision',
      api: { chatStream: fake.chatStream },
    });
    const tool = await t.mount(setup);
    tool.onFiles?.([png('a.png')]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(1));
    await t.runners[0]!.trigger();
    expect(fake.calls[0]?.max_tokens).toBe(2000);

    tool.applyState({ prompt: '', settings: { pdfParser: true } });
    tool.onFiles?.([new File(['%PDF'], 'scan.pdf', { type: 'application/pdf' })]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(2));
    await t.runners[0]!.trigger();
    expect(fake.calls.at(-1)?.max_tokens).toBe(2000);
  });

  it('shows a refusal as the page’s failure, never as its text', async () => {
    const chatStream = vi.fn(
      (body: ChatRequest, opts: { onEvent: (event: ChatStreamEvent) => void }) => {
        const name = nameOf(body);
        if (name === 'b.png') {
          opts.onEvent({ type: 'text', text: 'I cannot read this.' });
          return Promise.resolve({
            ...streamResult('I cannot read this.'),
            refusal: 'I cannot read this.',
          });
        }
        opts.onEvent({ type: 'text', text: 'Fine' });
        return Promise.resolve(streamResult('Fine'));
      },
    );
    t = createToolTestContext(getTool('ocr'), {
      catalog: [MODEL],
      modelOverride: 'test/vision',
      api: { chatStream },
    });
    const tool = await t.mount(setup);
    tool.onFiles?.([png('a.png'), png('b.png')]);
    await vi.waitFor(() => expect($$(t!.zones.input, 'doc-file')).toHaveLength(2));
    await t.runners[0]!.trigger();
    const pages = $$(t.zones.output, 'ocr-page');
    expect(pages.map((item) => item.dataset['status'])).toEqual(['done', 'failed']);
    expect($(pages[1]!, 'ocr-page-error')?.textContent).toContain('I cannot read this.');
    expect($(pages[1]!, 'ocr-page-text')).toBeNull();
    const run = (await t.core.history.query({ tool: 'ocr' }))[0]!;
    expect(run.output).toContain('could not be read');
  });

  it('says what to change when free-only mode refuses the paid parser, not to pick a free model', async () => {
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
    await t.runners[0]!.trigger();
    const toast = await vi.waitFor(() => {
      const element = [...document.querySelectorAll<HTMLElement>('[data-testid="error-toast"]')].at(
        -1,
      );
      expect(element).toBeDefined();
      return element!;
    });
    expect(toast.textContent).toContain('Mistral OCR (PDF parser) is not free');
    expect(toast.textContent).toContain('free parser');
    expect(toast.textContent).not.toContain('Pick a free model');
  });
});
