/**
 * "Connect with OpenRouter": the whole round trip against the mock. The button sends the browser to
 * openrouter.ai/auth (the mock answers with the redirect OpenRouter makes), the callback page exchanges the code
 * (POST /auth/keys) and the user lands where they started, with the key stored.
 */
import { createHash } from 'node:crypto';
import { expect, test } from '../mock/index.ts';
import { seedApp } from './app.ts';
import { watchForProblems } from './support.ts';

const MINTED_KEY =
  'sk-or-v1-minted-1111111111111111111111111111111111111111111111111111111111111111';

test('Connect with OpenRouter: sign in, exchange the code, come back to Settings with the key', async ({
  page,
  context,
  mock,
}) => {
  await seedApp(context);
  const problems = await watchForProblems(page);
  // OpenRouter's sign-in page, reduced to what it does after the user agrees: redirect to the callback with a code.
  mock.respond('GET', '/auth', (call) => ({
    status: 302,
    headers: {
      location: `${call.query['callback_url']}?code=abc123&state=${call.query['state']}`,
    },
  }));
  mock.json('POST', '/api/v1/auth/keys', { key: MINTED_KEY, user_id: 'user_1' });
  mock.json('GET', '/api/v1/key', {
    data: { label: 'sk-or-v1-min...111', limit: null, limit_remaining: null, usage: 0.25 },
  });

  await page.goto('settings/#keys');
  await expect(page.getByTestId('connect-openrouter')).toBeVisible();
  await page.getByTestId('connect-openrouter').click();

  // Back on Settings, where the sign-in started, with the new key listed as connected.
  await expect(page).toHaveURL(/\/settings\/#keys$/);
  const keys = page.getByTestId('settings-section-keys');
  await expect(keys).toContainText('ORtoolbox');
  await expect(keys).toContainText('sk-or-…1111');
  await expect(keys).toContainText('Connected');

  // The sign-in asked OpenRouter for what the app needs and proved itself with PKCE.
  const [auth] = mock.calls('/auth');
  expect(auth?.query['code_challenge_method']).toBe('S256');
  expect(auth?.query['callback_url']).toMatch(/\/or-toolbox\/auth\/callback\/$/);
  expect(auth?.query['key_label']).toBe('ORtoolbox');
  const [exchange] = mock.calls('/api/v1/auth/keys', 'POST');
  const body = exchange?.body as {
    code: string;
    code_verifier: string;
    code_challenge_method: string;
  };
  expect(body.code).toBe('abc123');
  expect(body.code_challenge_method).toBe('S256');
  const challenge = createHash('sha256').update(body.code_verifier).digest('base64url');
  expect(challenge).toBe(auth?.query['code_challenge']);
  // The exchange needs no key, and the secret is never put in a URL.
  expect(exchange?.headers['authorization']).toBeUndefined();
  expect(mock.calls().filter((call) => call.url.includes(MINTED_KEY))).toHaveLength(0);

  // The key is really stored: it survives a reload and is what requests carry from now on.
  await page.reload();
  await expect(page.getByTestId('settings-section-keys')).toContainText('sk-or-…1111');
  const stored = await page.evaluate(() => localStorage.getItem('ortoolbox:keys') ?? '');
  expect(stored).toContain('"source":"oauth"');
  expect(problems).toEqual([]);
});

test('a sign-in the user refuses ends on a clear message and stores nothing', async ({
  page,
  context,
  mock,
}) => {
  await seedApp(context);
  mock.respond('GET', '/auth', (call) => ({
    status: 302,
    headers: {
      location: `${call.query['callback_url']}?error=access_denied&state=${call.query['state']}`,
    },
  }));

  await page.goto('settings/#keys');
  await page.getByTestId('connect-openrouter').click();
  await expect(page.getByTestId('auth-error')).toContainText('canceled or refused');
  expect(mock.calls('/api/v1/auth/keys')).toHaveLength(0);
  expect(await page.evaluate(() => localStorage.getItem('ortoolbox:keys'))).toBeNull();
});
