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
import type { ApiClient, CallOptions } from '../../core/types';
import { createToolTestContext, type ToolTestContext } from '../../ui/tool/testing';
import type { ToolInstance, ToolSnapshot } from '../../ui/tool/types';
import type * as tokens from '../../core/tokens';
import { approxTokens } from '../../core/tokens';
import type { BudgetQuestion } from '../../core/types';
import { getTool } from '../registry';
import { SAMPLE_PROMPT, setup } from './arena';
import { parseTally } from './tally';

// Counts token approximations (the shared input is counted once per refresh, not once per contender).
vi.mock('../../core/tokens', async (importOriginal) => {
  const actual = await importOriginal<typeof tokens>();
  return { ...actual, approxTokens: vi.fn(actual.approxTokens) };
});

const model = (id: string, price: string, input: string[], created: number): RawModel => ({
  id,
  name: `Name of ${id}`,
  created,
  context_length: 100_000,
  architecture: { input_modalities: input, output_modalities: ['text'] },
  pricing: { prompt: price, completion: price },
  top_provider: { context_length: 100_000, max_completion_tokens: 4000 },
  supported_parameters: ['max_tokens', 'temperature'],
});

const CATALOG = [
  model('alpha/one:free', '0', ['text', 'image'], 5),
  model('beta/two:free', '0', ['text'], 4),
  model('gamma/three:free', '0', ['text', 'image'], 3),
  model('delta/four', '0.000001', ['text', 'image'], 2),
  // About $0.09 a round (4,000 output tokens): under the $0.10 per-run threshold alone, over it four at once.
  model('eps/pricey', '0.0000225', ['text'], 1),
];
const FOUR = ['alpha/one:free', 'beta/two:free', 'gamma/three:free', 'delta/four'];

type StreamOptions = CallOptions & { onEvent: (event: ChatStreamEvent) => void };

const result = (body: ChatRequest, text: string): ChatStreamResult => ({
  id: `gen-${body.model}`,
  model: body.model,
  text,
  reasoning: '',
  images: [],
  audioChunks: [],
  audioTranscript: '',
  finishReason: 'stop',
  usage: null,
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A chatStream that answers `Answer from <model>` and reports usage like the client (the usage event, then the
 * run's usage). Like the client, it calls `onSend` right before the request goes out: after `waitMs` (the free-model
 * throttle or a retry's backoff). It records each body and how many requests were in flight at once; `hold` keeps
 * every request open until that many have arrived.
 */
function fakeStream(
  options: {
    hold?: number;
    waitMs?: number;
    fail?: (body: ChatRequest) => Error | null;
    finishReason?: string;
    reasoningTokens?: number;
  } = {},
) {
  const bodies: ChatRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const chatStream = vi.fn(async (body: ChatRequest, opts: StreamOptions) => {
    bodies.push(body);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (options.hold) {
      if (bodies.length >= options.hold) release();
      await gate;
    }
    if (options.waitMs) await sleep(options.waitMs);
    opts.onSend?.(1);
    try {
      const failure = options.fail?.(body);
      if (failure) throw failure;
      const text = `Answer from ${body.model}`;
      opts.onEvent({ type: 'text', text });
      opts.onEvent({
        type: 'usage',
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          ...(options.reasoningTokens
            ? { completion_tokens_details: { reasoning_tokens: options.reasoningTokens } }
            : {}),
        },
      });
      opts.run.addUsage({
        model: body.model,
        promptTokens: 10,
        completionTokens: 20,
        costUsd: body.model.endsWith(':free') ? 0 : 0.0005,
        costEstimated: false,
        latencyMs: 100,
      });
      return { ...result(body, text), finishReason: options.finishReason ?? 'stop' };
    } finally {
      inFlight--;
    }
  });
  return { bodies, chatStream, maxInFlight: () => maxInFlight };
}

/**
 * A chatStream that sends a first chunk, then waits until the run is stopped. Like the client, a stream cut
 * before its usage chunk still reports a request with zero tokens (`reportUnknown`).
 */
function heldStream() {
  return vi.fn(
    (body: ChatRequest, opts: StreamOptions) =>
      new Promise<ChatStreamResult>((_, reject) => {
        opts.onSend?.(1);
        opts.onEvent({ type: 'text', text: `Partial from ${body.model}` });
        opts.run.signal.addEventListener('abort', () => {
          opts.run.addUsage({
            model: body.model,
            promptTokens: 0,
            completionTokens: 0,
            costUsd: 0,
            costEstimated: false,
            latencyMs: 50,
          });
          reject(new DOMException('Stopped.', 'AbortError'));
        });
      }),
  );
}

/** Holds `ctx.models.estimate` (the planning step of a round or a Retry) until `release()`. */
function holdEstimates(context: ToolTestContext): { release: () => void } {
  const original = context.core.models.estimate.bind(context.core.models);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  vi.spyOn(context.core.models, 'estimate').mockImplementation(async (input) => {
    await gate;
    return original(input);
  });
  return { release };
}

let t: ToolTestContext | null = null;

beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
});

afterEach(async () => {
  if (t) {
    const runner = t.runners[0];
    await vi.waitFor(() => expect(runner?.busy ?? false).toBe(false), { timeout: 5000 });
    t.cleanup();
  }
  t = null;
  document.body.replaceChildren();
});

async function mount(
  api: Partial<ApiClient> = {},
  options: { modelOverride?: string } = {},
): Promise<{ tool: ToolInstance; t: ToolTestContext }> {
  t = createToolTestContext(getTool('model-arena'), {
    catalog: CATALOG,
    api,
    ...(options.modelOverride ? { modelOverride: options.modelOverride } : {}),
  });
  const tool = await t.mount(setup);
  return { tool, t };
}

const $$ = (testId: string, root: ParentNode = document): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];
const $ = (testId: string, root: ParentNode = document): HTMLElement => $$(testId, root)[0]!;
const prompt = (): HTMLTextAreaElement => $('tool-prompt') as HTMLTextAreaElement;
const panels = (): HTMLElement[] => $$('arena-panel');
/** Each panel's answer text, by panel letter. */
const answers = (): Record<string, string> =>
  Object.fromEntries(
    panels().map((panel): [string, string] => [
      panel.dataset['panel'] ?? '',
      $('panel-answer', panel).textContent?.trim() ?? '',
    ]),
  );
const settingsOf = (tool: ToolInstance) => tool.getState().settings as { models: string[] };

/** Fills the form: these contenders and this prompt (blind unless told otherwise). */
function form(tool: ToolInstance, models: string[], patch: Record<string, unknown> = {}): void {
  tool.applyState({
    prompt: 'Which is larger, 9.11 or 9.9?',
    settings: { ...tool.getState().settings, models, ...patch },
  });
}

describe('model arena', () => {
  it('starts with distinct free text models and round-trips its state exactly', async () => {
    const { tool } = await mount();
    expect(settingsOf(tool).models).toEqual(['alpha/one:free', 'beta/two:free']);
    expect($$('contender').map((row) => $('contender-name', row).textContent)).toEqual([
      'Name of alpha/one:free',
      'Name of beta/two:free',
    ]);

    const state: ToolSnapshot = {
      prompt: 'Summarise the attached report',
      settings: {
        models: ['delta/four', 'gamma/three:free', 'alpha/one:free'],
        system: 'You are terse.',
        temperature: 0.4,
        maxTokens: 600,
        blind: false,
        pdfEngine: 'mistral-ocr',
      },
    };
    tool.applyState(state);
    expect(tool.getState()).toEqual(state);
    tool.applyState(tool.getState());
    expect(tool.getState()).toEqual(state);
    expect($$('contender')).toHaveLength(3);
    expect(($('arena-blind') as HTMLInputElement).checked).toBe(false);
    expect(($('arena-temperature') as HTMLInputElement).value).toBe('0.4');
    expect(($('arena-max-tokens') as HTMLInputElement).value).toBe('600');

    // Unknown keys and invalid values leave the form as it is; the form is kept for the next visit.
    tool.applyState({ prompt: 'x', settings: { models: ['only/one'], temperature: 9, other: 1 } });
    expect(tool.getState().settings).toEqual(state.settings);
    expect(t!.ctx.options.get()['models']).toEqual(state.settings['models']);
  });

  it('estimates the sum over the contenders, and a paid PDF reader once per contender', async () => {
    const { tool } = await mount();
    form(tool, ['delta/four', 'alpha/one:free']);
    const one = await t!.ctx.ui.refreshEstimate();
    expect(one).toBeGreaterThan(0);
    form(tool, ['delta/four', 'delta/four', 'alpha/one:free']);
    expect(await t!.ctx.ui.refreshEstimate()).toBeCloseTo(one! * 2);
    // Max tokens is what the estimate assumes for the answer.
    form(tool, ['delta/four', 'alpha/one:free'], { maxTokens: 100 });
    expect(await t!.ctx.ui.refreshEstimate()).toBeLessThan(one!);

    form(tool, ['alpha/one:free', 'gamma/three:free'], { pdfEngine: 'mistral-ocr' });
    expect(tool.addons?.()).toEqual([]);
    tool.onFiles?.([new File(['%PDF-1.4 /Type /Page'], 'a.pdf', { type: 'application/pdf' })]);
    await vi.waitFor(() => expect($$('arena-file-chip')).toHaveLength(1));
    const addons = tool.addons?.() ?? [];
    expect(addons).toHaveLength(2);
    expect(addons[0]?.id).toBe('pdf-engine:mistral-ocr');
  });

  it('runs every contender at once, one run each in one group, and votes blind', async () => {
    const fake = fakeStream({ hold: 4 });
    const { tool } = await mount({ chatStream: fake.chatStream });
    form(tool, FOUR, { system: 'Be brief.', temperature: 0.2 });
    await t!.runners[0]!.trigger();

    // All four were in flight together (each waited until the fourth had arrived).
    expect(fake.maxInFlight()).toBe(4);
    expect(fake.bodies.map((body) => body.model).sort()).toEqual([...FOUR].sort());
    for (const body of fake.bodies) {
      expect(body).toEqual({
        model: body.model,
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Which is larger, 9.11 or 9.9?' },
        ],
        temperature: 0.2,
      });
    }
    const runs = await t!.core.history.query({ tool: 'model-arena' });
    expect(runs).toHaveLength(4);
    expect(new Set(runs.map((run) => run.groupId)).size).toBe(1);
    expect(runs.every((run) => run.status === 'ok')).toBe(true);
    // Each run's output is its answer; its settings restore the whole round.
    for (const run of runs) {
      expect(run.output).toBe(`Answer from ${run.model}`);
      expect(run.settings).toEqual(tool.getState().settings);
      // History must not map a blind panel to its model before the vote.
      expect(run.meta).not.toHaveProperty('panel');
    }

    // Blind: panels are Model A–D, with no names and no costs until the vote.
    expect(panels().map((panel) => $('panel-title', panel).textContent)).toEqual([
      'Model A',
      'Model B',
      'Model C',
      'Model D',
    ]);
    // (The contender list on the left names the models; the output never says which panel is which.)
    expect(t!.zones.output.textContent).not.toContain('Name of');
    expect($$('metric-cost').map((cell) => cell.textContent)).toEqual([
      'Hidden',
      'Hidden',
      'Hidden',
      'Hidden',
    ]);
    expect($$('badge-cheapest')).toHaveLength(0);
    expect(($('arena-export') as HTMLButtonElement).disabled).toBe(true);
    expect(t!.status()).toBe(
      'Round complete: 4 of 4 answered. Vote for the best answer to see the names.',
    );

    // Vote for Model C: names show, the tally counts a win for its model and a round for each.
    const pickC = $$('vote-panel').find((button) => button.textContent === 'Model C')!;
    const winner = answers()['C']!.replace('Answer from ', '');
    pickC.click();
    expect($('vote-result').textContent).toContain(`You picked Model C: Name of ${winner}.`);
    expect($('panel-model', panels()[2]).textContent).toBe(`Name of ${winner}`);
    expect(
      $$('metric-cost')
        .map((cell) => cell.textContent)
        .sort(),
    ).toEqual(['$0.0005', 'Free', 'Free', 'Free']);
    await vi.waitFor(async () => {
      const stored = parseTally(await t!.ctx.state.get('tally'));
      expect(stored.models[winner]).toEqual({ rounds: 1, wins: 1, ties: 0, bad: 0 });
      expect(Object.keys(stored.models)).toHaveLength(4);
    });
    expect($$('tally-row')).toHaveLength(4);
    expect($('tally-row').textContent).toContain(`Name of ${winner}`);
  });

  it('shows names and metrics at once with blind voting off, and reveals without a vote', async () => {
    const fake = fakeStream();
    const { tool } = await mount({ chatStream: fake.chatStream });
    form(tool, ['alpha/one:free', 'delta/four'], { blind: false });
    await t!.runners[0]!.trigger();
    expect(panels().map((panel) => $('panel-model', panel).textContent)).toEqual([
      'Name of alpha/one:free',
      'Name of delta/four',
    ]);
    expect($$('metric-cost').map((cell) => cell.textContent)).toEqual(['Free', '$0.0005']);
    expect($$('vote-reveal')).toHaveLength(0);

    form(tool, ['alpha/one:free', 'delta/four'], { blind: true });
    await t!.runners[0]!.trigger();
    $('vote-reveal').click();
    expect($('vote-result').textContent).toContain('without a vote');
    expect(
      panels()
        .map((panel) => $('panel-model', panel).textContent)
        .sort(),
    ).toEqual(['Name of alpha/one:free', 'Name of delta/four']);
    expect(parseTally(await t!.ctx.state.get('tally')).models).toEqual({});
  });

  it('keeps the others going when one contender fails; its Retry runs it alone', async () => {
    let failing = true;
    const fake = fakeStream({
      fail: (body) =>
        failing && body.model === 'beta/two:free'
          ? new ApiError('beta/two:free is overloaded.', 400)
          : null,
    });
    const { tool } = await mount({ chatStream: fake.chatStream });
    form(tool, ['alpha/one:free', 'beta/two:free', 'gamma/three:free']);
    await t!.runners[0]!.trigger();

    const errors = $$('panel-error');
    expect(errors).toHaveLength(1);
    // Blind: the error says nothing OpenRouter's message said about the model.
    expect(errors[0]!.textContent).toContain('OpenRouter could not process this request.');
    expect(errors[0]!.textContent).not.toContain('beta/two');
    expect(Object.values(answers()).filter((text) => text?.startsWith('Answer from'))).toHaveLength(
      2,
    );
    expect(t!.status()).toBe(
      'Round complete: 2 of 3 answered, 1 failed. Vote for the best answer to see the names.',
    );
    const runs = await t!.core.history.query({ tool: 'model-arena' });
    expect(runs.map((run) => run.status).sort()).toEqual(['error', 'ok', 'ok']);

    failing = false;
    const retry = $('panel-retry');
    retry.click();
    await vi.waitFor(() => expect($$('panel-error')).toHaveLength(0));
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));
    expect(fake.bodies.map((body) => body.model)).toHaveLength(4);
    expect(fake.bodies[3]?.model).toBe('beta/two:free');
    expect(Object.values(answers())).toContain('Answer from beta/two:free');
    const after = await t!.core.history.query({ tool: 'model-arena' });
    expect(after).toHaveLength(4);
    expect(new Set(after.map((run) => run.groupId)).size).toBe(1);
  });

  it('Stop stops every contender and keeps what arrived', async () => {
    const chatStream = heldStream();
    const { tool } = await mount({ chatStream });
    form(tool, ['alpha/one:free', 'gamma/three:free']);
    const running = t!.runners[0]!.trigger();
    await vi.waitFor(() => expect(chatStream).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(Object.values(answers()).every((text) => text?.startsWith('Partial'))).toBe(true),
    );
    t!.runners[0]!.stop();
    await running;
    expect($$('panel-status').map((badge) => badge.textContent)).toEqual(['Stopped', 'Stopped']);
    expect(Object.values(answers()).every((text) => text?.startsWith('Partial from'))).toBe(true);
    // No usage arrived: the token count is unknown, not 0.
    expect($$('metric-tokens').map((cell) => cell.textContent)).toEqual(['—', '—']);
    expect($$('metric-rate').map((cell) => cell.textContent)).toEqual(['—', '—']);
    expect($$('panel-error')).toHaveLength(0);
    expect(t!.status()).toBe('Stopped. Partial answers are kept.');
    const runs = await t!.core.history.query({ tool: 'model-arena' });
    expect(runs.map((run) => run.status)).toEqual(['aborted', 'aborted']);
  });

  it('refuses a round before anything starts: free-only, unreadable files, nothing to ask', async () => {
    const fake = fakeStream();
    const { tool } = await mount({ chatStream: fake.chatStream });
    form(tool, ['alpha/one:free', 'delta/four']);
    t!.core.settings.update((draft) => {
      draft.freeOnly = true;
    });
    expect($$('contender-warning').map((el) => el.textContent)).toEqual([
      'Not free, and free-only mode is on',
    ]);
    await t!.runners[0]!.trigger();
    expect(fake.chatStream).not.toHaveBeenCalled();
    expect(await t!.core.history.query({ tool: 'model-arena' })).toEqual([]);
    expect($$('arena-panel')).toHaveLength(0);

    t!.core.settings.update((draft) => {
      draft.freeOnly = false;
    });
    form(tool, ['alpha/one:free', 'beta/two:free']);
    tool.onFiles?.([new File([new Uint8Array([1, 2, 3])], 'red.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect($$('arena-file-chip')).toHaveLength(1));
    expect($$('contender-warning').map((el) => el.textContent)).toEqual([
      "This model can't read images",
    ]);
    await t!.runners[0]!.trigger();
    expect(fake.chatStream).not.toHaveBeenCalled();

    // With models that read images, the picture goes to each of them as an image part.
    form(tool, ['alpha/one:free', 'gamma/three:free']);
    await t!.runners[0]!.trigger();
    expect(fake.bodies).toHaveLength(2);
    for (const body of fake.bodies) {
      const parts = body.messages[0]?.content as { type: string; image_url?: { url: string } }[];
      expect(parts.map((part) => part.type)).toEqual(['text', 'image_url']);
      expect(parts[1]?.image_url?.url).toMatch(/^data:image\/png;base64,/);
    }

    $('arena-file-remove').click();
    tool.applyState({ prompt: '  ', settings: tool.getState().settings });
    await t!.runners[0]!.trigger();
    expect(fake.bodies).toHaveLength(2);
    expect(t!.status()).toBe('Write a prompt or attach a file first.');
  });

  it('resets the tally with Undo, keeping votes cast since', async () => {
    const fake = fakeStream();
    const { tool } = await mount({ chatStream: fake.chatStream });
    form(tool, ['alpha/one:free', 'gamma/three:free'], { blind: false });
    await t!.runners[0]!.trigger();
    $('vote-tie').click();
    await vi.waitFor(() => expect($$('tally-row')).toHaveLength(2));

    expect($('tally-empty').hidden).toBe(true);
    $('tally-reset').click();
    await vi.waitFor(() => expect($('tally-empty').hidden).toBe(false));
    expect(parseTally(await t!.ctx.state.get('tally')).models).toEqual({});

    await t!.runners[0]!.trigger();
    $$('vote-panel')[0]!.click();
    await vi.waitFor(() => expect($$('tally-row')).toHaveLength(2));
    $('toast-undo').click();
    await vi.waitFor(async () => {
      const stored = parseTally(await t!.ctx.state.get('tally'));
      expect(stored.models['alpha/one:free']).toEqual({ rounds: 2, wins: 1, ties: 1, bad: 0 });
      expect(stored.models['gamma/three:free']).toEqual({ rounds: 2, wins: 0, ties: 1, bad: 0 });
    });
  });

  it('fills a sample prompt', async () => {
    const { tool } = await mount();
    await tool.sample?.();
    expect(prompt().value).toBe(SAMPLE_PROMPT);
  });
});

describe('review fixes', () => {
  it('blind errors read the same for every model; the real wording shows after the reveal', async () => {
    const unknown = new ApiError('Upstream error from eps/pricey.', 502);
    unknown.outcomeUnknown = true; // a paid request that may have gone through
    const fake = fakeStream({
      fail: (body) =>
        body.model === 'eps/pricey'
          ? unknown
          : body.model === 'delta/four'
            ? new ApiError('Insufficient credits for delta/four.', 402) // a paid model's failure
            : body.model === 'beta/two:free'
              ? new ApiError('BETA/TWO free tier is busy.', 429) // a free model's failure
              : null,
    });
    const { tool } = await mount({ chatStream: fake.chatStream });
    form(tool, ['alpha/one:free', 'beta/two:free', 'delta/four', 'eps/pricey']);
    await t!.runners[0]!.trigger();

    const failed = panels().filter((panel) => $$('panel-error', panel).length > 0);
    expect(failed).toHaveLength(3);
    const texts = failed.map((panel) => $('panel-error', panel).textContent ?? '');
    expect(texts.sort()).toEqual(
      [
        'OpenRouter did not accept this request.',
        'Rate limited. Wait a moment, then try again.',
        'The request did not finish.',
      ]
        .map(
          (text) =>
            `${text} Before retrying, you can check your OpenRouter activity to see whether this request was billed.OpenRouter activity (opens in a new tab)Retry`,
        )
        .sort(),
    );
    for (const panel of failed) {
      expect(panel.querySelector('a[href="https://openrouter.ai/activity"]')).not.toBeNull();
      expect($$('panel-retry', panel)).toHaveLength(1); // a Retry that went missing would give it away
    }

    // Once the names show: the real messages; the request that may have gone through gets no plain Retry.
    $('vote-reveal').click();
    const revealed = panels().filter((panel) => $$('panel-error', panel).length > 0);
    const byText = (part: string) =>
      revealed.find((panel) => $('panel-error', panel).textContent?.includes(part));
    const maybeBilled = byText('may still have done the work')!;
    expect(maybeBilled.querySelector('a[href="https://openrouter.ai/activity"]')).not.toBeNull();
    expect($$('panel-retry', maybeBilled)).toHaveLength(0);
    const credits = byText('Not enough credits')!;
    expect(credits.querySelector('a[href="https://openrouter.ai/activity"]')).toBeNull();
    expect($$('panel-retry', credits)).toHaveLength(1);
  });

  it('asks one budget question for the round’s total, and sends nothing when it is declined', async () => {
    const fake = fakeStream();
    const { tool } = await mount({ chatStream: fake.chatStream });
    const questions: BudgetQuestion[] = [];
    let answer = false;
    t!.core.runs.setConfirmHandler((_check, question) => {
      questions.push(question);
      return Promise.resolve(answer);
    });
    // Four contenders of about $0.09 each: each under the $0.10 per-run threshold, the round well over it.
    form(tool, ['eps/pricey', 'eps/pricey', 'eps/pricey', 'eps/pricey']);
    const each = await t!.ctx.models.estimate({
      kind: 'tokens',
      model: 'eps/pricey',
      promptTokens: 20,
      completionTokens: 4000,
    });
    expect(each).toBeLessThan(0.1);

    await t!.runners[0]!.trigger();
    expect(questions).toHaveLength(1);
    const question = questions[0]!;
    expect(question.kind).toBe('group');
    if (question.kind !== 'group') return;
    expect(question.group.label).toBe('Model arena round: 4 models');
    expect(question.group.runs).toBe(4);
    expect(question.group.estimateUsd).toBeGreaterThan(0.3); // the total, not one contender's share
    // Declined: nothing was sent or recorded for any contender, and the page says so.
    expect(fake.chatStream).not.toHaveBeenCalled();
    expect(await t!.core.history.query({ tool: 'model-arena' })).toEqual([]);
    expect(panels()).toHaveLength(0);
    expect(t!.status()).toBe('The round did not start: nothing was sent.');

    answer = true;
    await t!.runners[0]!.trigger();
    expect(questions).toHaveLength(2);
    expect(fake.chatStream).toHaveBeenCalledTimes(4);
    expect(await t!.core.history.query({ tool: 'model-arena' })).toHaveLength(4);
  });

  it('times first token and total from when the request is sent, not from the free-model wait', async () => {
    const fake = fakeStream({ waitMs: 300 });
    const { tool } = await mount({ chatStream: fake.chatStream });
    form(tool, ['alpha/one:free', 'gamma/three:free'], { blind: false });
    await t!.runners[0]!.trigger();
    const ms = (text: string | null): number => Number(/(\d+) ms/.exec(text ?? '')?.[1] ?? NaN);
    for (const cell of [...$$('metric-ttft'), ...$$('metric-total')]) {
      expect(ms(cell.textContent)).toBeLessThan(250);
    }
  });

  it('closes voting while a contender runs again, from Retry until it settles', async () => {
    let failing = true;
    const fake = fakeStream({
      fail: (body) =>
        failing && body.model === 'beta/two:free' ? new ApiError('Busy.', 400) : null,
    });
    const { tool } = await mount({ chatStream: fake.chatStream });
    form(tool, ['alpha/one:free', 'beta/two:free'], { blind: false });
    await t!.runners[0]!.trigger();
    expect($('vote-tie').getAttribute('aria-disabled')).toBe('false');

    failing = false;
    const held = holdEstimates(t!); // the Retry is being planned
    $('panel-retry').click();
    await vi.waitFor(() => expect($('vote-tie').getAttribute('aria-disabled')).toBe('true'));
    expect($('vote-hint').textContent).toBe('Voting opens when every answer is in.');
    $('vote-tie').click();
    expect($$('vote-result')).toHaveLength(0);
    expect(($('arena-export') as HTMLButtonElement).disabled).toBe(true);

    held.release();
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));
    expect($('vote-tie').getAttribute('aria-disabled')).toBe('false');
    $('vote-tie').click();
    expect($('vote-result').textContent).toBe('You called it a tie.');
  });

  it('marks no Cheapest (or Fastest) when every answer ties', async () => {
    const fake = fakeStream();
    const { tool } = await mount({ chatStream: fake.chatStream });
    form(tool, ['alpha/one:free', 'gamma/three:free'], { blind: false });
    await t!.runners[0]!.trigger();
    expect($$('metric-cost').map((cell) => cell.textContent)).toEqual(['Free', 'Free']);
    expect($$('badge-cheapest')).toHaveLength(0);
  });

  it('marks an answer cut off at the length limit', async () => {
    const fake = fakeStream({ finishReason: 'length' });
    const { tool } = await mount({ chatStream: fake.chatStream });
    form(tool, ['alpha/one:free', 'gamma/three:free']);
    await t!.runners[0]!.trigger();
    expect($$('panel-cutoff').map((el) => el.textContent)).toEqual([
      'Cut off at the length limit.',
      'Cut off at the length limit.',
    ]);
  });

  it('offers Export only once every answer is in, also with blind voting off', async () => {
    const chatStream = heldStream();
    const { tool } = await mount({ chatStream });
    form(tool, ['alpha/one:free', 'gamma/three:free'], { blind: false });
    const running = t!.runners[0]!.trigger();
    await vi.waitFor(() => expect(chatStream).toHaveBeenCalledTimes(2));
    expect(($('arena-export') as HTMLButtonElement).disabled).toBe(true);
    t!.runners[0]!.stop();
    await running;
    expect(($('arena-export') as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends Max tokens from Settings', async () => {
    const fake = fakeStream();
    const { tool } = await mount({ chatStream: fake.chatStream });
    form(tool, ['alpha/one:free', 'gamma/three:free']);
    const field = $('arena-max-tokens') as HTMLInputElement;
    field.value = '250';
    field.dispatchEvent(new Event('change'));
    expect(tool.getState().settings['maxTokens']).toBe(250);
    await t!.runners[0]!.trigger();
    expect(fake.bodies.map((body) => body.max_tokens)).toEqual([250, 250]);
    field.value = '';
    field.dispatchEvent(new Event('change'));
    expect(tool.getState().settings['maxTokens']).toBeNull();
  });

  it('takes the round’s input when Compare is pressed, not after the planning and the budget dialog', async () => {
    let failing = true;
    const fake = fakeStream({
      fail: (body) =>
        failing && body.model === 'beta/two:free' ? new ApiError('Busy.', 400) : null,
    });
    const { tool } = await mount({ chatStream: fake.chatStream });
    form(tool, ['alpha/one:free', 'beta/two:free'], { blind: false });
    const held = holdEstimates(t!);
    const running = t!.runners[0]!.trigger();
    // While the round is planned: the system prompt changes and a file arrives.
    const system = $('arena-system') as HTMLTextAreaElement;
    system.value = 'Changed later';
    system.dispatchEvent(new Event('input'));
    tool.onFiles?.([new File(['late'], 'late.txt', { type: 'text/plain' })]);
    await vi.waitFor(() => expect($$('arena-file-chip')).toHaveLength(1));
    held.release();
    await running;

    const runs = await t!.core.history.query({ tool: 'model-arena' });
    expect(runs.map((run) => run.settings?.['system'])).toEqual(['', '']);
    // The Retry repeats the round as it was sent: no late system prompt, no late file.
    failing = false;
    $('panel-retry').click();
    await vi.waitFor(() => expect($$('panel-error')).toHaveLength(0));
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));
    expect(fake.bodies.at(-1)).toEqual({
      model: 'beta/two:free',
      messages: [{ role: 'user', content: 'Which is larger, 9.11 or 9.9?' }],
    });
  });

  it('keeps focus on the comparison and tally tables while they update', async () => {
    const fake = fakeStream();
    const { tool } = await mount({ chatStream: fake.chatStream });
    form(tool, ['alpha/one:free', 'gamma/three:free'], { blind: false });
    await t!.runners[0]!.trigger();
    const compare = $('compare-table').closest<HTMLElement>('[role="region"]')!;
    compare.focus();
    $('vote-tie').click(); // redraws the round
    expect(document.activeElement).toBe(compare);

    await vi.waitFor(() => expect($$('tally-row')).toHaveLength(2));
    const tallyRegion = $('tally-table').closest<HTMLElement>('[role="region"]')!;
    tallyRegion.focus();
    await t!.runners[0]!.trigger();
    $$('vote-panel')[0]!.click();
    await vi.waitFor(() => expect($('tally-row').textContent).toContain('1'));
    await vi.waitFor(async () =>
      expect(parseTally(await t!.ctx.state.get('tally')).models['alpha/one:free']?.rounds).toBe(2),
    );
    expect(document.activeElement).toBe(tallyRegion);
  });

  it('counts the shared input once per refresh, however many contenders there are', async () => {
    const { tool } = await mount();
    const calls = async (models: string[]): Promise<number> => {
      vi.mocked(approxTokens).mockClear();
      form(tool, models, { system: 'Be brief.' });
      await t!.ctx.ui.refreshEstimate();
      return vi.mocked(approxTokens).mock.calls.length;
    };
    expect(await calls(FOUR)).toBe(await calls(FOUR.slice(0, 2)));
  });

  it('keeps a ?model= contender for the next visit, as any other form change', async () => {
    await mount({}, { modelOverride: 'delta/four' });
    expect(t!.ctx.options.get()['models']).toEqual(['delta/four', 'beta/two:free']);
  });
});

describe('re-run with another model (?model=)', () => {
  it('replaces the contender whose run was opened from History', async () => {
    // A round run earlier: its runs carry the whole round in their settings.
    const fake = fakeStream();
    const first = await mount({ chatStream: fake.chatStream });
    form(first.tool, ['alpha/one:free', 'beta/two:free', 'gamma/three:free']);
    await first.t.runners[0]!.trigger();
    const runs = await first.t.core.history.query({ tool: 'model-arena' });
    const opened = runs.find((run) => run.model === 'beta/two:free')!;
    first.t.cleanup();
    t = null;
    document.body.replaceChildren();

    history.replaceState(null, '', `?run=${opened.id}&model=delta/four`);
    try {
      const { tool } = await mount({}, { modelOverride: 'delta/four' });
      tool.applyState({ prompt: opened.prompt ?? '', settings: opened.settings ?? {} });
      expect(settingsOf(tool).models).toEqual(['alpha/one:free', 'delta/four', 'gamma/three:free']);
      await vi.waitFor(() =>
        expect($('arena-override-note').textContent).toContain('Contender 2 is Name of delta/four'),
      );
      // Later restores (Prompts) are exact again.
      const state = { prompt: 'Again', settings: { ...tool.getState().settings, models: FOUR } };
      tool.applyState(state);
      expect(tool.getState()).toEqual(state);
    } finally {
      history.replaceState(null, '', '/');
    }
  });

  it('replaces contender 1 when no round of this tool is reopened', async () => {
    const { tool } = await mount({}, { modelOverride: 'delta/four' });
    expect(settingsOf(tool).models).toEqual(['delta/four', 'beta/two:free']);
  });
});
