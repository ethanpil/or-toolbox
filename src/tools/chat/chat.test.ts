import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatRequest,
  ChatStreamEvent,
  ChatStreamResult,
  RawModel,
} from '../../core/api/types';
import { ApiError } from '../../core/errors';
import { getDb } from '../../core/storage/db';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import type { ApiClient, CallOptions } from '../../core/types';
import { createToolTestContext, type ToolTestContext } from '../../ui/tool/testing';
import type { ToolInstance } from '../../ui/tool/types';
import { getTool } from '../registry';
import { paramsFrom, reasoningChoices, SAMPLE_PROMPT, setup } from './chat';
import { parseThread, type Thread } from './thread';

const model = (id: string, prompt: string, input: string[] = ['text', 'image']): RawModel => ({
  id,
  name: `Name of ${id}`,
  created: 1,
  context_length: 100_000,
  architecture: { input_modalities: input, output_modalities: ['text'] },
  pricing: { prompt, completion: prompt },
  top_provider: { context_length: 100_000, max_completion_tokens: 4000 },
  supported_parameters: ['max_tokens', 'temperature'],
});

const CATALOG = [
  model('a/cheap', '0.000001'),
  model('b/pricey', '0.00001'),
  model('c/text-only', '0.000001', ['text']),
];

type StreamOptions = CallOptions & { onEvent: (event: ChatStreamEvent) => void };

/** A chatStream that answers `reply`, reports usage to the run like the client, and records each body. */
function fakeStream(reply: (body: ChatRequest) => string = () => 'Hello **there**') {
  const bodies: ChatRequest[] = [];
  const chatStream = vi.fn((body: ChatRequest, opts: StreamOptions): Promise<ChatStreamResult> => {
    bodies.push(body);
    const text = reply(body);
    opts.onEvent({ type: 'meta', id: 'gen-1', model: body.model });
    opts.onEvent({ type: 'text', text });
    opts.run.addUsage({
      model: body.model,
      promptTokens: 12,
      completionTokens: 3,
      costUsd: 0.0004,
      costEstimated: false,
      latencyMs: 250,
    });
    return Promise.resolve({
      id: 'gen-1',
      model: body.model,
      text,
      reasoning: '',
      images: [],
      audioChunks: [],
      audioTranscript: '',
      finishReason: 'stop',
      usage: null,
    });
  });
  return { bodies, chatStream };
}

let t: ToolTestContext | null = null;

beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
});
/**
 * Waits until no run is going and the tool's queued thread writes have landed, so nothing of this test is
 * written into the next test's fresh database.
 */
async function settle(): Promise<void> {
  if (!t) return;
  const runner = t.runners[0];
  await vi.waitFor(() => expect(runner?.busy ?? false).toBe(false), { timeout: 5000 });
  let last = '';
  for (let stable = 0; stable < 3;) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const now = JSON.stringify(await (await getDb()).getAll('kv'));
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
}

afterEach(async () => {
  await settle();
  t?.cleanup();
  t = null;
  document.body.replaceChildren();
});

async function mount(
  api: Partial<ApiClient> = {},
): Promise<{ tool: ToolInstance; t: ToolTestContext }> {
  t = createToolTestContext(getTool('chat'), { catalog: CATALOG, api });
  t.core.settings.update((draft) => {
    draft.tools.chat = { model: 'a/cheap' };
  });
  const tool = await t.mount(setup);
  await vi.waitFor(() => expect(composerModel()).toContain('Name of a/cheap'));
  return { tool, t };
}

const $ = <E extends Element = HTMLElement>(testId: string): E =>
  document.querySelector<E>(`[data-testid="${testId}"]`)!;
const $$ = (testId: string, root: ParentNode = document): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];
const composer = (): HTMLTextAreaElement => $<HTMLTextAreaElement>('tool-prompt');
const composerModel = (): string => $('composer-model')?.textContent ?? '';
const messages = (): HTMLElement[] => $$('chat-message');
const contents = (): string[] =>
  messages().map((el) => ($$('message-content', el)[0]?.textContent ?? '').trim());

async function send(text: string): Promise<void> {
  composer().value = text;
  await t!.runners[0]!.trigger();
}

/** Storage writes are queued; give them time on a slow machine. */
const eventually = (check: () => Promise<void>): Promise<void> =>
  vi.waitFor(check, { timeout: 5000, interval: 50 });

const storedThreads = async (): Promise<Thread[]> =>
  (await (await getDb()).getAll('kv'))
    .filter((row) => String(row.key).startsWith('tool:chat:thread:'))
    .map((row) => parseThread(row.value)!);

describe('chat tool', () => {
  it('round-trips its state exactly', async () => {
    const { tool } = await mount();
    const state = {
      prompt: 'Summarise the attached report',
      settings: {
        model: 'b/pricey',
        system: 'You are terse.',
        temperature: 0.3,
        maxTokens: 800,
        reasoningEffort: 'high',
        fallbacks: ['c/text-only'],
        pdfEngine: 'mistral-ocr',
      },
    };
    tool.applyState(state);
    expect(tool.getState()).toEqual(state);
    tool.applyState(tool.getState());
    expect(tool.getState()).toEqual(state);
    expect(composerModel()).toContain('Name of b/pricey');

    // Back to the defaults (null = the header's model, no sampling overrides).
    const defaults = {
      prompt: '',
      settings: {
        ...state.settings,
        model: null,
        temperature: null,
        maxTokens: null,
        fallbacks: [],
      },
    };
    tool.applyState(defaults);
    expect(tool.getState()).toEqual(defaults);
    expect(composerModel()).toContain('(default)');
  });

  it('estimates the composer on the chat’s own model', async () => {
    const { tool } = await mount();
    composer().value = 'x'.repeat(4000);
    const cheap = await t!.ctx.ui.refreshEstimate();
    expect(cheap).toBeGreaterThan(0);
    tool.applyState({
      ...tool.getState(),
      settings: { ...tool.getState().settings, model: 'b/pricey' },
    });
    const pricey = await t!.ctx.ui.refreshEstimate();
    expect(pricey).toBeCloseTo(cheap! * 10, 10);
  });

  it('sends, streams the reply and records model, usage, the thread and History', async () => {
    const { bodies, chatStream } = fakeStream();
    await mount({ chatStream });
    await send('Hi there');

    expect(bodies[0]).toMatchObject({
      model: 'a/cheap',
      messages: [{ role: 'user', content: 'Hi there' }],
    });
    expect(composer().value).toBe('');
    expect(messages().map((el) => el.dataset['role'])).toEqual(['user', 'assistant']);
    await vi.waitFor(() => expect(contents()[1]).toBe('Hello there'));
    expect($$('message-usage')[0]?.textContent).toBe('12 in · 3 out · $0.0004 · 250 ms');
    expect($('chat-title').textContent).toBe('Hi there');
    expect($('chat-totals').textContent).toContain('1 reply');

    // Thread writes are queued: wait for the last one.
    await eventually(async () => {
      const [stored] = await storedThreads();
      expect(stored?.title).toBe('Hi there');
      const reply = Object.values(stored!.nodes).find((node) => node.role === 'assistant');
      expect(reply).toMatchObject({
        model: 'a/cheap',
        servedModel: 'a/cheap',
        status: 'done',
        content: 'Hello **there**',
      });
      expect(reply?.usage).toEqual({
        promptTokens: 12,
        completionTokens: 3,
        costUsd: 0.0004,
        latencyMs: 250,
      });
    });

    const [run] = await (await getDb()).getAll('runs');
    expect(run).toMatchObject({
      tool: 'chat',
      status: 'ok',
      model: 'a/cheap',
      prompt: 'Hi there',
      output: 'Hello **there**',
    });
    expect(run?.settings).toMatchObject({ model: 'a/cheap', system: '' });
    expect(run?.reservedUsd).toBeGreaterThan(0);
  });

  it('switches models mid-chat and records the model of each reply', async () => {
    const { bodies, chatStream } = fakeStream((body) => `from ${body.model}`);
    const { tool } = await mount({ chatStream });
    await send('First');
    tool.applyState({
      prompt: 'Second',
      settings: { ...tool.getState().settings, model: 'b/pricey' },
    });
    await t!.runners[0]!.trigger();
    expect(bodies.map((body) => body.model)).toEqual(['a/cheap', 'b/pricey']);
    expect(bodies[1]?.messages).toEqual([
      { role: 'user', content: 'First' },
      { role: 'assistant', content: 'from a/cheap' },
      { role: 'user', content: 'Second' },
    ]);
    expect($$('message-author').map((el) => el.textContent)).toEqual([
      'You',
      'Name of a/cheap',
      'You',
      'Name of b/pricey',
    ]);
  });

  it('edits a message into a branch and navigates between the versions', async () => {
    const { bodies, chatStream } = fakeStream(
      (body) => `re: ${JSON.stringify(body.messages.at(-1)?.content)}`,
    );
    await mount({ chatStream });
    await send('Plan a trip');
    $$('message-edit')[0]!.click();
    const editor = $<HTMLTextAreaElement>('edit-input');
    expect(document.activeElement).toBe(editor);
    editor.value = 'Plan a trip to Rome';
    editor.dispatchEvent(new Event('input'));
    $('edit-save').click();
    await vi.waitFor(() => expect(bodies).toHaveLength(2));
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));

    expect(bodies[1]?.messages).toEqual([{ role: 'user', content: 'Plan a trip to Rome' }]);
    await vi.waitFor(() =>
      expect(contents()).toEqual(['Plan a trip to Rome', 're: "Plan a trip to Rome"']),
    );
    expect($$('sibling-position')[0]?.textContent).toContain('2/2');

    $$('sibling-prev')[0]!.click();
    await vi.waitFor(() => expect(contents()).toEqual(['Plan a trip', 're: "Plan a trip"']));
    expect($$('sibling-position')[0]?.textContent).toContain('1/2');
    expect($('sibling-prev').hasAttribute('disabled')).toBe(true);
  });

  it('regenerates a reply as a sibling, and ↑ in an empty composer edits the last message', async () => {
    let count = 0;
    const { chatStream } = fakeStream(() => `answer ${++count}`);
    await mount({ chatStream });
    await send('Question');
    $$('message-regenerate')[0]!.click();
    await vi.waitFor(() => expect(count).toBe(2));
    await vi.waitFor(() => expect(contents()).toEqual(['Question', 'answer 2']));
    expect($$('sibling-position')[0]?.textContent).toContain('2/2');

    composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect($<HTMLTextAreaElement>('edit-input').value).toBe('Question');
    $('edit-cancel').click();
    expect($$('message-editor')).toHaveLength(0);
  });

  it('Stop keeps the partial reply, silently', async () => {
    const chatStream = vi.fn(
      (_body: ChatRequest, opts: StreamOptions): Promise<ChatStreamResult> =>
        new Promise((_resolve, reject) => {
          opts.onEvent({ type: 'text', text: 'The first half' });
          opts.run.signal.addEventListener('abort', () =>
            reject(new DOMException('Stopped by the user.', 'AbortError')),
          );
        }),
    );
    await mount({ chatStream });
    composer().value = 'Tell me a long story';
    const done = t!.runners[0]!.trigger();
    await vi.waitFor(() => expect(chatStream).toHaveBeenCalled());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await done;

    await vi.waitFor(() => expect(contents()[1]).toBe('The first half'));
    expect($('message-stopped')).not.toBeNull();
    expect($$('message-error')).toHaveLength(0);
    expect($$('error-toast')).toHaveLength(0);
    await eventually(async () => {
      const [stored] = await storedThreads();
      expect(Object.values(stored!.nodes).find((node) => node.role === 'assistant')).toMatchObject({
        status: 'stopped',
        content: 'The first half',
      });
    });
    const [run] = await (await getDb()).getAll('runs');
    expect(run?.status).toBe('aborted');
  });

  it('shows an API error inline on the reply, once, with Retry', async () => {
    let fail = true;
    const { chatStream: ok } = fakeStream(() => 'Recovered');
    const chatStream = vi.fn((body: ChatRequest, opts: StreamOptions) =>
      fail ? Promise.reject(new ApiError('The model is overloaded.', 503)) : ok(body, opts),
    );
    await mount({ chatStream });
    await send('Hello?');
    expect($('message-error').textContent).toContain('The model is overloaded.');
    expect($$('error-toast')).toHaveLength(0);

    fail = false;
    $('message-retry').click();
    await vi.waitFor(() => expect(contents()).toEqual(['Hello?', 'Recovered']));
    // The failed, empty reply was replaced, not kept as a branch.
    expect($$('sibling-nav')).toHaveLength(0);
  });

  it('keeps threads across a reload; attachments are marked as not kept', async () => {
    const { bodies, chatStream } = fakeStream(() => 'A red square.');
    const { tool } = await mount({ chatStream });
    tool.onFiles!([new File([new Uint8Array([1, 2, 3])], 'red.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect($$('composer-attachment')).toHaveLength(1));
    await send('What is this?');
    expect(bodies[0]?.messages[0]?.content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
    ]);
    expect($$('attachment-missing')).toHaveLength(0);
    // The last queued write (the finished reply) follows the one of the current thread's id.
    await eventually(async () => {
      const [stored] = await storedThreads();
      expect(Object.values(stored!.nodes).map((node) => node.status ?? 'user')).toEqual([
        'user',
        'done',
      ]);
    });

    // A new page over the same storage.
    await settle();
    t!.cleanup();
    document.body.replaceChildren();
    await mount({ chatStream });
    await vi.waitFor(() => expect(contents()[0]).toBe('What is this?'));
    expect($('attachment-missing').textContent).toBe('Attachment not kept after reload');
    expect($$('thread-item')).toHaveLength(1);

    // Continuing sends a note instead of the lost image.
    await send('And now?');
    expect(bodies[1]?.messages[0]?.content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'text', text: '[Attachment "red.png" (image) is no longer available.]' },
    ]);
  });

  it('starts new threads, searches and deletes them with Undo', async () => {
    const { chatStream } = fakeStream();
    await mount({ chatStream });
    await send('Alpha question');
    $('chat-new').click();
    expect(messages()).toHaveLength(0);
    await send('Beta question');
    expect($$('thread-title').map((el) => el.textContent)).toEqual([
      'Beta question',
      'Alpha question',
    ]);

    const search = $<HTMLInputElement>('thread-search');
    search.value = 'alpha';
    search.dispatchEvent(new Event('input'));
    expect($$('thread-title').map((el) => el.textContent)).toEqual(['Alpha question']);
    $('thread-open').click();
    expect(contents()[0]).toBe('Alpha question');
    search.value = '';
    search.dispatchEvent(new Event('input'));

    $$('thread-delete')[1]!.click(); // Alpha (current)
    await vi.waitFor(() => expect($('dialog-confirm')).not.toBeNull());
    $('dialog-confirm').click();
    await vi.waitFor(() => expect($$('thread-item')).toHaveLength(1));
    expect(contents()[0]).toBe('Beta question'); // the next thread opened
    await vi.waitFor(() => expect($('toast-undo')).not.toBeNull());
    $('toast-undo').click();
    await vi.waitFor(() => expect($$('thread-item')).toHaveLength(2));
    await eventually(async () => expect(await storedThreads()).toHaveLength(2));
  });

  it('fills the composer with a sample', async () => {
    const { tool } = await mount();
    await tool.sample!();
    expect(composer().value).toBe(SAMPLE_PROMPT);
  });

  it('receives text from another tool as an attachment', async () => {
    const { tool } = await mount();
    tool.onReceive!([
      { kind: 'text', text: '# Invoice 42', type: 'text/markdown', name: 'ocr.md' },
    ]);
    expect($$('composer-attachment')[0]?.textContent).toContain('ocr.md');
  });
});

describe('parameters', () => {
  it('reads saved options defensively', () => {
    expect(paramsFrom({})).toEqual({
      temperature: null,
      maxTokens: null,
      reasoningEffort: '',
      fallbacks: [],
      pdfEngine: 'cloudflare-ai',
      showReasoning: true,
      enterSends: true,
      system: '',
    });
    expect(
      paramsFrom({
        temperature: 9,
        maxTokens: -1,
        reasoningEffort: 'ultra',
        pdfEngine: 'x',
        fallbacks: [1, 'a/b'],
      }),
    ).toMatchObject({
      temperature: null,
      maxTokens: null,
      reasoningEffort: '',
      pdfEngine: 'cloudflare-ai',
      fallbacks: ['a/b'],
    });
  });

  it('offers reasoning efforts from the catalog entry', () => {
    const base = { supportedParameters: ['reasoning'] } as never;
    expect(reasoningChoices(undefined)).toBeNull();
    expect(reasoningChoices({ supportedParameters: [], raw: {} } as never)).toBeNull();
    expect(reasoningChoices({ ...(base as object), raw: {} } as never)).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ]);
    expect(
      reasoningChoices({
        supportedParameters: [],
        raw: {
          reasoning: { supported_efforts: ['none', 'low', 'high', 'weird'], mandatory: true },
        },
      } as never),
    ).toEqual(['low', 'high']);
  });
});
