import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CryptoModule from '../crypto';
import { decryptWithPassphrase, type PassphraseEnvelope } from '../crypto';
import { BackupError, type BackupFile } from '.';
import type { BusEvent, CoreServices, StoredKeysFile } from '../types';
import { getDb } from '../storage/db';
import { LS_KEYS, SS_KEYS } from '../storage/local';
import { prefixRange } from '../tool-state';
import { createTestCore, fakeKey, isolateChannels, resetDb } from '../testing/state-fakes';

// PBKDF2 at 600 000 iterations is slow on a busy test machine; the envelope format is unchanged.
vi.mock('../crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof CryptoModule>();
  return {
    ...actual,
    encryptWithPassphrase: (passphrase: string, plain: string) =>
      actual.encryptWithPassphrase(passphrase, plain, 1000),
  };
});

const SECRET = 'sk-or-v1-0123456789abcdef0123456789abcdefSECRET';

function keysFile(
  keys: { id: string; secret: string }[],
  lock: StoredKeysFile['lock'] = null,
): StoredKeysFile {
  return {
    version: 1,
    keys: keys.map(({ id, secret }) => ({
      id,
      name: `Key ${id}`,
      colour: null,
      masked: 'sk-or-…CRET',
      source: 'pasted',
      createdAt: 1,
      noRetention: false,
      secret: lock ? null : secret,
      enc: lock ? { iv: 'aXY=', ct: `cipher-${secret}` } : null,
    })),
    lock,
  };
}

const storedKeys = (): unknown => JSON.parse(localStorage.getItem(LS_KEYS.keys) ?? 'null');

let core: CoreServices;
let events: BusEvent[];

/** Fills every store with something worth backing up. */
async function populate(): Promise<void> {
  localStorage.setItem(LS_KEYS.keys, JSON.stringify(keysFile([{ id: 'k1', secret: SECRET }])));
  core.settings.update((d) => {
    d.defaultKeyId = 'k1';
    d.appearance.theme = 'dark';
    d.budgets.monthlyUsd = 20;
    d.tools.chat = { model: 'm/chat', options: { temperature: 0.3 } };
    d.models.favourites = ['a/b'];
  });
  await core.prompts.save({ tool: 'chat', text: 'saved one', settings: { t: 1 }, name: 'S1' });
  await core.prompts.addRecent('ocr', 'recent one', { lang: 'en' });
  const run = await core.runs.begin({ tool: 'chat', model: 'm/paid', prompt: 'hello' });
  run.addUsage({
    model: 'm/paid',
    promptTokens: 5,
    completionTokens: 7,
    costUsd: 0.01,
    costEstimated: false,
    latencyMs: 300,
  });
  await run.finish({ output: 'world' });
  await core.jobs.add({ tool: 'video-studio', type: 'video', payload: { p: 1 }, keyId: 'k1' });
  await core.toolState('video-studio').set('sequence', { steps: ['a', 'b'] });
  await (await getDb()).put('kv', { key: 'models:catalog', value: ['cached'], updatedAt: 1 });
}

/** Everything a backup is supposed to carry, in comparable form. */
async function snapshot() {
  const db = await getDb();
  const byId = <T extends { id: string }>(items: T[]) =>
    [...items].sort((a, b) => a.id.localeCompare(b.id));
  const prompts = await db.getAll('prompts');
  return {
    settings: core.settings.get(),
    keys: storedKeys(),
    savedPrompts: byId(prompts.filter((p) => p.kind === 'saved')),
    recentPrompts: byId(prompts.filter((p) => p.kind === 'recent')),
    runs: byId(await db.getAll('runs')),
    jobs: byId(await db.getAll('jobs')),
    toolState: await db.getAll('kv', prefixRange('tool:')),
    stats: await db.getAll('stats'),
  };
}

const parse = async (blob: Blob): Promise<BackupFile> =>
  JSON.parse(await blob.text()) as BackupFile;

beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
  sessionStorage.clear();
  core = createTestCore({ keys: [fakeKey({ id: 'k1', name: 'Key k1' })] }).core;
  events = [];
  for (const type of [
    'settings-changed',
    'keys-changed',
    'history-changed',
    'prompts-changed',
    'stats-changed',
    'jobs-changed',
  ] as const) {
    core.bus.on(type, (event) => events.push(event));
  }
});

describe('stage 1 gate: keys never leak', () => {
  it.each(['all', 'settings'] as const)(
    'a %s backup without opt-in contains no key material',
    async (scope) => {
      await populate();
      const text = await (await core.backup.export({ scope, includeKeys: false })).text();
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('sk-or-v1');
      expect(JSON.parse(text)).not.toHaveProperty('keys');
    },
  );

  it('an opted-in backup holds the keys only inside a passphrase envelope', async () => {
    await populate();
    const blob = await core.backup.export({ scope: 'all', includeKeys: true, passphrase: 'pw 1' });
    const text = await blob.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('sk-or-v1');
    const file = JSON.parse(text) as BackupFile;
    expect(Object.keys(file.keys ?? {}).sort()).toEqual(['ct', 'iterations', 'iv', 'salt']);
    const plain = await decryptWithPassphrase('pw 1', file.keys as PassphraseEnvelope);
    expect(plain).toBe(localStorage.getItem(LS_KEYS.keys));
  });

  it('with the key lock on, the already-encrypted secrets are wrapped again', async () => {
    const locked = keysFile([{ id: 'k1', secret: SECRET }], {
      salt: 'c2FsdA==',
      iterations: 1000,
      verifier: { iv: 'aXY=', ct: 'dmVyaWZpZXI=' },
    });
    localStorage.setItem(LS_KEYS.keys, JSON.stringify(locked));
    const text = await (
      await core.backup.export({ scope: 'settings', includeKeys: true, passphrase: 'pw' })
    ).text();
    expect(text).not.toContain(`cipher-${SECRET}`);
    expect(text).not.toContain('dmVyaWZpZXI=');
  });

  it('refuses to include keys without a passphrase', async () => {
    await expect(
      core.backup.export({ scope: 'settings', includeKeys: true, passphrase: '' }),
    ).rejects.toBeInstanceOf(BackupError);
  });
});

describe('stage 1 gate: backup → wipe → restore', () => {
  it.each(['replace', 'merge'] as const)(
    'restores identical settings, prompts, history, keys file and the rest (%s)',
    async (mode) => {
      await populate();
      const before = await snapshot();
      const blob = await core.backup.export({
        scope: 'all',
        includeKeys: true,
        passphrase: 'correct horse',
      });

      await core.data.resetEverything();
      const wiped = await snapshot();
      expect(wiped.runs).toEqual([]);
      expect(wiped.keys).toBeNull();

      await core.backup.import(blob, { mode, passphrase: 'correct horse' });
      expect(await snapshot()).toEqual(before);
      expect((await (await getDb()).get('kv', 'models:catalog'))?.value).toBeUndefined();
    },
  );

  it('a wrong passphrase gives a clear error and imports nothing', async () => {
    await populate();
    const blob = await core.backup.export({ scope: 'all', includeKeys: true, passphrase: 'right' });
    await core.data.resetEverything();
    const wiped = await snapshot();

    const opts = { mode: 'replace', passphrase: 'wrong' } as const;
    for (const call of [
      () => core.backup.inspect(blob, opts),
      () => core.backup.import(blob, opts),
    ]) {
      const error = (await call().catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(BackupError);
      expect(error.message).toMatch(/^Wrong passphrase.*Nothing was imported\.$/);
    }
    expect(await snapshot()).toEqual(wiped);
  });

  it('without a passphrase, imports everything but the keys', async () => {
    await populate();
    const blob = await core.backup.export({ scope: 'all', includeKeys: true, passphrase: 'pw' });
    const before = await snapshot();
    await core.data.resetEverything();
    localStorage.setItem(LS_KEYS.keys, JSON.stringify(keysFile([{ id: 'local', secret: 'x' }])));

    const preview = await core.backup.import(blob, { mode: 'replace' });

    expect(preview.changes).toContain('Skip keys (enter the backup passphrase to import them)');
    expect(preview.keysIncluded).toBe(true);
    const after = await snapshot();
    expect(after.keys).toEqual(keysFile([{ id: 'local', secret: 'x' }]));
    expect(after.settings.defaultKeyId).toBeNull(); // the backup's k1 does not exist here
    expect(after.runs).toEqual(before.runs);
    expect(after.savedPrompts).toEqual(before.savedPrompts);
  });
});

describe('inspect', () => {
  it('previews counts and a human-readable change list', async () => {
    await populate();
    const blob = await core.backup.export({ scope: 'all', includeKeys: true, passphrase: 'pw' });
    await core.data.resetEverything();

    const preview = await core.backup.inspect(blob, { mode: 'replace', passphrase: 'pw' });
    expect(preview).toMatchObject({
      scope: 'all',
      keysIncluded: true,
      keysEncrypted: true,
      counts: { keys: 1, runs: 1, prompts: 3, jobs: 1, toolState: 1, statsRows: 1 },
    });
    expect(preview.changes[0]).toMatch(/^Replace all settings \(\d+ settings differ\)$/);
    expect(preview.changes.slice(1)).toEqual([
      'Add 1 key',
      'Add 1 saved prompt',
      'Add 1 run',
      'Add 2 recent prompts',
      'Add 1 job',
      'Add 1 tool state entry',
      'Add 1 stats row',
    ]);
    expect(await snapshot()).toMatchObject({ runs: [], keys: null }); // inspect writes nothing
  });

  it('describes a merge over existing data', async () => {
    await populate();
    const blob = await core.backup.export({ scope: 'all', includeKeys: false });
    await core.prompts.save({ tool: 'ocr', text: 'local only', settings: {} });
    const preview = await core.backup.inspect(blob, { mode: 'merge' });
    expect(preview.keysIncluded).toBe(false);
    expect(preview.changes).toEqual([
      'Settings unchanged',
      "Overwrite 1 saved prompt with the backup's copy",
      "Overwrite 1 run with the backup's copy",
      "Overwrite 2 recent prompts with the backup's copy",
      "Overwrite 1 job with the backup's copy",
      "Overwrite 1 tool state entry with the backup's copy",
      "Overwrite 1 stats row with the backup's copy",
    ]);
  });

  it.each([
    ['not JSON', '{oops', 'not valid JSON'],
    ['another format', JSON.stringify({ format: 'something-else' }), 'not an ORtoolbox backup'],
    [
      'a newer version',
      JSON.stringify({ format: 'ortoolbox-backup', version: 2 }),
      'newer version of ORtoolbox',
    ],
    [
      'a damaged file',
      JSON.stringify({ format: 'ortoolbox-backup', version: 1, scope: 'all', savedPrompts: [] }),
      'damaged',
    ],
  ])('rejects %s', async (_label, text, message) => {
    const error = (await core.backup
      .inspect(new Blob([text]), { mode: 'merge' })
      .catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(BackupError);
    expect(error.message).toContain(message);
  });

  it('drops invalid records but keeps the valid ones', async () => {
    const file = {
      format: 'ortoolbox-backup',
      version: 1,
      createdAt: 5,
      appVersion: 'x',
      scope: 'settings',
      settings: { appearance: { theme: 'neon' } },
      savedPrompts: [
        {
          id: 'ok',
          tool: 'chat',
          kind: 'saved',
          name: null,
          text: 't',
          settings: {},
          createdAt: 1,
          usedAt: 1,
        },
        {
          id: 'bad-tool',
          tool: 'nope',
          kind: 'saved',
          text: 't',
          settings: {},
          createdAt: 1,
          usedAt: 1,
        },
        'junk',
      ],
    };
    const preview = await core.backup.import(new Blob([JSON.stringify(file)]), { mode: 'merge' });
    expect(preview.counts.prompts).toBe(1);
    expect((await core.prompts.list('chat', 'saved')).map((p) => p.id)).toEqual(['ok']);
    expect(core.settings.get().appearance.theme).toBe('system');
  });
});

describe('import modes', () => {
  it('merge: imported settings win field by field, records are upserted', async () => {
    await populate();
    const blob = await core.backup.export({ scope: 'all', includeKeys: false });
    const [backupRun] = await core.history.query();

    core.settings.update((d) => {
      d.appearance.theme = 'light';
      d.tools.ocr = { model: 'm/ocr' };
      d.ui['home.view'] = 'list';
    });
    await core.history.setStarred(backupRun!.id, true);
    const local = await core.runs.begin({ tool: 'ocr', model: 'm/x', prompt: 'local run' });
    await local.finish();

    await core.backup.import(blob, { mode: 'merge' });

    const settings = core.settings.get();
    expect(settings.appearance.theme).toBe('dark');
    expect(settings.tools).toEqual({
      chat: { model: 'm/chat', options: { temperature: 0.3 } },
      ocr: { model: 'm/ocr' },
    });
    expect(settings.ui).toEqual({ 'home.view': 'list' });
    const runs = await core.history.query();
    expect(runs.map((r) => r.id).sort()).toEqual([backupRun!.id, local.id].sort());
    expect((await core.history.get(backupRun!.id))?.starred).toBe(false); // the backup's copy
  });

  it('merge: keys are upserted when both sides use the same lock', async () => {
    localStorage.setItem(LS_KEYS.keys, JSON.stringify(keysFile([{ id: 'k1', secret: 'new' }])));
    const source = createTestCore().core;
    const blob = await source.backup.export({
      scope: 'settings',
      includeKeys: true,
      passphrase: 'p',
    });
    localStorage.setItem(
      LS_KEYS.keys,
      JSON.stringify(
        keysFile([
          { id: 'k1', secret: 'old' },
          { id: 'k9', secret: 'other' },
        ]),
      ),
    );

    const preview = await core.backup.import(blob, { mode: 'merge', passphrase: 'p' });
    expect(preview.changes).toContain("Overwrite 1 key with the backup's copy");
    expect(storedKeys()).toEqual(
      keysFile([
        { id: 'k1', secret: 'new' },
        { id: 'k9', secret: 'other' },
      ]),
    );
    expect(events).toContainEqual({ type: 'keys-changed' });
  });

  it('merge: keys behind a different lock are skipped', async () => {
    const lockA = { salt: 'YQ==', iterations: 1, verifier: { iv: 'aQ==', ct: 'YQ==' } };
    localStorage.setItem(LS_KEYS.keys, JSON.stringify(keysFile([{ id: 'k1', secret: 's' }])));
    const blob = await core.backup.export({
      scope: 'settings',
      includeKeys: true,
      passphrase: 'p',
    });
    const local = keysFile([{ id: 'k2', secret: 't' }], lockA);
    localStorage.setItem(LS_KEYS.keys, JSON.stringify(local));
    sessionStorage.setItem(SS_KEYS.unlocked, 'material');

    const preview = await core.backup.import(blob, { mode: 'merge', passphrase: 'p' });
    expect(
      preview.changes.some((c) => c.startsWith('Skip keys: the backup and this browser')),
    ).toBe(true);
    expect(storedKeys()).toEqual(local);
    expect(sessionStorage.getItem(SS_KEYS.unlocked)).toBe('material');
  });

  it('replace: taking keys behind another lock clears unlocked material', async () => {
    localStorage.setItem(LS_KEYS.keys, JSON.stringify(keysFile([{ id: 'k1', secret: 's' }])));
    const blob = await core.backup.export({
      scope: 'settings',
      includeKeys: true,
      passphrase: 'p',
    });
    const lockA = { salt: 'YQ==', iterations: 1, verifier: { iv: 'aQ==', ct: 'YQ==' } };
    localStorage.setItem(
      LS_KEYS.keys,
      JSON.stringify(keysFile([{ id: 'k2', secret: 't' }], lockA)),
    );
    sessionStorage.setItem(SS_KEYS.unlocked, 'material');

    await core.backup.import(blob, { mode: 'replace', passphrase: 'p' });
    expect(storedKeys()).toEqual(keysFile([{ id: 'k1', secret: 's' }]));
    expect(sessionStorage.getItem(SS_KEYS.unlocked)).toBeNull();
  });

  it('replace of a settings backup without keys keeps local keys and history', async () => {
    await populate();
    const blob = await core.backup.export({ scope: 'settings', includeKeys: false });
    await core.prompts.save({ tool: 'ocr', text: 'local saved', settings: {} });
    core.settings.update((d) => {
      d.freeOnly = true;
    });
    const before = await snapshot();
    events.length = 0;

    await core.backup.import(blob, { mode: 'replace' });

    const after = await snapshot();
    expect(after.keys).toEqual(before.keys);
    expect(after.settings.defaultKeyId).toBe('k1');
    expect(after.settings.freeOnly).toBe(false);
    expect(after.runs).toEqual(before.runs);
    expect(after.recentPrompts).toEqual(before.recentPrompts);
    expect(after.savedPrompts.map((p) => p.text)).toEqual(['saved one']);
    expect(events.map((e) => e.type)).toEqual(['settings-changed', 'prompts-changed']);
  });

  it('announces every kind of change after a full import', async () => {
    await populate();
    const blob = await core.backup.export({ scope: 'all', includeKeys: true, passphrase: 'p' });
    events.length = 0;
    await core.backup.import(blob, { mode: 'replace', passphrase: 'p' });
    expect(new Set(events.map((e) => e.type))).toEqual(
      new Set([
        'keys-changed',
        'prompts-changed',
        'history-changed',
        'stats-changed',
        'jobs-changed',
      ]),
    );
  });

  it('stamps the format header', async () => {
    const file = await parse(await core.backup.export({ scope: 'settings', includeKeys: false }));
    expect(file).toMatchObject({
      format: 'ortoolbox-backup',
      version: 1,
      scope: 'settings',
      appVersion: expect.any(String) as string,
      createdAt: expect.any(Number) as number,
    });
    expect(file).not.toHaveProperty('runs');
  });
});
