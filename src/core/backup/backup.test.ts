import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CryptoModule from '../crypto';
import { decryptWithPassphrase, type PassphraseEnvelope } from '../crypto';
import { BackupError, type BackupFile } from '.';
import type {
  BusEvent,
  CoreServices,
  JobRecord,
  RunRecord,
  StatsRow,
  StoredKeysFile,
} from '../types';
import { KeysChangedError, WrongPassphraseError, errorCode } from '../errors';
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
    d.models.favorites = ['a/b'];
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
afterEach(() => vi.restoreAllMocks());

/** A hand-made v1 backup; every list defaults to empty. */
function backupBlob(fields: Record<string, unknown>): Blob {
  return new Blob([
    JSON.stringify({
      format: 'ortoolbox-backup',
      version: 1,
      createdAt: 1,
      appVersion: 'test',
      scope: 'all',
      settings: {},
      savedPrompts: [],
      runs: [],
      recentPrompts: [],
      jobs: [],
      toolState: [],
      stats: [],
      ...fields,
    }),
  ]);
}

function runRecord(id: string, partial: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    tool: 'chat',
    status: 'ok',
    model: 'm/x',
    models: ['m/x'],
    keyId: 'k1',
    keyName: 'Work',
    startedAt: 100,
    finishedAt: 200,
    latencyMs: 100,
    title: id,
    prompt: null,
    settings: null,
    output: null,
    error: null,
    usage: {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      latencyMsTotal: 0,
      costEstimated: false,
      costUnknown: false,
      byModel: {},
    },
    reservedUsd: 0,
    jobId: null,
    meta: {},
    starred: false,
    groupId: null,
    ...partial,
  };
}

function jobRecord(id: string, partial: Partial<JobRecord> = {}): JobRecord {
  return {
    id,
    tool: 'video-studio',
    type: 'video',
    state: 'running',
    runId: null,
    keyId: 'k1',
    remoteId: 'r',
    groupId: null,
    payload: {},
    result: null,
    progress: null,
    remoteStatus: null,
    error: null,
    failureKind: null,
    createdAt: 1,
    updatedAt: 100,
    attempts: 0,
    ...partial,
  };
}

function statsRow(partial: Partial<StatsRow> = {}): StatsRow & { key: string } {
  const row: StatsRow = {
    day: '2026-10-01',
    tool: 'chat',
    model: 'm/x',
    keyId: 'k1',
    free: false,
    runs: 1,
    errors: 0,
    requests: 1,
    promptTokens: 1,
    completionTokens: 1,
    costUsd: 0.1,
    estimatedUsd: 0,
    latencyMsTotal: 10,
    ...partial,
  };
  return { ...row, key: `${row.day}|${row.tool}|${row.model}|${row.keyId}` };
}

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
      expect(error).toBeInstanceOf(WrongPassphraseError);
      expect(errorCode(error)).toBe('wrong-passphrase');
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
    expect(preview.changes).toEqual(['Settings unchanged']); // everything else is identical here
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
    expect(preview.changes).toContain('Skip 2 saved prompts (invalid records)');
    expect((await core.prompts.list('chat', 'saved')).map((p) => p.id)).toEqual(['ok']);
    expect(core.settings.get().appearance.theme).toBe('system');
  });
});

describe('import modes', () => {
  it('merge: imported settings win field by field, records are upserted when newer', async () => {
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
    // The backup's copy is not newer, so the local star survives.
    expect((await core.history.get(backupRun!.id))?.starred).toBe(true);
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
    expect(preview.changes).toContain('Update 1 key');
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

  it('tells open tools about every tool state key it wrote or removed, so they read it again', async () => {
    await core.toolState('chat').set('thread:local', { messages: [] });
    const changed: string[] = [];
    core.bus.on('tool-state-changed', ({ tool, key }) => changed.push(`${tool} ${key}`));
    const toolState = [
      { key: 'tool:video-studio:sequence', value: { steps: [] }, updatedAt: 5 },
      { key: 'tool:chat:thread:a', value: { messages: ['hi'] }, updatedAt: 5 },
    ];
    await core.backup.import(backupBlob({ toolState }), { mode: 'merge' });
    expect(changed.sort()).toEqual(['chat thread:a', 'video-studio sequence']);

    changed.length = 0;
    await core.backup.import(backupBlob({ toolState: toolState.slice(0, 1) }), {
      mode: 'replace',
    });
    expect(changed.sort()).toEqual(['chat thread:a', 'chat thread:local', 'video-studio sequence']);
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

describe('merge details', () => {
  it('only overrides the settings present in the file, and lists them', async () => {
    core.settings.update((d) => {
      d.freeOnly = true;
      d.appearance.theme = 'dark';
    });
    const blob = backupBlob({ scope: 'settings', settings: { appearance: { theme: 'light' } } });
    const preview = await core.backup.inspect(blob, { mode: 'merge' });
    expect(preview.changes[0]).toBe('Change 1 setting: appearance.theme');
    await core.backup.import(blob, { mode: 'merge' });
    expect(core.settings.get().appearance.theme).toBe('light');
    expect(core.settings.get().freeOnly).toBe(true);
  });

  it('keeps the larger value of each stats field and checks row keys', async () => {
    const local = statsRow({ costUsd: 0.5, requests: 5, runs: 2 });
    await (await getDb()).put('stats', local);
    const blob = backupBlob({
      stats: [
        statsRow({ costUsd: 0.3, requests: 7, runs: 9 }),
        { ...statsRow({ day: '2026-10-02' }), key: 'tampered' },
      ],
    });
    const preview = await core.backup.import(blob, { mode: 'merge' });
    expect(preview.changes).toContain('Update 1 stats row');
    expect(preview.changes).toContain('Skip 1 stats row (invalid records)');
    expect(await (await getDb()).getAll('stats')).toEqual([
      { ...local, requests: 7, runs: 9, costUsd: 0.5 },
    ]);
  });

  it('imports stats rows without the estimated part as 0, and keeps the larger estimated part', async () => {
    const local = statsRow({ costUsd: 0.5, estimatedUsd: 0.2 });
    await (await getDb()).put('stats', local);
    const old: Record<string, unknown> = { ...statsRow({ day: '2026-10-02' }) };
    delete old['estimatedUsd'];
    const blob = backupBlob({
      stats: [
        statsRow({ costUsd: 0.5, estimatedUsd: 0.4 }),
        old as unknown as StatsRow & { key: string },
      ],
    });
    await core.backup.import(blob, { mode: 'merge' });
    const rows = await (await getDb()).getAll('stats');
    expect(rows.map((r) => [r.day, r.estimatedUsd])).toEqual([
      ['2026-10-01', 0.4],
      ['2026-10-02', 0],
    ]);
  });

  it('runs: the newer copy wins, final runs stay final, running runs arrive aborted', async () => {
    const db = await getDb();
    await db.put('runs', runRecord('r1', { finishedAt: 200, output: 'local' }));
    await db.put('runs', runRecord('r2', { finishedAt: 200, output: 'local' }));
    await db.put('runs', runRecord('r3', { finishedAt: 300, output: 'local, newer' }));
    const blob = backupBlob({
      runs: [
        runRecord('r1', { finishedAt: 250, output: 'backup, newer' }),
        runRecord('r2', { status: 'running', finishedAt: null, output: 'backup' }),
        runRecord('r3', { finishedAt: 250, output: 'backup, older' }),
        runRecord('r4', { status: 'running', finishedAt: null, reservedUsd: 1 }),
      ],
    });
    const preview = await core.backup.import(blob, { mode: 'merge' });
    expect(preview.changes).toEqual(['Settings unchanged', 'Add 1 run', 'Update 1 run']);
    expect((await db.get('runs', 'r1'))?.output).toBe('backup, newer');
    expect((await db.get('runs', 'r2'))?.output).toBe('local');
    expect((await db.get('runs', 'r3'))?.output).toBe('local, newer');
    expect(await db.get('runs', 'r4')).toMatchObject({
      status: 'aborted',
      finishedAt: 100,
      error: 'Interrupted: this run was still going when the backup was made.',
    });
    expect(await db.getAllFromIndex('runs', 'status', 'running')).toEqual([]);
  });

  it('jobs: the newer copy wins and a final job never goes back to running', async () => {
    const db = await getDb();
    await db.put('jobs', jobRecord('j1', { state: 'succeeded', updatedAt: 100 }));
    await db.put('jobs', jobRecord('j2', { state: 'running', updatedAt: 100 }));
    const blob = backupBlob({
      jobs: [
        jobRecord('j1', { state: 'running', updatedAt: 200 }),
        jobRecord('j2', { state: 'running', updatedAt: 200, progress: 0.5 }),
      ],
    });
    await core.backup.import(blob, { mode: 'merge' });
    expect((await db.get('jobs', 'j1'))?.state).toBe('succeeded');
    expect((await db.get('jobs', 'j2'))?.progress).toBe(0.5);
  });

  it('prompts: the copy used more recently wins, so an older backup never overwrites newer local prompts', async () => {
    const db = await getDb();
    const prompt = (id: string, kind: 'saved' | 'recent', usedAt: number, text: string) => ({
      id,
      tool: 'chat' as const,
      kind,
      name: null,
      text,
      settings: {},
      createdAt: 1,
      usedAt,
    });
    await db.put('prompts', prompt('s1', 'saved', 300, 'local, newer'));
    await db.put('prompts', prompt('s2', 'saved', 100, 'local, older'));
    await db.put('prompts', prompt('r1', 'recent', 300, 'local, newer'));
    const blob = backupBlob({
      savedPrompts: [
        prompt('s1', 'saved', 200, 'backup, older'),
        prompt('s2', 'saved', 200, 'backup, newer'),
      ],
      recentPrompts: [prompt('r1', 'recent', 200, 'backup, older')],
    });
    const preview = await core.backup.import(blob, { mode: 'merge' });
    expect(preview.changes).toEqual(['Settings unchanged', 'Update 1 saved prompt']);
    expect((await db.get('prompts', 's1'))?.text).toBe('local, newer');
    expect((await db.get('prompts', 's2'))?.text).toBe('backup, newer');
    expect((await db.get('prompts', 'r1'))?.text).toBe('local, newer');
  });

  it('tool state: the copy written later wins', async () => {
    const db = await getDb();
    await db.put('kv', { key: 'tool:chat:thread:a', value: { v: 'local, newer' }, updatedAt: 300 });
    await db.put('kv', { key: 'tool:chat:thread:b', value: { v: 'local, older' }, updatedAt: 100 });
    const changed: string[] = [];
    core.bus.on('tool-state-changed', ({ key }) => changed.push(key));
    const blob = backupBlob({
      toolState: [
        { key: 'tool:chat:thread:a', value: { v: 'backup, older' }, updatedAt: 200 },
        { key: 'tool:chat:thread:b', value: { v: 'backup, newer' }, updatedAt: 200 },
      ],
    });
    const preview = await core.backup.import(blob, { mode: 'merge' });
    expect(preview.changes).toEqual(['Settings unchanged', 'Update 1 tool state entry']);
    expect((await db.get('kv', 'tool:chat:thread:a'))?.value).toEqual({ v: 'local, newer' });
    expect((await db.get('kv', 'tool:chat:thread:b'))?.value).toEqual({ v: 'backup, newer' });
    expect(changed).toEqual(['thread:b']);
  });

  it('merges favorites written under the old British names', async () => {
    core.settings.update((d) => {
      d.favoriteTools = ['ocr'];
      d.models.favorites = ['x/local'];
    });
    const blob = backupBlob({
      scope: 'settings',
      settings: { favouriteTools: ['chat'], models: { favourites: ['a/b'] } },
    });
    const preview = await core.backup.import(blob, { mode: 'merge' });
    expect(preview.changes[0]).toBe('Change 2 settings: favoriteTools, models.favorites');
    expect(core.settings.get().favoriteTools).toEqual(['chat']);
    expect(core.settings.get().models.favorites).toEqual(['a/b']);
  });

  it('drops key pins, per-key budgets and the default key for keys this browser lacks', async () => {
    localStorage.setItem(LS_KEYS.keys, JSON.stringify(keysFile([{ id: 'k1', secret: 's' }])));
    const blob = backupBlob({
      scope: 'settings',
      settings: {
        defaultKeyId: 'gone',
        tools: { chat: { keyId: 'gone', model: 'm' }, ocr: { keyId: 'k1' } },
        budgets: { perKeyMonthlyUsd: { gone: 5, lost: 1, k1: 2 } },
      },
    });
    const preview = await core.backup.import(blob, { mode: 'replace' });
    expect(preview.changes).toEqual(
      expect.arrayContaining([
        '1 tool key pin removed: its key is not in this browser',
        '2 per-key budgets removed: their keys are not in this browser',
      ]),
    );
    const settings = core.settings.get();
    expect(settings.tools).toEqual({ chat: { model: 'm' }, ocr: { keyId: 'k1' } });
    expect(settings.budgets.perKeyMonthlyUsd).toEqual({ k1: 2 });
    expect(settings.defaultKeyId).toBeNull();
  });

  it('never removes an existing passphrase lock', async () => {
    const lock = { salt: 'YQ==', iterations: 1, verifier: { iv: 'aQ==', ct: 'YQ==' } };
    localStorage.setItem(LS_KEYS.keys, JSON.stringify(keysFile([{ id: 'k1', secret: 's' }])));
    const blob = await core.backup.export({
      scope: 'settings',
      includeKeys: true,
      passphrase: 'p',
    });
    const local = keysFile([], lock); // lock on, no keys yet
    localStorage.setItem(LS_KEYS.keys, JSON.stringify(local));

    const preview = await core.backup.import(blob, { mode: 'merge', passphrase: 'p' });
    expect(
      preview.changes.some((c) => c.startsWith('Skip keys: the backup and this browser')),
    ).toBe(true);
    expect(storedKeys()).toEqual(local);
  });
});

describe('validation of imported files', () => {
  it('checks every field of every record and reports what was skipped', async () => {
    const blob = backupBlob({
      runs: [
        runRecord('ok'),
        { ...runRecord('bad'), usage: 'lots' },
        { ...runRecord('x'), title: 3 },
      ],
      jobs: [
        jobRecord('j'),
        { id: 'half', tool: 'chat' },
        { ...jobRecord('kind'), state: 'failed', failureKind: 'lost' },
        { ...jobRecord('noisy'), notify: 'always' },
      ],
      toolState: [
        { key: 'tool:chat:a', value: 1, updatedAt: 1 },
        { key: 'tool:chat:b', value: 1, updatedAt: 'yesterday' },
        { key: 'models:catalog', value: [], updatedAt: 1 },
      ],
      recentPrompts: [{ id: 'p', tool: 'chat', kind: 'recent', text: 'x', settings: {} }],
    });
    const preview = await core.backup.inspect(blob, { mode: 'merge' });
    expect(preview.counts).toMatchObject({ runs: 1, jobs: 1, toolState: 1, prompts: 0 });
    expect(preview.changes).toEqual(
      expect.arrayContaining([
        'Skip 2 runs (invalid records)',
        'Skip 3 jobs (invalid records)',
        'Skip 2 tool state entries (invalid records)',
        'Skip 1 recent prompt (invalid records)',
      ]),
    );
  });

  it('skips records whose times are outside the range a date can hold', async () => {
    const prompt = (id: string, usedAt: number) => ({
      id,
      tool: 'chat',
      kind: 'saved',
      name: null,
      text: 'x',
      settings: {},
      createdAt: 1,
      usedAt,
    });
    const blob = backupBlob({
      createdAt: 1e20,
      runs: [
        runRecord('ok'),
        runRecord('huge', { startedAt: 1e20 }),
        runRecord('late', { finishedAt: 8.64e15 + 1 }),
        runRecord('negative', { startedAt: -1 }),
      ],
      jobs: [jobRecord('j'), jobRecord('j-huge', { updatedAt: 1e20 })],
      toolState: [
        { key: 'tool:chat:a', value: 1, updatedAt: 1 },
        { key: 'tool:chat:b', value: 1, updatedAt: 1e20 },
      ],
      savedPrompts: [prompt('p', 1), prompt('p-huge', 1e20)],
    });
    const preview = await core.backup.import(blob, { mode: 'merge' });
    expect(preview.createdAt).toBe(0);
    expect(preview.counts).toMatchObject({ runs: 1, jobs: 1, toolState: 1, prompts: 1 });
    expect(preview.changes).toEqual(
      expect.arrayContaining([
        'Skip 3 runs (invalid records)',
        'Skip 1 job (invalid records)',
        'Skip 1 tool state entry (invalid records)',
        'Skip 1 saved prompt (invalid records)',
      ]),
    );
    const runs = await (await getDb()).getAll('runs');
    expect(runs.map((r) => r.id)).toEqual(['ok']);
  });

  it('fills fields that older backups did not have', async () => {
    const old: Partial<RunRecord> = runRecord('old');
    delete old.reservedUsd;
    delete old.jobId;
    delete (old.usage as Partial<RunRecord['usage']>).costUnknown;
    const oldJob: Partial<JobRecord> = jobRecord('old-job', { state: 'failed', error: 'x' });
    delete oldJob.failureKind;
    const kept = jobRecord('kept', { state: 'failed', failureKind: 'gave-up', notify: 'group' });
    await core.backup.import(backupBlob({ runs: [old], jobs: [oldJob, kept] }), { mode: 'merge' });
    expect(await (await getDb()).get('runs', 'old')).toEqual(runRecord('old'));
    expect(await (await getDb()).get('jobs', 'old-job')).toEqual(
      jobRecord('old-job', { state: 'failed', error: 'x' }),
    );
    expect(await (await getDb()).get('jobs', 'kept')).toEqual(kept);
  });

  it.each([
    ['too many', 1e9],
    ['zero', 0],
    ['fractional', 1.5],
  ])('refuses %s PBKDF2 iterations without trying them', async (_label, iterations) => {
    localStorage.setItem(LS_KEYS.keys, JSON.stringify(keysFile([{ id: 'k1', secret: 's' }])));
    const file = await parse(
      await core.backup.export({ scope: 'settings', includeKeys: true, passphrase: 'p' }),
    );
    file.keys = { ...file.keys!, iterations };
    const error = (await core.backup
      .inspect(new Blob([JSON.stringify(file)]), { mode: 'merge', passphrase: 'p' })
      .catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(BackupError);
    expect(error.message).toContain('damaged');
  });

  it('tells a damaged key envelope from a wrong passphrase', async () => {
    localStorage.setItem(LS_KEYS.keys, JSON.stringify(keysFile([{ id: 'k1', secret: 's' }])));
    const file = await parse(
      await core.backup.export({ scope: 'settings', includeKeys: true, passphrase: 'p' }),
    );
    file.keys = { ...file.keys!, ct: '%%% not base64 %%%' };
    const error = (await core.backup
      .inspect(new Blob([JSON.stringify(file)]), { mode: 'merge', passphrase: 'p' })
      .catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(BackupError);
    expect(error).not.toBeInstanceOf(WrongPassphraseError);
    expect(error.message).toContain('damaged');
  });
});

describe('atomic import', () => {
  async function changedSinceBackup(): Promise<Blob> {
    await populate();
    const blob = await core.backup.export({ scope: 'all', includeKeys: true, passphrase: 'pw' });
    core.settings.update((d) => {
      d.appearance.theme = 'light';
    });
    await core.prompts.save({ tool: 'ocr', text: 'made after the backup', settings: {} });
    localStorage.setItem(LS_KEYS.keys, JSON.stringify(keysFile([{ id: 'k7', secret: 'later' }])));
    return blob;
  }

  it('leaves everything as it was when the IndexedDB write fails', async () => {
    const blob = await changedSinceBackup();
    const before = await snapshot();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied with the right `this` below
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['put']>
    ) {
      if (this.name === 'stats') throw new DOMException('full', 'QuotaExceededError');
      return original.apply(this, args);
    });

    await expect(core.backup.import(blob, { mode: 'replace', passphrase: 'pw' })).rejects.toThrow();
    vi.restoreAllMocks();
    expect(await snapshot()).toEqual(before);
  });

  it('writes nothing when the keys changed in another tab meanwhile', async () => {
    const blob = await changedSinceBackup();
    const before = await snapshot();
    const replaceFile = vi.spyOn(core.keys, 'replaceFile').mockImplementation(() => {
      throw new KeysChangedError();
    });
    await expect(core.backup.import(blob, { mode: 'replace', passphrase: 'pw' })).rejects.toThrow(
      KeysChangedError,
    );
    expect(replaceFile).toHaveBeenCalledWith(expect.any(Object), {
      expected: keysFile([{ id: 'k7', secret: 'later' }]),
    });
    expect(await snapshot()).toEqual(before);
  });
});
