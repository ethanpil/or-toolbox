/**
 * Model arena against the mocked OpenRouter: four contenders streaming at once (the stage gate), blind voting and
 * the tally, one contender failing and its Retry, Stop, an image attachment, the prompts round trip, export, and
 * axe at 320 px in light and dark.
 *
 * The mock serves an SSE body in one piece, so concurrency is proven from inside the page: a `fetch` wrapper holds
 * every chat request until four are waiting, then lets them all through to the mock. A round that sent them one
 * after another would never get past the first. Stop holds the streams open the same way Chat's spec does.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import {
  expect,
  MEDIA_FIXTURES_DIR,
  type OpenRouterMock,
  type RecordedCall,
  sseResponse,
  test,
} from '../mock/index.ts';
import { seedApp } from './app.ts';
import { expectNoSeriousA11yViolations, watchForProblems } from './support.ts';

const CHAT = '/api/v1/chat/completions';

const catalogModel = (id: string, name: string, input: string[], price: string) => ({
  id,
  name,
  created: 1750000000,
  description: `${name} for the arena spec.`,
  context_length: 64000,
  architecture: {
    modality: `${input.join('+')}->text`,
    input_modalities: input,
    output_modalities: ['text'],
    tokenizer: 'Other',
  },
  pricing: { prompt: price, completion: price },
  top_provider: { context_length: 64000, max_completion_tokens: 4096, is_moderated: false },
  supported_parameters: ['max_tokens', 'temperature'],
});

const MODELS = {
  alpha: catalogModel('test/alpha:free', 'Test: Alpha', ['text', 'image'], '0'),
  beta: catalogModel('test/beta:free', 'Test: Beta', ['text'], '0'),
  gamma: catalogModel('test/gamma:free', 'Test: Gamma', ['text', 'image'], '0'),
  delta: catalogModel('test/delta', 'Test: Delta', ['text', 'image'], '0.000001'),
};
const NAMES: Record<string, string> = Object.fromEntries(
  Object.values(MODELS).map((model) => [model.id, model.name]),
);

/** A streamed answer for `model`: one content chunk, the finish chunk and the usage chunk. */
function answer(model: string, text = `Answer from ${NAMES[model] ?? model}.`): unknown[] {
  const base = { id: `gen-${model}`, object: 'chat.completion.chunk', created: 1, model };
  const cost = model.endsWith(':free') ? 0 : 0.00042;
  return [
    {
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    },
    { ...base, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }] },
    {
      ...base,
      choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 14, completion_tokens: 6, total_tokens: 20, cost },
    },
  ];
}

const modelOf = (call: RecordedCall): string => (call.body as { model: string }).model;

/** Every chat request answers for its own model. */
function answerEach(mock: OpenRouterMock): void {
  mock.respond('POST', CHAT, (call) => sseResponse(answer(modelOf(call))));
}

const panels = (page: Page) => page.getByTestId('arena-panel');
const contenders = (page: Page) => page.getByTestId('contender');

async function openArena(page: Page): Promise<void> {
  await page.goto('tools/model-arena/');
  await expect(contenders(page).first().getByTestId('contender-name')).toHaveText('Test: Alpha');
}

/** Opens the model picker with `button` (Add, or a contender's Change) and chooses `model`. */
async function pick(page: Page, button: Locator, model: string): Promise<void> {
  await button.click();
  const picker = page.getByTestId('model-picker');
  await picker.getByTestId(`model-option-${model}`).click();
  await expect(picker).toHaveCount(0);
}

test.beforeEach(async ({ context, mock }) => {
  mock.json('GET', '/api/v1/models', { data: Object.values(MODELS) });
  await seedApp(context, {
    key: true,
    settings: {
      tools: {
        'model-arena': { options: { models: ['test/alpha:free', 'test/beta:free'] } },
      },
    },
  });
});

test('four contenders stream at once; a blind vote reveals the names and counts', async ({
  page,
  mock,
}) => {
  // The API client cancels each stream once it has read `[DONE]`; Chromium may report that as an abort.
  const problems = await watchForProblems(page, { allowAborted: [CHAT] });
  // Holds every chat request until four are waiting, then sends them all on to the mock.
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    const held: (() => void)[] = [];
    const counters = { maxWaiting: 0 };
    (window as unknown as { arenaGate: typeof counters }).arenaGate = counters;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith('/api/v1/chat/completions')) return original(input, init);
      const gate = new Promise<void>((resolve) => held.push(resolve));
      counters.maxWaiting = Math.max(counters.maxWaiting, held.length);
      if (held.length >= 4) for (const release of held.splice(0)) release();
      return gate.then(() => original(input, init));
    };
  });
  answerEach(mock);
  await openArena(page);
  // The contenders are the models: no model chip in the header, the estimate stays.
  await expect(page.getByTestId('model-chip')).toHaveCount(0);
  await expect(page.getByTestId('cost-estimate')).toBeVisible();

  await pick(page, page.getByTestId('contender-add'), 'test/gamma:free');
  await pick(page, page.getByTestId('contender-add'), 'test/delta');
  await expect(contenders(page).getByTestId('contender-name')).toHaveText([
    'Test: Alpha',
    'Test: Beta',
    'Test: Gamma',
    'Test: Delta',
  ]);
  await expect(page.getByTestId('contender-count')).toHaveText('4 of 4');
  await expect(page.getByTestId('contender-add')).toBeHidden();
  // The new contender's Change button has focus, ready for the keyboard.
  await expect(contenders(page).nth(3).getByTestId('contender-change')).toBeFocused();

  await page.getByTestId('tool-prompt').fill('Which is larger, 9.11 or 9.9?');
  await page.keyboard.press('Control+Enter');

  await expect(panels(page)).toHaveCount(4);
  await expect(panels(page).getByTestId('panel-status')).toHaveText([
    'Done',
    'Done',
    'Done',
    'Done',
  ]);
  expect(
    await page.evaluate(
      () => (window as unknown as { arenaGate: { maxWaiting: number } }).arenaGate.maxWaiting,
    ),
  ).toBe(4);
  const calls = mock.calls(CHAT, 'POST');
  expect(calls.map(modelOf).sort()).toEqual(Object.keys(NAMES).sort());
  for (const call of calls) {
    expect(call.body).toMatchObject({
      stream: true,
      messages: [{ role: 'user', content: 'Which is larger, 9.11 or 9.9?' }],
    });
  }

  // Blind: Model A–D, no names, no costs; the answers do not say who wrote them here.
  await expect(panels(page).getByTestId('panel-title')).toHaveText([
    'Model A',
    'Model B',
    'Model C',
    'Model D',
  ]);
  await expect(panels(page).getByTestId('panel-model')).toHaveText(
    Array(4).fill('Name hidden until you vote'),
  );
  await expect(panels(page).getByTestId('metric-cost')).toHaveText(Array(4).fill('Hidden'));
  await expect(page.getByTestId('arena-export')).toBeDisabled();
  await expect(page.getByTestId('tool-status')).toContainText('Round complete: 4 of 4 answered.');

  // Vote for Model B: its answer names the model it came from, and now the header does too.
  const answerB = await panels(page).nth(1).getByTestId('panel-answer').textContent();
  const winner = /Answer from (.+)\./.exec(answerB ?? '')?.[1] ?? '';
  await page.getByTestId('vote-panel').filter({ hasText: 'Model B' }).click();
  await expect(page.getByTestId('vote-result')).toHaveText(`You picked Model B: ${winner}.`);
  await expect(page.getByTestId('vote-result')).toBeFocused();
  await expect(panels(page).nth(1).getByTestId('panel-model')).toHaveText(winner);
  await expect(panels(page).nth(1).getByText('Your pick')).toBeVisible();
  await expect(page.getByTestId('tally-row')).toHaveCount(4);
  await expect(page.getByTestId('tally-row').first()).toContainText(`${winner}1`);

  // The round exports with every answer, its metrics and the vote.
  await page.getByTestId('arena-export').click();
  const download = page.waitForEvent('download');
  await page.getByTestId('export-md').click();
  const text = readFileSync(await (await download).path(), 'utf8');
  expect(text).toContain('# Model arena round');
  expect(text).toContain('Which is larger, 9.11 or 9.9?');
  for (const name of Object.values(NAMES)) expect(text).toContain(`Answer from ${name}.`);
  expect(text).toContain(`## Vote\n\nModel B (${winner}) won.`);
  expect(problems).toEqual([]);
});

test('one contender failing leaves the others; its Retry runs it alone', async ({ page, mock }) => {
  const problems = await watchForProblems(page, { allowAborted: [CHAT] });
  mock.respond('POST', CHAT, (call) =>
    modelOf(call) === 'test/beta:free'
      ? {
          status: 400,
          body: { error: { code: 400, message: 'test/beta:free is not available right now.' } },
        }
      : sseResponse(answer(modelOf(call))),
  );
  await openArena(page);
  await page.getByTestId('tool-prompt').fill('Name a prime number.');
  await page.getByTestId('run-button').click();

  const failed = panels(page).filter({ has: page.getByTestId('panel-error') });
  await expect(failed).toHaveCount(1);
  // Blind: the provider's message does not give the model away.
  await expect(failed.getByTestId('panel-error')).toContainText(
    'this model is not available right now.',
  );
  await expect(failed.getByTestId('panel-error')).not.toContainText('beta');
  await expect(panels(page).getByTestId('panel-status')).toContainText(['Failed']);
  await expect(panels(page).filter({ hasText: 'Answer from Test: Alpha.' })).toHaveCount(1);
  await expect(page.getByTestId('tool-status')).toContainText('1 of 2 answered, 1 failed.');
  await expect(page.getByTestId('error-toast')).toHaveCount(0);

  answerEach(mock);
  await failed.getByTestId('panel-retry').click();
  await expect(page.getByTestId('panel-error')).toHaveCount(0);
  await expect(panels(page).getByTestId('panel-status')).toHaveText(['Done', 'Done']);
  await expect(panels(page).filter({ hasText: 'Answer from Test: Beta.' })).toHaveCount(1);
  const calls = mock.calls(CHAT, 'POST').map(modelOf);
  expect(calls).toHaveLength(3);
  expect(calls[2]).toBe('test/beta:free');
  // The 400 itself is the failure this test is about.
  expect(problems.filter((problem) => !problem.includes('400'))).toEqual([]);
});

test('Stop stops every contender and keeps the partial answers', async ({ page }) => {
  // Holds each chat stream open after its first event until the request is aborted.
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith('/api/v1/chat/completions')) return original(input, init);
      const body = typeof init?.body === 'string' ? init.body : '{}';
      const model = (JSON.parse(body) as { model?: string }).model ?? 'a model';
      const chunk = {
        id: 'gen-held',
        model,
        choices: [
          { index: 0, delta: { content: `The first half from ${model}` }, finish_reason: null },
        ],
      };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
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
  await openArena(page);
  await page.getByTestId('tool-prompt').fill('Tell me a long story');
  await page.getByTestId('run-button').click();
  await expect(panels(page).getByTestId('panel-answer')).toContainText([
    'The first half from',
    'The first half from',
  ]);
  await page.getByTestId('stop-button').click();
  await expect(panels(page).getByTestId('panel-status')).toHaveText(['Stopped', 'Stopped']);
  await expect(panels(page).getByTestId('panel-answer')).toContainText([
    'The first half from',
    'The first half from',
  ]);
  // The client books a cut stream with zero tokens; the panels say the count is unknown instead of 0.
  await expect(panels(page).getByTestId('metric-tokens')).toHaveText(['—', '—']);
  await expect(page.getByTestId('tool-status')).toHaveText('Stopped. Partial answers are kept.');
  await expect(page.getByTestId('stop-button')).toBeHidden();
  await expect(page.getByTestId('panel-error')).toHaveCount(0);
  await expect(page.getByTestId('error-toast')).toHaveCount(0);
});

test('an image goes to every contender; one that cannot read it is refused first', async ({
  page,
  mock,
}) => {
  answerEach(mock);
  await openArena(page);
  await page
    .getByTestId('arena-file')
    .setInputFiles(join(MEDIA_FIXTURES_DIR, 'generated-image.jpg'));
  await expect(page.getByTestId('arena-file-chip')).toContainText('generated-image.jpg');
  await expect(contenders(page).nth(1).getByTestId('contender-warning')).toHaveText(
    "This model can't read images",
  );
  await page.getByTestId('tool-prompt').fill('What is in this picture?');
  await page.getByTestId('run-button').click();
  await expect(page.getByTestId('error-toast')).toContainText("Test: Beta can't read images.");
  expect(mock.calls(CHAT)).toHaveLength(0);
  await expect(panels(page)).toHaveCount(0);

  await pick(page, contenders(page).nth(0).getByTestId('contender-change'), 'test/gamma:free');
  await pick(page, contenders(page).nth(1).getByTestId('contender-change'), 'test/alpha:free');
  await expect(page.getByTestId('contender-warning')).toHaveCount(0);
  await page.getByTestId('run-button').click();
  await expect(panels(page).getByTestId('panel-status')).toHaveText(['Done', 'Done']);
  const calls = mock.calls(CHAT, 'POST');
  expect(calls.map(modelOf).sort()).toEqual(['test/alpha:free', 'test/gamma:free']);
  for (const call of calls) {
    const parts = (
      call.body as { messages: { content: { type: string; image_url?: { url: string } }[] }[] }
    ).messages[0]!.content;
    expect(parts[0]).toEqual({ type: 'text', text: 'What is in this picture?' });
    expect(parts[1]?.image_url?.url).toMatch(/^data:image\/jpeg;base64,\/9j\//);
  }
  // The files stay for the next round.
  await expect(page.getByTestId('arena-file-chip')).toHaveCount(1);
});

test('Prompts save the whole form and Use restores it', async ({ page }) => {
  const problems = await watchForProblems(page);
  await openArena(page);
  await page.getByTestId('tool-prompt').fill('Compare these two');
  await pick(page, page.getByTestId('contender-add'), 'test/delta');
  await page.getByTestId('drawer-button').click();
  await page.getByTestId('arena-blind').uncheck();
  await page.getByTestId('arena-system').fill('Answer in one line.');
  await page.getByTestId('arena-temperature').fill('0.5');
  await page.getByTestId('arena-temperature').press('Tab');
  await page.keyboard.press('Escape');

  await page.getByTestId('prompts-button').click();
  await page.getByTestId('prompts-tab-saved').click();
  await page.getByTestId('prompts-save-current').click();
  await page.getByTestId('prompt-input').fill('Three-way');
  await page.getByTestId('prompt-dialog').getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('prompt-dialog')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Change everything back.
  await page.getByTestId('tool-prompt').fill('Something else');
  await contenders(page).nth(2).getByTestId('contender-remove').click();
  await expect(contenders(page)).toHaveCount(2);
  await page.getByTestId('drawer-button').click();
  await page.getByTestId('arena-blind').check();
  await page.getByTestId('arena-system').fill('');
  await page.keyboard.press('Escape');

  await page.getByTestId('prompts-button').click();
  await page.getByTestId('prompts-tab-saved').click();
  await page.getByTestId('prompts-saved').getByTestId('prompt-use').click();
  await expect(page.getByTestId('tool-prompt')).toHaveValue('Compare these two');
  await expect(contenders(page).getByTestId('contender-name')).toHaveText([
    'Test: Alpha',
    'Test: Beta',
    'Test: Delta',
  ]);
  await page.getByTestId('drawer-button').click();
  await expect(page.getByTestId('arena-blind')).not.toBeChecked();
  await expect(page.getByTestId('arena-system')).toHaveValue('Answer in one line.');
  await expect(page.getByTestId('arena-temperature')).toHaveValue('0.5');
  expect(problems).toEqual([]);
});

test('a round passes axe at 320 px in light and dark', async ({ page, mock }) => {
  answerEach(mock);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });
  await openArena(page);
  await page.getByTestId('tool-prompt').fill('Write a haiku about rain.');
  await page.getByTestId('run-button').click();
  await expect(panels(page).getByTestId('panel-status')).toHaveText(['Done', 'Done']);
  // Nothing is wider than the phone.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expectNoSeriousA11yViolations(page);
  await page.getByTestId('vote-tie').click();
  await expect(page.getByTestId('vote-result')).toHaveText('You called it a tie.');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark');
  await expectNoSeriousA11yViolations(page);
});
