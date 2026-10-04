/**
 * Bot-to-bot chat against the mocked OpenRouter: every stop condition (turn limit, time limit, cost cap, stop
 * phrase, Stop), the moderation (Pause, Step, Resume, a moderator message, edit and resume), a failed turn, the
 * exports, the prompts round trip, 320 px with the keyboard, and axe in light and dark.
 *
 * The mock answers each turn from the request: the speaker is read from its framing ("You are Bot A, …"). It
 * serves an SSE body in one piece, so the specs that need a turn still streaming (the time limit, Stop) hold the
 * stream open from inside the page with a `fetch` wrapper that sends the first event and waits for the abort; no
 * request leaves the page.
 */
import { readFileSync } from 'node:fs';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, type RecordedCall, sseResponse, test } from '../mock/index.ts';
import { seedApp, tabTo } from './app.ts';
import { expectNoSeriousA11yViolations, watchForProblems } from './support.ts';

const CHAT = '/api/v1/chat/completions';
const PAGE = 'tools/bot-to-bot/';

/** A streamed turn: one content chunk, the finish chunk and the usage chunk (docs §2.3). */
function reply(text: string, cost = 0.00042): unknown[] {
  const base = {
    id: 'gen-e2e',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test/text-model',
  };
  return [
    {
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    },
    { ...base, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }] },
    {
      ...base,
      choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48, cost },
    },
  ];
}

type Message = { role: string; content: string };
const messagesOf = (call: RecordedCall | undefined): Message[] =>
  ((call?.body ?? {}) as { messages?: Message[] }).messages ?? [];
/** The bot a request is for, from its framing. */
const speakerOf = (call: RecordedCall | undefined): string =>
  /You are (.+?), in a conversation/.exec(messagesOf(call)[0]?.content ?? '')?.[1] ?? '?';

/** Answers every turn with "<speaker> says <n>" (or what `text` returns), each costing `cost`. */
function answerTurns(
  mock: { respond: (method: 'POST', path: string, fn: (call: RecordedCall) => object) => unknown },
  options: { cost?: number; text?: (speaker: string, n: number) => string; delayMs?: number } = {},
): void {
  let n = 0;
  mock.respond('POST', CHAT, (call) => {
    n += 1;
    const speaker = speakerOf(call);
    return sseResponse(reply(options.text?.(speaker, n) ?? `${speaker} says ${n}`, options.cost), {
      ...(options.delayMs ? { delayMs: options.delayMs } : {}),
    });
  });
}

/** Holds every chat stream open after its first event until the request is aborted. */
async function holdStreams(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith('/api/v1/chat/completions')) return original(input, init);
      const encoder = new TextEncoder();
      const chunk = {
        id: 'gen-held',
        model: 'test/text-model',
        choices: [
          { index: 0, delta: { content: 'The first half of a thought' }, finish_reason: null },
        ],
      };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          init?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('The operation was aborted.', 'AbortError')),
          );
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    };
  });
}

const turns = (page: Page) => page.getByTestId('bot-turn');
const turnText = (page: Page, index: number) => turns(page).nth(index).getByTestId('turn-content');
const end = (page: Page) => page.getByTestId('conversation-end');
const status = (page: Page) => page.getByTestId('tool-status');

/** Opens the tool once the catalog is in (the bots' model chips show its names). */
async function open(page: Page): Promise<void> {
  await page.goto(PAGE);
  await expect(page.getByTestId('bot-a-model')).toContainText('Test: Text Model');
  // Each bot has its own model picker: no header chip.
  await expect(page.getByTestId('model-chip')).toHaveCount(0);
}

async function setLimits(
  page: Page,
  limits: { turns?: number; minutes?: number; cap?: number; phrase?: string },
): Promise<void> {
  if (limits.turns !== undefined)
    await page.getByTestId('bots-turn-limit').fill(String(limits.turns));
  if (limits.minutes !== undefined)
    await page.getByTestId('bots-time-limit').fill(String(limits.minutes));
  if (limits.cap !== undefined) await page.getByTestId('bots-cost-cap').fill(String(limits.cap));
  if (limits.phrase !== undefined) await page.getByTestId('bots-stop-phrase').fill(limits.phrase);
  await page.getByTestId('tool-prompt').click(); // `change` fires on blur
}

async function start(page: Page, opener = 'Is zero an even number?'): Promise<void> {
  await page.getByTestId('tool-prompt').fill(opener);
  await page.getByTestId('bots-primary').click();
}

test.beforeEach(async ({ context }) => {
  await seedApp(context, {
    key: true,
    settings: { tools: { 'bot-to-bot': { model: 'test/text-model' } } },
  });
});

test('runs to the turn limit: alternating bubbles, roles per speaker, totals and History', async ({
  page,
  mock,
}) => {
  // The API client cancels a stream once it has read `[DONE]`; Chromium may report that as aborted.
  const problems = await watchForProblems(page, { allowAborted: [CHAT] });
  answerTurns(mock);
  await open(page);
  await setLimits(page, { turns: 3 });
  await start(page);

  await expect(end(page)).toHaveAttribute('data-reason', 'turns');
  await expect(turns(page)).toHaveCount(3);
  await expect(turnText(page, 0)).toHaveText('Bot A says 1');
  await expect(turnText(page, 1)).toHaveText('Bot B says 2');
  expect(
    await turns(page).evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset['speaker'])),
  ).toEqual(['a', 'b', 'a']);
  await expect(end(page)).toContainText('Turn limit reached (3 turns).');
  await expect(status(page)).toHaveText('Ended. Turn limit reached (3 turns).');
  await expect(page.getByTestId('bots-state')).toHaveText('Ended · Turn limit');
  await expect(page.getByTestId('bots-turns')).toHaveText('3 / 3');
  await expect(page.getByTestId('turn-usage').first()).toContainText('40 in · 8 out · $0.00042');
  // A labelled region, not a live region.
  await expect(page.getByTestId('bots-log')).toHaveAttribute('role', 'region');
  await expect(page.getByTestId('bots-log')).not.toHaveAttribute('aria-live', /.*/);

  const calls = mock.calls(CHAT, 'POST');
  expect(calls.map(speakerOf)).toEqual(['Bot A', 'Bot B', 'Bot A']);
  expect(messagesOf(calls[1]).slice(1)).toEqual([
    { role: 'user', content: '[Moderator] Is zero an even number?\n\n[Bot A] Bot A says 1' },
  ]);
  expect(messagesOf(calls[2]).slice(1)).toEqual([
    { role: 'user', content: '[Moderator] Is zero an even number?' },
    { role: 'assistant', content: 'Bot A says 1' },
    { role: 'user', content: 'Bot B says 2' },
  ]);
  expect((calls[0]?.body as { stream?: boolean }).stream).toBe(true);

  // History replays the conversation.
  await page.goto('history/?tool=bot-to-bot');
  const row = page.getByTestId('history-row');
  await expect(row).toHaveCount(1);
  await row.getByTestId('run-open').click();
  await expect(page.getByTestId('run-output')).toContainText('Bot B says 2');
  expect(problems).toEqual([]);
});

test('the time limit cuts the turn in flight and keeps its text', async ({ page, context }) => {
  test.slow();
  await holdStreams(context);
  // The time limit aborts the stream on purpose.
  const problems = await watchForProblems(page, { allowAborted: [CHAT] });
  await open(page);
  await setLimits(page, { turns: 3, minutes: 0.1 }); // 6 s
  await start(page);
  await expect(turnText(page, 0)).toHaveText('The first half of a thought');
  await expect(page.getByTestId('bots-state')).toHaveText('Running');

  await expect(end(page)).toHaveAttribute('data-reason', 'time', { timeout: 20_000 });
  await expect(turns(page).first()).toHaveAttribute('data-status', 'cut');
  await expect(page.getByTestId('turn-cut')).toBeVisible();
  await expect(turnText(page, 0)).toHaveText('The first half of a thought');
  await expect(end(page)).toContainText('Time limit reached (6.0 s).');
  await expect(page.getByTestId('bots-time')).toContainText('0:06 / 0:06');
  expect(problems).toEqual([]);
});

test('the cost cap ends the conversation once spending reaches it', async ({ page, mock }) => {
  const problems = await watchForProblems(page, { allowAborted: [CHAT] });
  answerTurns(mock, { cost: 0.004 });
  await open(page);
  await setLimits(page, { cap: 0.01 });
  await start(page);
  // $0.004, $0.008; the third turn (≈ $0.0021 at 1,000 tokens out) could pass $0.01: checked before it.
  await expect(end(page)).toHaveAttribute('data-reason', 'cost');
  await expect(turns(page)).toHaveCount(2);
  await expect(end(page)).toContainText('Cost cap: the next turn could pass $0.01 ($0.008 spent).');
  await expect(page.getByTestId('bots-cost')).toHaveText('$0.008 / $0.01');
  expect(mock.calls(CHAT, 'POST')).toHaveLength(2);

  // Resume says why it cannot go on, and sends nothing.
  await page.getByTestId('bots-primary').click();
  await expect(status(page)).toContainText('could pass the cost cap');
  await expect(page.getByTestId('bots-cost-cap')).toBeFocused();
  expect(mock.calls(CHAT, 'POST')).toHaveLength(2);

  // Raised, the cap lets it go on; the next turn passes it and the check after the turn ends it.
  answerTurns(mock, { cost: 0.01 });
  await setLimits(page, { cap: 0.015 });
  await page.getByTestId('bots-primary').click();
  await expect(end(page).last()).toContainText('Cost cap reached: $0.018 spent of $0.015.');
  await expect(turns(page)).toHaveCount(3);
  expect(problems).toEqual([]);
});

test('the stop phrase, said by either bot, ends it', async ({ page, mock }) => {
  const problems = await watchForProblems(page, { allowAborted: [CHAT] });
  answerTurns(mock, {
    text: (speaker, n) => (n === 2 ? 'We agree: zero is even. [END]' : `${speaker} says ${n}`),
  });
  await open(page);
  await start(page);
  // With the default limits the run may cost up to the $0.25 cap, above the $0.10 per-run threshold: confirm.
  const confirm = page.getByTestId('budget-dialog');
  await expect(confirm).toBeVisible();
  await expect(page.getByTestId('budget-estimate')).toContainText('$0.25');
  await confirm.getByTestId('budget-confirm').click();
  await expect(end(page)).toHaveAttribute('data-reason', 'phrase');
  await expect(end(page)).toContainText('Bot B said [END].');
  await expect(turns(page)).toHaveCount(2);
  // The framing asks for the phrase, and the page shows the framing.
  expect(messagesOf(mock.calls(CHAT, 'POST')[0])[0]?.content).toContain(
    'end your message with [END]',
  );
  await page.getByTestId('bots-framing-toggle').click();
  await expect(page.getByTestId('bots-framing-a')).toContainText(
    'You are Bot A, in a conversation with Bot B.',
  );
  expect(problems).toEqual([]);
});

test('Stop keeps the partial turn and ends it, silently', async ({ page, context }) => {
  await holdStreams(context);
  const problems = await watchForProblems(page, { allowAborted: [CHAT] });
  await open(page);
  await setLimits(page, { turns: 3 });
  await start(page);
  await expect(turnText(page, 0)).toHaveText('The first half of a thought');
  await page.getByTestId('stop-button').click();

  await expect(end(page)).toHaveAttribute('data-reason', 'stopped');
  await expect(end(page)).toContainText('Stopped by you.');
  await expect(turns(page).first()).toHaveAttribute('data-status', 'stopped');
  await expect(turnText(page, 0)).toHaveText('The first half of a thought');
  await expect(status(page)).toHaveText('Stopped. The partial turn is kept.');
  await expect(page.getByTestId('stop-button')).toBeHidden();
  // Focus moves from Stop to Resume, which took its place.
  await expect(page.getByTestId('bots-primary')).toBeFocused();
  await expect(page.getByTestId('bots-primary')).toContainText('Resume');
  await expect(page.getByTestId('error-toast')).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('Pause holds after the turn in flight; Step runs one turn; Resume goes on', async ({
  page,
  mock,
}) => {
  const problems = await watchForProblems(page, { allowAborted: [CHAT] });
  answerTurns(mock, { delayMs: 1500 });
  await open(page);
  await setLimits(page, { turns: 4 });
  await start(page);
  await expect(page.getByTestId('bots-pause')).toBeVisible();
  await expect(page.getByTestId('bots-pause')).toBeFocused();
  await page.getByTestId('bots-pause').click();
  await expect(page.getByTestId('bots-pause')).toContainText('Pausing…');

  await expect(page.getByTestId('bots-state')).toHaveText('Paused');
  await expect(turns(page)).toHaveCount(1);
  await expect(status(page)).toHaveText('Paused after Bot A’s turn.');
  await expect(end(page)).toHaveCount(0);

  await page.getByTestId('bots-step').click();
  await expect(turns(page)).toHaveCount(2);
  await expect(page.getByTestId('bots-state')).toHaveText('Paused');
  await expect(status(page)).toHaveText('Bot B spoke. Resume or Step to go on.');

  await page.getByTestId('bots-primary').click();
  await expect(end(page)).toHaveAttribute('data-reason', 'turns');
  await expect(turns(page)).toHaveCount(4);
  expect(problems).toEqual([]);
});

test('a moderator message reaches both bots; edit a turn and resume from there', async ({
  page,
  mock,
}) => {
  const problems = await watchForProblems(page, { allowAborted: [CHAT] });
  answerTurns(mock);
  await open(page);
  // Step starts the conversation with one turn.
  await page.getByTestId('tool-prompt').fill('Is zero an even number?');
  await page.getByTestId('bots-step').click();
  await expect(turns(page)).toHaveCount(1);

  const moderator = page.getByTestId('moderator-input');
  await moderator.fill('Give one example each.');
  await moderator.press('Enter');
  await expect(page.getByTestId('moderator-message')).toHaveCount(2);
  await expect(page.getByTestId('moderator-message').last()).toContainText(
    'Give one example each.',
  );
  await expect(moderator).toHaveValue('');
  await expect(moderator).toBeFocused();

  await page.getByTestId('bots-step').click();
  await expect(turns(page)).toHaveCount(2);
  expect(messagesOf(mock.calls(CHAT, 'POST')[1]).at(-1)).toEqual({
    role: 'user',
    content:
      '[Moderator] Is zero an even number?\n\n[Bot A] Bot A says 1\n\n[Moderator] Give one example each.',
  });

  // Edit Bot A's turn: what follows goes (with Undo), and Bot B answers the edited text.
  await turns(page).first().getByTestId('turn-edit').click();
  const editor = page.getByTestId('edit-input');
  await expect(editor).toBeFocused();
  await editor.fill('Zero is even, because 0 = 2 × 0.');
  await page.getByTestId('edit-save').click();
  await expect(turns(page)).toHaveCount(1);
  await expect(turnText(page, 0)).toHaveText('Zero is even, because 0 = 2 × 0.');
  await expect(page.getByTestId('turn-edited')).toBeVisible();
  await expect(page.getByTestId('bots-edit-toast')).toContainText('2 messages after it removed');
  await expect(turns(page).first().getByTestId('turn-edit')).toBeFocused();

  await page.getByTestId('bots-step').click();
  await expect(turns(page)).toHaveCount(2);
  await expect(turns(page).nth(1)).toHaveAttribute('data-speaker', 'b');
  expect(messagesOf(mock.calls(CHAT, 'POST')[2]).slice(1)).toEqual([
    {
      role: 'user',
      content: '[Moderator] Is zero an even number?\n\n[Bot A] Zero is even, because 0 = 2 × 0.',
    },
  ]);
  expect(problems).toEqual([]);
});

test('a failed turn shows inline (a 429), and Resume tries that bot again', async ({
  page,
  mock,
}) => {
  const problems = await watchForProblems(page, { allowAborted: [CHAT] });
  let n = 0;
  mock.respond('POST', CHAT, (call) => {
    n += 1;
    if (n === 2) {
      // A wait the client will not sit through: no automatic retry.
      return {
        status: 429,
        body: {
          error: {
            code: 429,
            message: 'Rate limit exceeded',
            metadata: { retry_after_seconds: 3600 },
          },
        },
      };
    }
    return sseResponse(reply(`${speakerOf(call)} says ${n}`));
  });
  await open(page);
  await setLimits(page, { turns: 3 });
  await start(page);
  const error = page.getByTestId('turn-error');
  await expect(error).toContainText('Rate limited');
  await expect(status(page)).toContainText("Bot B's turn failed");
  await expect(page.getByTestId('bots-state')).toHaveText('Paused');
  await expect(page.getByTestId('error-toast')).toHaveCount(0);

  await page.getByTestId('bots-primary').click();
  await expect(end(page)).toHaveAttribute('data-reason', 'turns');
  await expect(error).toHaveCount(0);
  await expect(turnText(page, 1)).toHaveText('Bot B says 3');
  // The 429 itself is the only problem: the browser reports the failed response.
  expect(problems.filter((problem) => !problem.includes('429'))).toEqual([]);
});

test('exports the transcript as Markdown and JSON, with per-turn stats', async ({ page, mock }) => {
  answerTurns(mock);
  await open(page);
  await setLimits(page, { turns: 2 });
  await start(page, 'Name a colour.');
  await expect(end(page)).toBeVisible();

  await page.getByTestId('bots-export').click();
  let download = page.waitForEvent('download');
  await page.getByTestId('export-md').click();
  let file = await download;
  expect(file.suggestedFilename()).toBe('Bot A and Bot B.md');
  const markdown = readFileSync(await file.path(), 'utf8');
  expect(markdown).toContain('# Bot A and Bot B');
  expect(markdown).toContain('## Opening prompt\n\nName a colour.');
  expect(markdown).toContain(
    '## Bot A · Turn 1\n\nBot A says 1\n\n_test/text-model · 40 in · 8 out · $0.00042',
  );
  expect(markdown).toContain('**Ended (Turn limit).** Turn limit reached (2 turns).');
  expect(markdown).toContain('_2 of 2 turns · ');

  await page.getByTestId('bots-export').click();
  download = page.waitForEvent('download');
  await page.getByTestId('export-json').click();
  file = await download;
  const json = JSON.parse(readFileSync(await file.path(), 'utf8')) as {
    totals: { turns: number; costUsd: number };
    entries: { kind: string; usage?: { completionTokens: number } }[];
  };
  expect(json.totals.turns).toBe(2);
  expect(json.totals.costUsd).toBeCloseTo(0.00084, 10);
  expect(json.entries.map((entry) => entry.kind)).toEqual(['opener', 'bot', 'bot', 'end']);
  expect(json.entries[1]?.usage?.completionTokens).toBe(8);
});

test('the prompts round trip restores the whole setup', async ({ page }) => {
  const problems = await watchForProblems(page);
  await open(page);
  await page.getByTestId('bot-a-name').fill('Ada');
  await page.getByTestId('bot-a-persona').fill('You are a careful mathematician.');
  await page.getByTestId('bot-b-name').fill('Bo');
  await page.getByTestId('bots-first-b-label').click();
  await expect(page.getByTestId('bots-first-b')).toBeChecked();
  await setLimits(page, { turns: 7, minutes: 2, cap: 0.05, phrase: 'GOODBYE' });
  await page.getByTestId('tool-prompt').fill('Prove that zero is even.');

  await page.getByTestId('prompts-button').click();
  await page.getByTestId('prompts-tab-saved').click();
  await page.getByTestId('prompts-save-current').click();
  const name = page.getByTestId('prompt-input');
  await expect(name).toBeFocused();
  await name.fill('Maths duel');
  await page.getByTestId('prompt-dialog').getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('prompt-dialog')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByTestId('bot-a-name').fill('Someone else');
  await page.getByTestId('tool-prompt').fill('Another topic');
  await setLimits(page, { turns: 20, phrase: '' });

  await page.getByTestId('prompts-button').click();
  await page.getByTestId('prompts-tab-saved').click();
  await page.getByTestId('prompt-entry').getByTestId('prompt-use').click();
  await expect(page.getByTestId('tool-prompt')).toHaveValue('Prove that zero is even.');
  await expect(page.getByTestId('bot-a-name')).toHaveValue('Ada');
  await expect(page.getByTestId('bot-a-persona')).toHaveValue('You are a careful mathematician.');
  await expect(page.getByTestId('bot-b-name')).toHaveValue('Bo');
  await expect(page.getByTestId('bots-first-b')).toBeChecked();
  await expect(page.getByTestId('bots-turn-limit')).toHaveValue('7');
  await expect(page.getByTestId('bots-time-limit')).toHaveValue('2');
  await expect(page.getByTestId('bots-cost-cap')).toHaveValue('0.05');
  await expect(page.getByTestId('bots-stop-phrase')).toHaveValue('GOODBYE');
  expect(problems).toEqual([]);
});

test('works at 320 px with the keyboard only', async ({ page, mock }) => {
  const problems = await watchForProblems(page, { allowAborted: [CHAT] });
  await page.setViewportSize({ width: 320, height: 720 });
  answerTurns(mock);
  await open(page);
  await setLimits(page, { turns: 2 });
  await page.getByTestId('tool-prompt').focus();
  await page.keyboard.type('Say hello.');
  await tabTo(page, 'bots-primary');
  await page.keyboard.press('Enter');
  await expect(end(page)).toHaveAttribute('data-reason', 'turns');
  await expect(page.getByTestId('bots-primary')).toBeFocused();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  expect(problems).toEqual([]);
});

test('a conversation passes axe in light and dark', async ({ page, mock }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  answerTurns(mock, {
    text: (speaker, n) =>
      n === 1
        ? `# Plan\n\n- **${speaker}:** one\n- two\n\n[a link](https://example.com)`
        : `${speaker} says ${n}`,
  });
  await open(page);
  await setLimits(page, { turns: 2 });
  await start(page);
  await expect(end(page)).toBeVisible();
  await page.getByTestId('moderator-input').fill('Thanks, both.');
  await page.getByTestId('moderator-send').click();
  await page.getByTestId('bots-framing-toggle').click();
  await expect(page.getByTestId('bots-framing-a')).toBeVisible();

  await expectNoSeriousA11yViolations(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark');
  await expectNoSeriousA11yViolations(page);
});
