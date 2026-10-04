/**
 * The test entry point for e2e specs. Import `test` and `expect` from here,
 * not from '@playwright/test':
 *
 * ```ts
 * import { expect, seedSettings, test } from '../mock/index.ts';
 * ```
 *
 * That gives every test the `mock` fixture automatically, including tests
 * that never mention it, so a stray request to openrouter.ai always fails the
 * test instead of reaching the network.
 */
import { test as base, expect, type BrowserContext } from '@playwright/test';
import { OpenRouterMock } from './openrouter.ts';

export { expect };
export {
  MEDIA_FIXTURES_DIR,
  OpenRouterMock,
  OPENROUTER_ORIGIN,
  sseResponse,
} from './openrouter.ts';
export type { RecordedCall, SequenceResponse } from './openrouter.ts';

/** A syntactically plausible key that is obviously not real. */
export const TEST_API_KEY =
  'sk-or-v1-test-0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Small inline placeholders so pages that read the catalog or key status on
 * load have something to read. Tests that care about the content register
 * their own mocks (the last one registered wins); recorded and documented
 * responses live in tests/fixtures/openrouter/.
 */
function seedDefaults(mock: OpenRouterMock): void {
  mock.json('GET', '/api/v1/models', {
    data: [
      {
        id: 'test/text-model',
        name: 'Test: Text Model',
        created: 1750000000,
        description: 'Placeholder paid text model.',
        context_length: 128000,
        architecture: {
          modality: 'text+image->text',
          input_modalities: ['text', 'image'],
          output_modalities: ['text'],
          tokenizer: 'Other',
        },
        pricing: { prompt: '0.000001', completion: '0.000002' },
        top_provider: { context_length: 128000, max_completion_tokens: 8192, is_moderated: false },
        supported_parameters: ['max_tokens', 'temperature', 'response_format'],
      },
      {
        id: 'test/text-model:free',
        name: 'Test: Text Model (free)',
        created: 1750000000,
        description: 'Placeholder free text model.',
        context_length: 32000,
        architecture: {
          modality: 'text->text',
          input_modalities: ['text'],
          output_modalities: ['text'],
          tokenizer: 'Other',
        },
        pricing: { prompt: '0', completion: '0' },
        top_provider: { context_length: 32000, max_completion_tokens: 4096, is_moderated: false },
        supported_parameters: ['max_tokens', 'temperature'],
      },
    ],
  });

  mock.json('GET', '/api/v1/key', {
    data: {
      label: 'sk-or-v1-tes...000',
      limit: 5,
      limit_remaining: 4.5,
      usage: 0.5,
      is_free_tier: false,
    },
  });

  // Per-provider prices (keyless, like the catalog), read for TTS estimates: none listed by default.
  mock.json('GET', /^\/api\/v1\/models\/.+\/endpoints$/, { data: { endpoints: [] } });

  // The image models' parameters (keyless), read by the image tools: none listed by default.
  mock.json('GET', '/api/v1/images/models', { data: [] });

  // The video models' options and prices (keyless), read by Video studio: none listed by default.
  mock.json('GET', '/api/v1/videos/models', { data: [] });
}

/**
 * Puts values into localStorage before any page script runs, once per
 * browser context (so the app's own later writes are not overwritten on the
 * next navigation). Values are stored as JSON. Call before `page.goto()`.
 */
export async function seedLocalStorage(
  context: BrowserContext,
  entries: Record<string, unknown>,
): Promise<void> {
  await context.addInitScript(
    (items: Record<string, string>) => {
      const marker = 'ortoolbox:test-seeded';
      if (localStorage.getItem(marker)) return;
      for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value);
      localStorage.setItem(marker, '1');
    },
    Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, JSON.stringify(value)])),
  );
}

/**
 * Seeds the app's settings (localStorage key `ortoolbox:settings`).
 *
 * ```ts
 * await seedSettings(context, { appearance: { theme: 'dark' } });
 * ```
 *
 * Stage 1 owns the settings schema, including where API keys live; use
 * `TEST_API_KEY` as the key value when seeding one. The only path fixed so
 * far is `appearance.theme`.
 */
export async function seedSettings(
  context: BrowserContext,
  settings: Record<string, unknown>,
): Promise<void> {
  await seedLocalStorage(context, { 'ortoolbox:settings': settings });
}

export const test = base.extend<{ mock: OpenRouterMock }>({
  mock: [
    async ({ context }, use) => {
      const mock = new OpenRouterMock();
      seedDefaults(mock);
      await mock.install(context);
      await use(mock);
      expect(mock.unmocked, 'requests to openrouter.ai that no mock answered').toEqual([]);
      expect(mock.refusedByCors, "requests openrouter.ai's CORS preflight would refuse").toEqual(
        [],
      );
    },
    { auto: true },
  ],
});
