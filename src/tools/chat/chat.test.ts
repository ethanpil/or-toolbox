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
import { activePath, appendUser, parseThread, type Thread } from './thread';

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
  model('f/free:free', '0'),
];

type StreamOptions = CallOptions & { onEvent: (event: ChatStreamEvent) => void };

/** A chatStream that answers `reply`, reports usage to the run like the client, and records each body. */
function fakeStream(
  reply: (body: ChatRequest) => string = () => 'Hello **there**',
  served: (body: ChatRequest) => string = (body) => body.model,
) {
  const bodies: ChatRequest[] = [];
  const chatStream = vi.fn((body: ChatRequest, opts: StreamOptions): Promise<ChatStreamResult> => {
    bodies.push(body);
    const text = reply(body);
    opts.onEvent({ type: 'meta', id: 'gen-1', model: served(body) });
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
      model: served(body),
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
/** Further "tabs" over the same storage. */
const tabs: ToolTestContext[] = [];

beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
});
/**
 * Waits until no run is going and the tool's queued thread writes have landed, so nothing of this test is
 * written into the next test's fresh database.
 */
async function settle(context: ToolTestContext | null = t): Promise<void> {
  if (!context) return;
  const runner = context.runners[0];
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
  for (const tab of tabs.splice(0)) {
    await settle(tab);
    tab.cleanup();
  }
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

/** Another tab of Chat over the same storage. */
async function mountTab(api: Partial<ApiClient> = {}): Promise<ToolTestContext> {
  const tab = createToolTestContext(getTool('chat'), { catalog: CATALOG, api });
  tab.core.settings.update((draft) => {
    draft.tools.chat = { model: 'a/cheap' };
  });
  tabs.push(tab);
  await tab.mount(setup);
  return tab;
}

const $ = <E extends Element = HTMLElement>(testId: string): E =>
  document.querySelector<E>(`[data-testid="${testId}"]`)!;
const $$ = (testId: string, root: ParentNode = document): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];
const composer = (): HTMLTextAreaElement => $<HTMLTextAreaElement>('tool-prompt');
const composerModel = (): string => $('composer-model')?.textContent ?? '';
const messages = (root: ParentNode = t?.zones.output ?? document): HTMLElement[] =>
  $$('chat-message', root);
const contents = (root?: ParentNode): string[] =>
  messages(root).map((el) => ($$('message-content', el)[0]?.textContent ?? '').trim());

async function send(text: string): Promise<void> {
  composer().value = text;
  await t!.runners[0]!.trigger();
}

/** Storage writes are queued; give them time on a slow machine. */
const eventually = (check: () => Promise<void>): Promise<void> =>
  vi.waitFor(check, { timeout: 5000, interval: 50 });

const pdfFile = (name = 'bill.pdf'): File =>
  new File(['%PDF-1.4 test'], name, { type: 'application/pdf' });
const pngFile = (): File => new File([new Uint8Array([1, 2, 3])], 'red.png', { type: 'image/png' });

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

    const prev = $$('sibling-prev')[0]!;
    prev.focus();
    prev.click();
    await vi.waitFor(() => expect(contents()).toEqual(['Plan a trip', 're: "Plan a trip"']));
    expect($$('sibling-position')[0]?.textContent).toContain('1/2');
    // The other version's ‹ has focus: off now, but still focusable (aria-disabled).
    expect($('sibling-prev')).not.toBe(prev);
    expect(document.activeElement).toBe($('sibling-prev'));
    expect($('sibling-prev').getAttribute('aria-disabled')).toBe('true');
    $('sibling-prev').click(); // does nothing while off
    expect($$('sibling-position')[0]?.textContent).toContain('1/2');
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
    await vi.waitFor(() =>
      expect($$('thread-title').map((el) => el.textContent)).toEqual(['Alpha question']),
    );
    $('thread-open').click();
    expect(contents()[0]).toBe('Alpha question');
    search.value = '';
    search.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect($$('thread-item')).toHaveLength(2));

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

describe('review fixes', () => {
  const confirm = async (): Promise<void> => {
    await vi.waitFor(() => expect($('dialog-confirm')).not.toBeNull());
    $('dialog-confirm').click();
  };

  it('Undo puts a deleted branch back into the thread as it is now', async () => {
    let count = 0;
    const { chatStream } = fakeStream(() => `answer ${++count}`);
    await mount({ chatStream });
    await send('One');
    await send('Two');
    $$('message-delete')[2]!.click();
    await confirm();
    await vi.waitFor(() => expect(contents()).toEqual(['One', 'answer 1']));
    const undo = $('toast-undo');
    // The conversation goes on before Undo.
    await send('Three');
    undo.click();
    await vi.waitFor(() => expect(contents()).toEqual(['One', 'answer 1', 'Two', 'answer 2']));
    expect($$('sibling-position')[0]?.textContent).toContain('1/2');
    $$('sibling-next')[0]!.click();
    await vi.waitFor(() => expect(contents()).toEqual(['One', 'answer 1', 'Three', 'answer 3']));
    await eventually(async () => {
      const [stored] = await storedThreads();
      expect(
        Object.values(stored!.nodes)
          .map((node) => node.content)
          .sort(),
      ).toEqual(['One', 'Three', 'Two', 'answer 1', 'answer 2', 'answer 3']);
    });
  });

  it('refuses Undo when the message the branch followed is gone', async () => {
    const { chatStream } = fakeStream();
    await mount({ chatStream });
    await send('One');
    await send('Two');
    $$('message-delete')[2]!.click();
    await confirm();
    await vi.waitFor(() => expect(messages()).toHaveLength(2));
    const undo = $('toast-undo');
    $$('message-delete')[1]!.click(); // the reply "Two" followed
    await confirm();
    await vi.waitFor(() => expect(messages()).toHaveLength(1));
    undo.click();
    await vi.waitFor(() => expect($('undo-refused')).not.toBeNull());
    expect(contents()).toEqual(['One']);
  });

  it('shows what another tab stored, and merges instead of writing over a newer version', async () => {
    const { chatStream } = fakeStream((body) => `re ${body.messages.length}`);
    await mount({ chatStream });
    await send('From A');
    await settle();
    const b = await mountTab({ chatStream });
    await vi.waitFor(() => expect(contents(b.zones.output)).toEqual(['From A', 're 1']));
    b.zones.input.querySelector<HTMLTextAreaElement>('textarea')!.value = 'From B';
    await b.runners[0]!.trigger();
    // A takes B's messages in, without a reload.
    await vi.waitFor(() => expect(contents()).toEqual(['From A', 're 1', 'From B', 're 3']));
    await settle(b);
    await settle();

    // A version stored past the store (no bus event, as if it was missed): A merges when it writes.
    const [stored] = await storedThreads();
    const theirs = stored!;
    appendUser(theirs, 'Written elsewhere');
    theirs.rev += 1;
    const value = JSON.parse(JSON.stringify(theirs)) as unknown;
    await (await getDb()).put('kv', { key: `tool:chat:thread:${theirs.id}`, value, updatedAt: 1 });
    await send('Again from A');
    await vi.waitFor(() => expect($('chat-merged')).not.toBeNull());
    await eventually(async () => {
      const [merged] = await storedThreads();
      const texts = Object.values(merged!.nodes).map((node) => node.content);
      expect(texts).toContain('Written elsewhere');
      expect(texts).toContain('Again from A');
      expect(texts).toContain('From B');
    });
  });

  it('writes nothing for looking around: versions, an unchanged model, the same state', async () => {
    let count = 0;
    const { chatStream } = fakeStream(() => `answer ${++count}`);
    const { tool } = await mount({ chatStream });
    await send('Question');
    $$('message-regenerate')[0]!.click();
    await vi.waitFor(() => expect(count).toBe(2));
    await settle();
    const set = vi.spyOn(t!.ctx.state, 'set');
    $$('sibling-prev')[0]!.click();
    await vi.waitFor(() => expect(contents()).toEqual(['Question', 'answer 1']));
    tool.applyState(tool.getState());
    await settle();
    expect(set).not.toHaveBeenCalled();
  });

  it('reads a PDF once: the stream brings the parser text, later turns send it instead', async () => {
    const annotations = [
      {
        type: 'file',
        file: {
          hash: 'h',
          name: 'bill.pdf',
          content: [
            { type: 'text', text: '<file name="bill.pdf">' },
            { type: 'text', text: 'Total 12' },
            { type: 'text', text: '</file>' },
          ],
        },
      },
    ];
    const { bodies, chatStream: plain } = fakeStream(() =>
      bodies.length === 1 ? 'The total is 12.' : 'It is from May.',
    );
    const chatStream = vi.fn(async (body: ChatRequest, opts: StreamOptions) => {
      const result = await plain(body, opts);
      return bodies.length === 1 ? { ...result, annotations } : result;
    });
    const { tool } = await mount({ chatStream });
    tool.onFiles!([pdfFile()]);
    await vi.waitFor(() => expect($$('composer-attachment')).toHaveLength(1));
    await send('Total?');
    expect(bodies[0]?.plugins).toEqual([{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }]);
    expect((bodies[0]?.messages[0]?.content as { type: string }[])[1]?.type).toBe('file');
    await vi.waitFor(() => expect(contents()[1]).toBe('The total is 12.'));

    await send('And the date?');
    expect(bodies[1]?.messages[0]?.content).toEqual([
      { type: 'text', text: 'Total?' },
      { type: 'text', text: '<file name="bill.pdf">\nTotal 12\n</file>' },
    ]);
    expect(bodies[1]?.plugins).toBeUndefined();
    expect($$('attachment-missing')).toHaveLength(0);
    await eventually(async () => {
      const [stored] = await storedThreads();
      expect(activePath(stored!)[0]?.attachments?.[0]?.parsed).toContain('Total 12');
    });
  });

  it('declares the paid PDF parser as a run add-on', async () => {
    const { chatStream } = fakeStream();
    const { tool } = await mount({ chatStream });
    tool.onFiles!([pdfFile()]);
    await vi.waitFor(() => expect($$('composer-attachment')).toHaveLength(1));
    expect(tool.addons!()).toEqual([]); // Cloudflare AI is free
    tool.applyState({
      prompt: 'Read it',
      settings: { ...tool.getState().settings, pdfEngine: 'mistral-ocr' },
    });
    const addon = { id: 'pdf-engine:mistral-ocr', label: 'Mistral OCR (PDF parser)' };
    expect(tool.addons!()).toEqual([expect.objectContaining(addon)]);
    const begin = vi.spyOn(t!.ctx, 'beginRun');
    await t!.runners[0]!.trigger();
    expect(begin.mock.calls[0]?.[0].addons).toEqual([
      { ...addon, estimateUsd: expect.any(Number) as number },
    ]);
  });

  it('refuses the paid Mistral OCR reader in free-only mode', async () => {
    const chatStream = vi.fn();
    const { tool } = await mount({ chatStream });
    t!.core.settings.update((draft) => {
      draft.freeOnly = true;
      draft.tools.chat = { model: 'f/free:free' };
    });
    tool.applyState({
      prompt: 'Read it',
      settings: { ...tool.getState().settings, pdfEngine: 'mistral-ocr' },
    });
    tool.onFiles!([pdfFile()]);
    await vi.waitFor(() => expect($$('composer-attachment')).toHaveLength(1));
    await t!.runners[0]!.trigger();
    await vi.waitFor(() => expect($('error-toast')?.textContent).toContain('Mistral OCR'));
    expect(chatStream).not.toHaveBeenCalled();
    expect(composer().value).toBe('Read it');
    expect(messages()).toHaveLength(0);
  });

  it('clamps Max tokens to the model, and refuses a message too long for its context', async () => {
    const { bodies, chatStream } = fakeStream();
    const { tool } = await mount({ chatStream });
    tool.applyState({ prompt: 'Hi', settings: { ...tool.getState().settings, maxTokens: 50_000 } });
    await t!.runners[0]!.trigger();
    expect(bodies[0]?.max_tokens).toBe(4000);

    composer().value = 'x'.repeat(420_000); // ~105,000 tokens; the model reads 100,000
    await t!.runners[0]!.trigger();
    await vi.waitFor(() => expect($('error-toast')?.textContent).toContain('too long'));
    expect(bodies).toHaveLength(1);
    expect(composer().value).toHaveLength(420_000);
  });

  it('will not send an image to a model without image input, on Edit too', async () => {
    const { bodies, chatStream } = fakeStream();
    const { tool } = await mount({ chatStream });
    tool.onFiles!([pngFile()]);
    await vi.waitFor(() => expect($$('composer-attachment')).toHaveLength(1));
    await send('What is this?');
    expect(bodies).toHaveLength(1);
    tool.applyState({
      prompt: '',
      settings: { ...tool.getState().settings, model: 'c/text-only' },
    });
    $$('message-edit')[0]!.click();
    $('edit-save').click();
    await vi.waitFor(() => expect($('error-toast')?.textContent).toContain("can't read images"));
    expect(bodies).toHaveLength(1);
  });

  it('caps the text one message takes, from files and from Send to', async () => {
    const { tool } = await mount();
    const big = 'x'.repeat(900_000);
    tool.onReceive!([
      { kind: 'text', text: big, name: 'a.txt' },
      { kind: 'text', text: big, name: 'b.txt' },
      { kind: 'text', text: big, name: 'c.txt' },
    ]);
    expect($$('composer-attachment')).toHaveLength(2);
    expect($('attach-error').textContent).toContain('c.txt');
    tool.onReceive!([{ kind: 'text', text: 'y'.repeat(1_100_000) }]);
    expect(composer().value).toBe('');
  });

  it('says which model answered whenever it is not the one asked for', async () => {
    const { chatStream } = fakeStream(undefined, (body) => `${body.model}-2025-01-01`);
    await mount({ chatStream });
    await send('Hi');
    await vi.waitFor(() => expect($('message-served').textContent).toBe('via a/cheap-2025-01-01'));
  });

  it('estimates on the dearest fallback, and warns when no retention skips a free model', async () => {
    const { tool } = await mount();
    composer().value = 'x'.repeat(4000);
    const cheap = await t!.ctx.ui.refreshEstimate();
    tool.applyState({
      prompt: 'x'.repeat(4000),
      settings: { ...tool.getState().settings, fallbacks: ['b/pricey'] },
    });
    const withFallback = await t!.ctx.ui.refreshEstimate();
    expect(withFallback).toBeCloseTo(cheap! * 10, 10);

    expect($$('warning-retention')).toHaveLength(0);
    t!.keyState.keys[0]!.noRetention = true;
    tool.applyState({
      prompt: '',
      settings: { ...tool.getState().settings, model: 'f/free:free' },
    });
    await vi.waitFor(() => expect($('warning-retention').textContent).toContain('skips the free'));
  });

  it('leaves Enter and Escape to an input method while it composes', async () => {
    const { bodies, chatStream } = fakeStream();
    await mount({ chatStream });
    composer().value = '日本';
    const enter = (init: KeyboardEventInit = {}, keyCode?: number): void => {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        ...init,
      });
      if (keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: keyCode });
      composer().dispatchEvent(event);
    };
    enter({ isComposing: true });
    enter({}, 229);
    // Pressing Enter to send starts the run at once; while composing nothing starts.
    expect(t!.runners[0]!.busy).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(bodies).toHaveLength(0);
    enter();
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
  });

  it('Escape stops a reply, but not while composing or in a field that uses Escape', async () => {
    const chatStream = vi.fn(
      (_body: ChatRequest, opts: StreamOptions): Promise<ChatStreamResult> =>
        new Promise((_resolve, reject) => {
          opts.onEvent({ type: 'text', text: 'Partial' });
          opts.run.signal.addEventListener('abort', () =>
            reject(new DOMException('Stopped by the user.', 'AbortError')),
          );
        }),
    );
    await mount({ chatStream });
    composer().value = 'Long story';
    const done = t!.runners[0]!.trigger();
    await vi.waitFor(() => expect(chatStream).toHaveBeenCalled());
    const escape = (target: EventTarget, init: KeyboardEventInit = {}): void => {
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }),
      );
    };
    escape(composer(), { isComposing: true });
    escape($('thread-search'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(t!.runners[0]!.busy).toBe(true);
    escape(composer());
    await done;
    expect($('message-stopped')).not.toBeNull();
  });

  it('is a labelled region, announces the reply, and redraws only what changed', async () => {
    let count = 0;
    const { chatStream } = fakeStream(() => `answer ${++count}`);
    const { tool } = await mount({ chatStream });
    const log = $('chat-log');
    expect(log.getAttribute('role')).toBe('region');
    expect(log.getAttribute('aria-label')).toBe('Conversation');
    expect(log.hasAttribute('aria-live')).toBe(false);

    const status = vi.spyOn(t!.ctx.ui, 'status');
    tool.onFiles!([pngFile()]);
    await vi.waitFor(() => expect($$('composer-attachment')).toHaveLength(1));
    await send('First');
    expect(status.mock.calls.map(([text]) => text)).toEqual(['Reply started.', 'Reply complete.']);
    await vi.waitFor(() => expect(contents()[1]).toBe('answer 1'));
    const [question, reply] = messages();
    const thumb = question!.querySelector('img');
    expect(thumb).not.toBeNull();

    await send('Second');
    await vi.waitFor(() => expect(contents()).toHaveLength(4));
    expect(messages()[0]).toBe(question);
    expect(messages()[1]).toBe(reply);
    expect(question!.querySelector('img')).toBe(thumb);

    // Regenerate keeps focus on the place's Regenerate button, through the run.
    const regen = $$('message-regenerate')[1]!;
    regen.focus();
    regen.click();
    await vi.waitFor(() => expect(count).toBe(3));
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));
    await vi.waitFor(() => expect(contents()[3]).toBe('answer 3'));
    expect($$('message-regenerate')[1]).not.toBe(regen);
    expect(document.activeElement).toBe($$('message-regenerate')[1]);
  });

  it('moves focus to the next thread when one is deleted', async () => {
    const { chatStream } = fakeStream();
    await mount({ chatStream });
    await send('Alpha');
    $('chat-new').click();
    await send('Beta');
    $$('thread-delete')[0]!.focus();
    $$('thread-delete')[0]!.click(); // Beta, the newest
    await confirm();
    await vi.waitFor(() => expect($$('thread-item')).toHaveLength(1));
    expect(document.activeElement).toBe($('thread-open'));
    expect($('thread-title').textContent).toBe('Alpha');
  });

  it('keeps the bytes of an attachment for Undo, and shows it again', async () => {
    const { chatStream } = fakeStream();
    const { tool } = await mount({ chatStream });
    await send('First');
    tool.onFiles!([pngFile()]);
    await vi.waitFor(() => expect($$('composer-attachment')).toHaveLength(1));
    await send('Look');
    $$('message-delete')[2]!.click();
    await confirm();
    await vi.waitFor(() => expect(messages()).toHaveLength(2));
    $('toast-undo').click();
    await vi.waitFor(() => expect(messages()).toHaveLength(4));
    expect(messages()[2]!.querySelector('img')).not.toBeNull();
    expect($$('attachment-missing')).toHaveLength(0);
  });
});
