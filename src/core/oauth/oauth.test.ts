import { beforeEach, describe, expect, it, vi } from 'vitest';
import authKeys from '../../../tests/fixtures/openrouter/auth-keys-response.documented.json';
import { isolateChannels, testCore } from '../api/test-fakes';
import { ApiError, KeyLockedError, errorCode, userMessage } from '../errors';
import { createKeysService } from '../keys/keys';
import { SS_KEYS } from '../storage/local';
import type { ApiClient, KeyInfo, KeysService } from '../types';
import {
  OAuthError,
  OPENROUTER_AUTH_URL,
  callbackUrl,
  createOAuthService,
  safeReturnTo,
} from './oauth';
import { base64Url, challengeS256, createVerifier } from './pkce';

/** A well-formed fake key (the `test`/`z` characters keep it clear of the real-key hook). */
const OAUTH_KEY = `sk-or-v1-test${'z'.repeat(60)}`;

const keyInfo: KeyInfo = {
  id: 'k1',
  name: 'ORtoolbox',
  colour: null,
  masked: 'sk-or-…zzzz',
  source: 'oauth',
  createdAt: 0,
  noRetention: false,
  isDefault: true,
};

function setup(now = () => 1_000_000) {
  const navigate = vi.fn<(href: string) => void>();
  const exchangeAuthCode = vi.fn(() => Promise.resolve({ key: OAUTH_KEY }));
  const add = vi.fn(() => Promise.resolve(keyInfo));
  const lock = { locked: false };
  const oauth = createOAuthService(
    testCore({
      api: { account: { exchangeAuthCode } } as unknown as ApiClient,
      keys: { add, lock: { unlocked: () => !lock.locked } } as unknown as KeysService,
    }),
    { navigate, now },
  );
  return { oauth, navigate, exchangeAuthCode, add, lock };
}

async function started(
  s: ReturnType<typeof setup>,
  opts?: Parameters<ReturnType<typeof setup>['oauth']['start']>[0],
): Promise<URL> {
  await s.oauth.start(opts);
  const href = s.navigate.mock.calls[0]?.[0];
  if (!href) throw new Error('no navigation');
  return new URL(href);
}

beforeEach(() => {
  isolateChannels();
  sessionStorage.clear();
});

describe('pkce', () => {
  it('computes the RFC 7636 S256 test vector', async () => {
    expect(await challengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('makes 43-character url-safe verifiers', () => {
    const verifier = createVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createVerifier()).not.toBe(verifier);
    expect(base64Url(new Uint8Array([251, 255, 191]))).toBe('-_-_');
  });
});

describe('start', () => {
  it('saves the verifier and state, then navigates to openrouter.ai/auth', async () => {
    const s = setup();
    const url = await started(s, {
      keyLabel: 'ORtoolbox',
      returnTo: '/or-toolbox/tools/chat/?x=1',
    });
    expect(`${url.origin}${url.pathname}`).toBe(OPENROUTER_AUTH_URL);
    const pending = JSON.parse(sessionStorage.getItem(SS_KEYS.oauth) ?? '{}') as {
      verifier: string;
      state: string;
      returnTo: string;
      keyLabel: string;
    };
    expect(Object.fromEntries(url.searchParams)).toEqual({
      callback_url: 'http://localhost:3000/or-toolbox/auth/callback/',
      code_challenge: await challengeS256(pending.verifier),
      code_challenge_method: 'S256',
      state: pending.state,
      key_label: 'ORtoolbox',
    });
    expect(pending.returnTo).toBe('/or-toolbox/tools/chat/?x=1');
    expect(callbackUrl()).toBe('http://localhost:3000/or-toolbox/auth/callback/');
  });

  it('omits key_label when none is given and drops unsafe returnTo values', async () => {
    const s = setup();
    const url = await started(s, { returnTo: 'https://evil.example/' });
    expect(url.searchParams.has('key_label')).toBe(false);
    const pending = JSON.parse(sessionStorage.getItem(SS_KEYS.oauth) ?? '{}') as {
      returnTo: unknown;
    };
    expect(pending.returnTo).toBeNull();
  });

  it('accepts only same-site return paths', () => {
    expect(safeReturnTo('/or-toolbox/settings/')).toBe('/or-toolbox/settings/');
    expect(safeReturnTo('/or-toolbox/tools/ocr/#a')).toBe('/or-toolbox/tools/ocr/#a');
    expect(safeReturnTo('//evil.example/or-toolbox/')).toBeNull();
    expect(safeReturnTo('https://evil.example/or-toolbox/')).toBeNull();
    expect(safeReturnTo('/other-project/')).toBeNull();
    expect(safeReturnTo('/or-toolbox\\..\\x')).toBeNull();
    expect(safeReturnTo('javascript:alert(1)')).toBeNull();
    expect(safeReturnTo(null)).toBeNull();
  });
});

describe('complete', () => {
  async function callbackParams(
    s: ReturnType<typeof setup>,
    opts?: { returnTo?: string; keyLabel?: string },
  ) {
    const url = await started(s, opts);
    return new URLSearchParams({ code: 'the-code', state: url.searchParams.get('state') ?? '' });
  }

  it('exchanges the code once, stores the key as oauth and returns returnTo', async () => {
    const s = setup();
    const params = await callbackParams(s, {
      returnTo: '/or-toolbox/tools/ocr/',
      keyLabel: 'My label',
    });
    const verifier = (
      JSON.parse(sessionStorage.getItem(SS_KEYS.oauth) ?? '{}') as { verifier: string }
    ).verifier;
    const result = await s.oauth.complete(params);
    expect(s.exchangeAuthCode).toHaveBeenCalledWith({
      code: 'the-code',
      codeVerifier: verifier,
      codeChallengeMethod: 'S256',
    });
    expect(s.add).toHaveBeenCalledWith({ name: 'My label', secret: OAUTH_KEY, source: 'oauth' });
    expect(result).toEqual({ key: keyInfo, returnTo: '/or-toolbox/tools/ocr/' });
    expect(sessionStorage.getItem(SS_KEYS.oauth)).toBeNull();
  });

  it('is single use: a reload cannot exchange again', async () => {
    const s = setup();
    const params = await callbackParams(s);
    await s.oauth.complete(params);
    await expect(s.oauth.complete(params)).rejects.toThrow(/already used/);
    expect(s.exchangeAuthCode).toHaveBeenCalledTimes(1);
  });

  it('rejects a state mismatch without exchanging, and burns the pending entry', async () => {
    const s = setup();
    const params = await callbackParams(s);
    const forged = new URLSearchParams({ code: 'the-code', state: 'forged' });
    await expect(s.oauth.complete(forged)).rejects.toBeInstanceOf(OAuthError);
    await expect(s.oauth.complete(params)).rejects.toBeInstanceOf(OAuthError);
    expect(s.exchangeAuthCode).not.toHaveBeenCalled();
  });

  it('explains a missing code, a refusal and an expired attempt', async () => {
    const s = setup();
    await expect(s.oauth.complete(new URLSearchParams())).rejects.toThrow(/no sign-in code/);
    await expect(s.oauth.complete(new URLSearchParams({ error: 'access_denied' }))).rejects.toThrow(
      /cancelled/,
    );
    let clock = 0;
    const late = setup(() => clock);
    const params = await callbackParams(late);
    clock = 31 * 60_000;
    await expect(late.oauth.complete(params)).rejects.toThrow(/expired/);
    expect(late.exchangeAuthCode).not.toHaveBeenCalled();
  });

  it('propagates exchange failures and still burns the entry', async () => {
    const s = setup();
    s.exchangeAuthCode.mockRejectedValueOnce(new ApiError('Invalid code or code_verifier', 403));
    const params = await callbackParams(s);
    await expect(s.oauth.complete(params)).rejects.toBeInstanceOf(ApiError);
    expect(sessionStorage.getItem(SS_KEYS.oauth)).toBeNull();
    expect(s.add).not.toHaveBeenCalled();
  });

  it('refuses while locked without consuming anything, then works with the same params', async () => {
    const s = setup();
    const params = await callbackParams(s);
    const pending = sessionStorage.getItem(SS_KEYS.oauth);
    s.lock.locked = true;
    const error: unknown = await s.oauth.complete(params).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeyLockedError);
    expect(errorCode(error)).toBe('locked');
    expect(sessionStorage.getItem(SS_KEYS.oauth)).toBe(pending);
    expect(s.exchangeAuthCode).not.toHaveBeenCalled();
    s.lock.locked = false;
    await expect(s.oauth.complete(params)).resolves.toMatchObject({ key: keyInfo });
    expect(s.exchangeAuthCode).toHaveBeenCalledTimes(1);
  });

  it('refuses to start while locked', async () => {
    const s = setup();
    s.lock.locked = true;
    await expect(s.oauth.start()).rejects.toBeInstanceOf(KeyLockedError);
    expect(s.navigate).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(SS_KEYS.oauth)).toBeNull();
  });

  it('shows its own message to the user (OAuthError is an OrError)', async () => {
    const s = setup();
    const error: unknown = await s.oauth.complete(new URLSearchParams()).catch((e: unknown) => e);
    expect(errorCode(error)).toBe('oauth');
    expect(userMessage(error)).toMatch(/no sign-in code/);
  });

  it('stores a usable default key end to end with the real keys service', async () => {
    localStorage.clear();
    const core = testCore({
      api: {
        account: { exchangeAuthCode: () => Promise.resolve({ key: OAUTH_KEY }) },
      } as unknown as ApiClient,
    });
    const settings = core.settings;
    core.keys = createKeysService(core);
    const navigate = vi.fn<(href: string) => void>();
    const oauth = createOAuthService(core, { navigate });
    await oauth.start();
    const state = new URL(navigate.mock.calls[0]?.[0] ?? '').searchParams.get('state') ?? '';
    const { key, returnTo } = await oauth.complete(new URLSearchParams({ code: 'c', state }));
    expect(key).toMatchObject({ name: 'OpenRouter', source: 'oauth', isDefault: true });
    expect(returnTo).toBeNull();
    expect(settings.get().defaultKeyId).toBe(key.id);
    expect(await core.keys.secret(key.id)).toBe(OAUTH_KEY);
    expect(authKeys.key).toMatch(/^sk-or-/);
  });
});
