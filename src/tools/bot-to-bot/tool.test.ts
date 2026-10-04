import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatRequest,
  ChatStreamEvent,
  ChatStreamResult,
  RawModel,
} from '../../core/api/types';
import { ApiError, RunCancelledError } from '../../core/errors';
import { getDb } from '../../core/storage/db';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import type { ApiClient, CallOptions, RunRecord } from '../../core/types';
import { createToolTestContext, type ToolTestContext } from '../../ui/tool/testing';
import type { ToolInstance } from '../../ui/tool/types';
import { getTool } from '../registry';
import { type Conversation, createConversation, parseConversation } from './conversation';
import { DEFAULT_LIMITS, SAMPLE, setup } from './tool';

const model = (id: string, price: string, context = 100_000): RawModel => ({
  id,
  name: `Name of ${id}`,
  created: 1,
  context_length: context,
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  pricing: { prompt: price, completion: price },
  top_provider: { context_length: context, max_completion_tokens: 4000 },
  supported_parameters: ['max_tokens'],
});

const CATALOG = [
  model('a/cheap', '0.000001'),
  model('b/other', '0.000002'),
  model('f/free:free', '0'),
  model('g/also:free', '0'),
];

type StreamOptions = CallOptions & { onEvent: (event: ChatStreamEvent) => void };

/** A message's text (bot requests send strings only). */
const textOf = (content: unknown): string => (typeof content === 'string' ? content : '');

/** Who a request is for: the name in its framing ("You are Bot A, …"). */
const speakerOf = (body: ChatRequest): string =>
  /You are (.+?), in a conversation/.exec(textOf(body.messages[0]?.content))?.[1] ?? '?';

const result = (text: string, model: string): ChatStreamResult => ({
  id: 'gen',
  model,
  text,
  reasoning: '',
  images: [],
  audioChunks: [],
  audioTranscript: '',
  finishReason: 'stop',
  usage: null,
});

/** A chatStream that answers `reply`, reports usage to the run like the client does, and records each body. */
function fakeStream(
  reply: (body: ChatRequest, index: number) => string = (body, index) =>
    `${speakerOf(body)} says ${index}`,
  costUsd = 0.0004,
) {
  const bodies: ChatRequest[] = [];
  const chatStream = vi.fn((body: ChatRequest, opts: StreamOptions): Promise<ChatStreamResult> => {
    bodies.push(body);
    const text = reply(body, bodies.length);
    opts.onEvent({ type: 'text', text });
    opts.run.addUsage({
      model: body.model,
      promptTokens: 12,
      completionTokens: 3,
      costUsd,
      costEstimated: false,
      latencyMs: 250,
    });
    return Promise.resolve(result(text, body.model));
  });
  return { bodies, chatStream };
}

/** A chatStream whose turns wait until released (or aborted, keeping the partial text). */
function heldStream() {
  const bodies: ChatRequest[] = [];
  const waiting: (() => void)[] = [];
  const chatStream = vi.fn(
    (body: ChatRequest, opts: StreamOptions): Promise<ChatStreamResult> =>
      new Promise((resolve, reject) => {
        bodies.push(body);
        const text = `${speakerOf(body)} says ${bodies.length}`;
        opts.onEvent({ type: 'text', text: 'Partial' });
        // The client combines the call's signal (the time limit) with the run's (Stop).
        for (const signal of [opts.signal, opts.run.signal]) {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('Stopped by the user.', 'AbortError')),
          );
        }
        waiting.push(() => {
          opts.onEvent({ type: 'text', text: text.slice('Partial'.length) });
          opts.run.addUsage({
            model: body.model,
            promptTokens: 10,
            completionTokens: 5,
            costUsd: 0.001,
            costEstimated: false,
            latencyMs: 100,
          });
          resolve(result(`Partial${text.slice('Partial'.length)}`, body.model));
        });
      }),
  );
  const release = async (): Promise<void> => {
    await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0));
    waiting.shift()!();
  };
  return { bodies, chatStream, release };
}

let t: ToolTestContext | null = null;

beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
});

/** Waits until no run is going and the tool's queued writes have landed. */
async function settle(): Promise<void> {
  if (!t) return;
  await vi.waitFor(() => expect(t!.runners[0]?.busy ?? false).toBe(false), { timeout: 5000 });
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
  options: { noKey?: boolean } = {},
): Promise<ToolInstance> {
  t = createToolTestContext(getTool('bot-to-bot'), { catalog: CATALOG, api, ...options });
  t.core.settings.update((draft) => {
    draft.tools['bot-to-bot'] = { ...draft.tools['bot-to-bot'], model: 'a/cheap' };
  });
  const tool = await t.mount(setup);
  await vi.waitFor(() => expect($('bot-a-model').textContent).toContain('Name of a/cheap'));
  return tool;
}

const $ = <E extends Element = HTMLElement>(testId: string): E =>
  document.querySelector<E>(`[data-testid="${testId}"]`)!;
const $$ = (testId: string, root: ParentNode = document): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];
const turns = (): HTMLElement[] => $$('bot-turn');
const turnTexts = (): string[] =>
  turns().map((el) => ($$('turn-content', el)[0]?.textContent ?? '').trim());

/** Sets the form (on top of what is there) and the opener. */
function configure(
  tool: ToolInstance,
  settings: Record<string, unknown>,
  opener = 'Is zero even?',
) {
  tool.applyState({ prompt: opener, settings: { ...tool.getState().settings, ...settings } });
}

const stored = async (): Promise<Conversation | null> =>
  parseConversation((await (await getDb()).get('kv', 'tool:bot-to-bot:conversation'))?.value);
const runs = async (): Promise<RunRecord[]> => (await getDb()).getAll('runs');

const eventually = (check: () => Promise<void> | void): Promise<void> =>
  vi.waitFor(check, { timeout: 5000, interval: 50 });

describe('setup and state', () => {
  it('round-trips its state exactly', async () => {
    const tool = await mount();
    const state = {
      prompt: 'Debate pineapple on pizza.',
      settings: {
        botA: { name: 'Ada', model: 'b/other', persona: 'You love pineapple.' },
        botB: { name: 'Bo', model: null, persona: '' },
        first: 'b',
        turnLimit: 6,
        timeLimitMinutes: 2.5,
        costCapUsd: 0.05,
        stopPhrase: 'GOODBYE',
        maxTokens: null,
      },
    };
    tool.applyState(state);
    expect(tool.getState()).toEqual(state);
    tool.applyState(tool.getState());
    expect(tool.getState()).toEqual(state);
    expect($<HTMLInputElement>('bot-a-name').value).toBe('Ada');
    expect($('bot-a-model').textContent).toContain('Name of b/other');
    expect($('bot-b-model').textContent).toContain('(default)');
    expect($<HTMLInputElement>('bots-first-b').checked).toBe(true);
    expect($<HTMLInputElement>('bots-max-tokens').value).toBe('');
    // The framing shows what each bot is told: its persona, both names and the stop phrase.
    expect($('bots-framing-a').textContent).toContain('You love pineapple.');
    expect($('bots-framing-a').textContent).toContain('You are Ada, in a conversation with Bo.');
    expect($('bots-framing-b').textContent).toContain('end your message with GOODBYE');
  });

  it('keeps its defaults in step with the manifest', () => {
    expect(getTool('bot-to-bot').defaults).toEqual(DEFAULT_LIMITS);
  });

  it('estimates a Start as the cost cap or less, and free models as free', async () => {
    const tool = await mount();
    configure(tool, { turnLimit: 3, maxTokens: 100, costCapUsd: 0.25 });
    const small = await t!.ctx.ui.refreshEstimate();
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(0.01);
    configure(tool, { turnLimit: 200, maxTokens: 4000, costCapUsd: 0.02 });
    expect(await t!.ctx.ui.refreshEstimate()).toBe(0.02);
    configure(tool, {
      botA: { name: 'A', model: 'f/free:free', persona: '' },
      botB: { name: 'B', model: 'g/also:free', persona: '' },
    });
    expect(await t!.ctx.ui.refreshEstimate()).toBe(0);
  });

  it('fills a sample with two free models and a fun opener', async () => {
    const tool = await mount();
    await tool.sample!();
    const state = tool.getState();
    expect(state.prompt).toBe(SAMPLE.opener);
    expect(state.settings).toMatchObject({
      botA: { name: 'Sage', model: 'f/free:free' },
      botB: { name: 'Spark', model: 'g/also:free' },
      turnLimit: SAMPLE.turnLimit,
    });
  });
});

describe('a conversation', () => {
  it('runs to the turn limit: alternating speakers, roles per speaker, merged and marked', async () => {
    const { bodies, chatStream } = fakeStream();
    const tool = await mount({ chatStream });
    configure(tool, {
      turnLimit: 4,
      botB: { name: 'Bot B', model: 'b/other', persona: 'Be terse.' },
    });
    await t!.runners[0]!.trigger();

    expect(bodies.map(speakerOf)).toEqual(['Bot A', 'Bot B', 'Bot A', 'Bot B']);
    expect(bodies.map((body) => body.model)).toEqual(['a/cheap', 'b/other', 'a/cheap', 'b/other']);
    expect(bodies[0]?.messages.slice(1)).toEqual([
      { role: 'user', content: '[Moderator] Is zero even?' },
    ]);
    expect(bodies[1]?.messages[0]?.content).toMatch(/^Be terse\.\n\nYou are Bot B/);
    expect(bodies[1]?.messages.slice(1)).toEqual([
      { role: 'user', content: '[Moderator] Is zero even?\n\n[Bot A] Bot A says 1' },
    ]);
    expect(bodies[2]?.messages.slice(1)).toEqual([
      { role: 'user', content: '[Moderator] Is zero even?' },
      { role: 'assistant', content: 'Bot A says 1' },
      { role: 'user', content: 'Bot B says 2' },
    ]);
    expect(bodies[0]?.max_tokens).toBe(1000);

    await vi.waitFor(() =>
      expect(turnTexts()).toEqual(['Bot A says 1', 'Bot B says 2', 'Bot A says 3', 'Bot B says 4']),
    );
    expect(turns().map((el) => el.dataset['speaker'])).toEqual(['a', 'b', 'a', 'b']);
    expect($$('turn-usage')[0]?.textContent).toBe('12 in · 3 out · $0.0004 · 250 ms');
    expect($('conversation-end').dataset['reason']).toBe('turns');
    expect($('conversation-end').textContent).toContain('Turn limit reached (4 turns).');
    expect(t!.status()).toBe('Ended. Turn limit reached (4 turns).');
    expect($('bots-state').textContent).toBe('Ended · Turn limit');
    expect($('bots-turns').textContent).toBe('4 / 4');
    expect($('bots-cost').textContent).toBe('$0.0016 / $0.25');
    expect($('bots-primary').textContent).toContain('Resume');

    const [run] = await runs();
    expect(run).toMatchObject({
      tool: 'bot-to-bot',
      status: 'ok',
      model: 'a/cheap',
      models: ['a/cheap', 'b/other'],
      prompt: 'Is zero even?',
    });
    expect(run?.output).toContain('## Bot A · Turn 1\n\nBot A says 1');
    expect(run?.output).toContain('**Ended (Turn limit).**');
    await eventually(async () => {
      const conversation = await stored();
      expect(run?.groupId).toBe(conversation?.id);
      expect(conversation?.entries.map((entry) => entry.kind)).toEqual([
        'opener',
        'bot',
        'bot',
        'bot',
        'bot',
        'end',
      ]);
      expect(conversation?.spentUsd).toBeCloseTo(0.0016, 10);
    });

    // At the limit, Resume says why instead of starting a run.
    await t!.runners[0]!.trigger();
    expect(t!.status()).toContain('The turn limit is reached (4 of 4)');
    expect(bodies).toHaveLength(4);
  });

  it('ends when a bot says the stop phrase', async () => {
    const { bodies, chatStream } = fakeStream((body, index) =>
      index === 3 ? 'That settles it. [END]' : `${speakerOf(body)} says ${index}`,
    );
    const tool = await mount({ chatStream });
    configure(tool, {});
    await t!.runners[0]!.trigger();
    expect(bodies).toHaveLength(3);
    expect($('conversation-end').dataset['reason']).toBe('phrase');
    expect(t!.status()).toBe('Ended. Bot A said [END].');
    // The framing asks for the phrase.
    expect(textOf(bodies[0]?.messages[0]?.content)).toContain('end your message with [END]');
  });

  it('checks the cost cap after each turn', async () => {
    const { bodies, chatStream } = fakeStream(undefined, 0.02);
    const tool = await mount({ chatStream });
    configure(tool, { costCapUsd: 0.05, maxTokens: 100 });
    await t!.runners[0]!.trigger();
    // 0.02, 0.04, then 0.06 passes $0.05.
    expect(bodies).toHaveLength(3);
    expect($('conversation-end').dataset['reason']).toBe('cost');
    expect($('conversation-end').textContent).toContain('Cost cap reached: $0.06 spent of $0.05.');
  });

  it('checks the cost cap before a run: a refused Start changes nothing', async () => {
    const { chatStream } = fakeStream();
    const tool = await mount({ chatStream });
    // The first turn alone (1,000 tokens out at $1/M) could pass a $0.0005 cap.
    configure(tool, { costCapUsd: 0.0005 });
    await t!.runners[0]!.trigger();
    expect(chatStream).not.toHaveBeenCalled();
    expect(t!.status()).toContain('could pass the cost cap');
    expect($('bots-empty')).not.toBeNull();
    expect(await runs()).toHaveLength(0);
    expect(document.activeElement).toBe($('bots-cost-cap'));
  });

  it('Stop keeps the partial turn and says Stop ended it', async () => {
    const { chatStream } = heldStream();
    const tool = await mount({ chatStream });
    configure(tool, {});
    const done = t!.runners[0]!.trigger();
    await vi.waitFor(() => expect(turnTexts()).toEqual(['Partial']));
    expect($('bots-state').textContent).toBe('Running');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await done;

    await vi.waitFor(() => expect($('conversation-end').dataset['reason']).toBe('stopped'));
    expect(turns()[0]?.dataset['status']).toBe('stopped');
    expect(turnTexts()).toEqual(['Partial']);
    expect(t!.status()).toBe('Stopped. The partial turn is kept.');
    expect($$('error-toast')).toHaveLength(0);
    expect((await runs())[0]?.status).toBe('aborted');
  });

  it('a refused run (a declined confirmation) changes nothing', async () => {
    const { chatStream } = fakeStream();
    const tool = await mount({ chatStream });
    configure(tool, {});
    t!.ctx.beginRun = vi.fn().mockRejectedValueOnce(new RunCancelledError());
    await t!.runners[0]!.trigger();
    expect(chatStream).not.toHaveBeenCalled();
    expect($('bots-empty')).not.toBeNull();
    expect(await stored()).toBeNull();
  });

  it('shows a failed turn inline, once; Resume tries that bot again', async () => {
    let fail = true;
    const { bodies, chatStream: ok } = fakeStream();
    const chatStream = vi.fn((body: ChatRequest, opts: StreamOptions) =>
      fail && bodies.length === 1
        ? Promise.reject(new ApiError('Rate limited upstream.', 429))
        : ok(body, opts),
    );
    const tool = await mount({ chatStream });
    configure(tool, { turnLimit: 3 });
    await t!.runners[0]!.trigger();
    await vi.waitFor(() => expect($('turn-error')?.textContent).toContain('Rate limited'));
    expect($$('error-toast')).toHaveLength(0);
    expect(t!.status()).toContain('Bot B’s turn failed'.replace('’', "'"));
    expect($('bots-state').textContent).toBe('Paused');
    expect((await runs())[0]?.status).toBe('error');

    fail = false;
    await t!.runners[0]!.trigger();
    await vi.waitFor(() => expect($('conversation-end').dataset['reason']).toBe('turns'));
    expect($$('turn-error')).toHaveLength(0);
    expect(turns().map((el) => el.dataset['speaker'])).toEqual(['a', 'b', 'a']);
  });
});

describe('moderation', () => {
  it('Pause holds after the turn in flight; Step runs one turn; Resume goes on', async () => {
    const { bodies, chatStream, release } = heldStream();
    const tool = await mount({ chatStream });
    configure(tool, { turnLimit: 4 });
    const started = t!.runners[0]!.trigger();
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    $('bots-pause').click();
    expect($('bots-pause').textContent).toContain('Pausing…');
    expect($('bots-pause').getAttribute('aria-disabled')).toBe('true');
    await release();
    await started;
    expect(bodies).toHaveLength(1);
    expect($('bots-state').textContent).toBe('Paused');
    expect($$('conversation-end')).toHaveLength(0);
    expect(t!.status()).toBe('Paused after Bot A’s turn.');

    const stepped = t!.runners[0]!.trigger('step');
    await release();
    await stepped;
    expect(bodies.map(speakerOf)).toEqual(['Bot A', 'Bot B']);
    expect(t!.status()).toBe('Bot B spoke. Resume or Step to go on.');

    const resumed = t!.runners[0]!.trigger();
    await release();
    await release();
    await resumed;
    expect(bodies).toHaveLength(4);
    expect($('conversation-end').dataset['reason']).toBe('turns');
    // One run per press, all of one conversation.
    const all = await runs();
    expect(all.map((run) => run.title)).toEqual(
      expect.arrayContaining(['Is zero even?', 'Step: Is zero even?', 'Resumed: Is zero even?']),
    );
    expect(new Set(all.map((run) => run.groupId)).size).toBe(1);
  });

  it('a moderator message reaches both bots, marked', async () => {
    const { bodies, chatStream } = fakeStream();
    const tool = await mount({ chatStream });
    configure(tool, {});
    await t!.runners[0]!.trigger('step');
    const input = $<HTMLTextAreaElement>('moderator-input');
    input.value = 'Use an example.';
    $('moderator-send').click();
    expect($$('moderator-message').map((el) => el.dataset['kind'])).toEqual([
      'opener',
      'moderator',
    ]);
    expect(input.value).toBe('');

    await t!.runners[0]!.trigger('step');
    await t!.runners[0]!.trigger('step');
    expect(bodies[1]?.messages.at(-1)).toEqual({
      role: 'user',
      content: '[Moderator] Is zero even?\n\n[Bot A] Bot A says 1\n\n[Moderator] Use an example.',
    });
    expect(bodies[2]?.messages.slice(-2)).toEqual([
      { role: 'assistant', content: 'Bot A says 1' },
      { role: 'user', content: '[Moderator] Use an example.\n\n[Bot B] Bot B says 2' },
    ]);
  });

  it('edits a turn and resumes from there; Undo brings the rest back until it goes on', async () => {
    const { bodies, chatStream } = fakeStream();
    const tool = await mount({ chatStream });
    configure(tool, { turnLimit: 3 });
    await t!.runners[0]!.trigger();
    await vi.waitFor(() => expect(turns()).toHaveLength(3));

    // Edit Bot A's first turn: what came after goes, with Undo.
    $$('turn-edit', turns()[0])[0]!.click();
    const editor = $<HTMLTextAreaElement>('edit-input');
    expect(document.activeElement).toBe(editor);
    editor.value = 'Zero is even: it is 2 × 0.';
    editor.dispatchEvent(new Event('input'));
    $('edit-save').click();
    await vi.waitFor(() => expect(turnTexts()).toEqual(['Zero is even: it is 2 × 0.']));
    expect($$('conversation-end')).toHaveLength(0);
    expect($('turn-edited')).not.toBeNull();
    expect(document.activeElement).toBe($$('turn-edit', turns()[0])[0]);
    expect($('bots-edit-toast').textContent).toContain('3 messages after it removed');

    $('toast-undo').click();
    await vi.waitFor(() => expect(turns()).toHaveLength(3));
    expect(turnTexts()[0]).toBe('Bot A says 1');
    expect($('conversation-end')).not.toBeNull();

    // Edit again and go on from there: Bot B is next and sees the edited text.
    $$('turn-edit', turns()[0])[0]!.click();
    $<HTMLTextAreaElement>('edit-input').value = 'Edited opening turn.';
    $('edit-save').click();
    await t!.runners[0]!.trigger('step');
    expect(speakerOf(bodies.at(-1)!)).toBe('Bot B');
    expect(bodies.at(-1)?.messages.slice(1)).toEqual([
      { role: 'user', content: '[Moderator] Is zero even?\n\n[Bot A] Edited opening turn.' },
    ]);
    // The conversation went on: the second edit's Undo is refused.
    const undo = $$('toast-undo').at(-1)!;
    undo.click();
    await vi.waitFor(() => expect($('undo-refused')).not.toBeNull());
  });

  it('New conversation clears it, with Undo', async () => {
    const { chatStream } = fakeStream();
    const tool = await mount({ chatStream });
    configure(tool, {});
    await t!.runners[0]!.trigger('step');
    $('bots-new').click();
    expect($('bots-empty')).not.toBeNull();
    expect($('bots-primary').textContent).toContain('Start');
    await eventually(async () => expect(await stored()).toBeNull());
    $('toast-undo').click();
    await vi.waitFor(() => expect(turns()).toHaveLength(1));
    await eventually(async () => expect((await stored())?.entries).toHaveLength(2));
  });
});

describe('persistence', () => {
  it('comes back paused after a reload, with the opener and the totals', async () => {
    const { chatStream } = fakeStream();
    const tool = await mount({ chatStream });
    configure(tool, { turnLimit: 6 }, 'Plan a picnic.');
    await t!.runners[0]!.trigger('step');
    await t!.runners[0]!.trigger('step');
    await settle();
    t!.cleanup();
    document.body.replaceChildren();

    await mount({ chatStream });
    await vi.waitFor(() => expect(turnTexts()).toEqual(['Bot A says 1', 'Bot B says 2']));
    expect($('bots-state').textContent).toBe('Paused');
    expect($('bots-primary').textContent).toContain('Resume');
    expect($<HTMLTextAreaElement>('tool-prompt').value).toBe('Plan a picnic.');
    expect($('bots-turns').textContent).toBe('2 / 6');
  });

  it('keeps the text of a turn the page left streaming, as stopped', async () => {
    const conversation = createConversation({
      opener: 'Hi',
      first: 'a',
      bots: {
        a: { name: 'Bot A', model: 'a/cheap', persona: '' },
        b: { name: 'Bot B', model: 'a/cheap', persona: '' },
      },
    });
    conversation.entries.push({
      id: 'x',
      kind: 'bot',
      speaker: 'a',
      name: 'Bot A',
      model: 'a/cheap',
      content: 'Half a th',
      status: 'streaming',
      createdAt: 1,
    });
    await (
      await getDb()
    ).put('kv', {
      key: 'tool:bot-to-bot:conversation',
      value: JSON.parse(JSON.stringify(conversation)) as unknown,
      updatedAt: 1,
    });
    await mount();
    await vi.waitFor(() => expect(turns()[0]?.dataset['status']).toBe('stopped'));
    expect(turnTexts()).toEqual(['Half a th']);
  });

  it('follows a conversation another tab stored', async () => {
    await mount();
    const conversation = createConversation({
      opener: 'From the other tab',
      first: 'b',
      bots: {
        a: { name: 'Bot A', model: 'a/cheap', persona: '' },
        b: { name: 'Bot B', model: 'a/cheap', persona: '' },
      },
    });
    conversation.rev = 3;
    await t!.ctx.state.set('conversation', conversation);
    await vi.waitFor(() =>
      expect($$('moderator-message')[0]?.textContent).toContain('From the other tab'),
    );
    await t!.ctx.state.delete('conversation');
    await vi.waitFor(() => expect($('bots-empty')).not.toBeNull());
  });
});
