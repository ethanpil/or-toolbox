/**
 * Backup and restore as a `.ortoolbox.json` file:
 * `{ format: 'ortoolbox-backup', version: 1, createdAt, appVersion, scope, settings, savedPrompts, keys?,
 *    runs?, recentPrompts?, jobs?, toolState?, stats? }`.
 *
 * - Scope `settings`: settings and saved prompts (plus keys when opted in). Scope `all` adds history,
 *   recent prompts, jobs, tool state and stats rows.
 * - Keys are included only on request, always as a passphrase envelope (crypto.ts) around the exact JSON
 *   stored under `ortoolbox:keys`. With the key lock on, the secrets inside are encrypted a second time.
 * - Import `merge`: imported settings win field by field; records are upserted by id. `replace`: the
 *   backup's scope is wiped first, then imported. Keys are wiped only when the backup carries keys, so a
 *   settings restore never deletes keys it cannot replace.
 * - Everything is decoded and validated before the first write: a wrong passphrase imports nothing.
 *   Without a passphrase, the keys are skipped and the rest is imported.
 */

import type {
  BackupPreview,
  BackupService,
  CoreServices,
  JobRecord,
  PromptEntry,
  RunRecord,
  Settings,
  StoredKeysFile,
} from '../types';
import { TOOL_IDS } from '../../tools/types';
import { decryptWithPassphrase, encryptWithPassphrase, type PassphraseEnvelope } from '../crypto';
import { getDb, type KvEntry, type StoredStatsRow } from '../storage/db';
import {
  LS_KEYS,
  SS_KEYS,
  local,
  readJson,
  removeItem,
  session,
  writeJson,
} from '../storage/local';
import { deepMerge, isPlainObject, jsonCopy } from '../settings/merge';
import { normalizeSettings } from '../settings/schema';
import { TOOL_STATE_PREFIX, prefixRange } from '../tool-state';
import { version as APP_VERSION } from '../../../package.json';

export const BACKUP_FORMAT = 'ortoolbox-backup';
export const BACKUP_VERSION = 1;

/** A backup that cannot be read or decrypted. `message` is safe to show. */
export class BackupError extends Error {
  override readonly name = 'BackupError';
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: number;
  appVersion: string;
  scope: 'all' | 'settings';
  settings: Settings;
  savedPrompts: PromptEntry[];
  keys?: PassphraseEnvelope;
  runs?: RunRecord[];
  recentPrompts?: PromptEntry[];
  jobs?: JobRecord[];
  toolState?: KvEntry[];
  stats?: StoredStatsRow[];
}

const EMPTY_KEYS: StoredKeysFile = { version: 1, keys: [], lock: null };

// --- validation ------------------------------------------------------------------------------------

const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isToolId = (value: unknown): boolean =>
  isString(value) && (TOOL_IDS as readonly string[]).includes(value);

function validPrompt(value: unknown): value is PromptEntry {
  return (
    isPlainObject(value) &&
    isString(value['id']) &&
    isToolId(value['tool']) &&
    (value['kind'] === 'recent' || value['kind'] === 'saved') &&
    (value['name'] === null || isString(value['name'])) &&
    isString(value['text']) &&
    isPlainObject(value['settings']) &&
    isNumber(value['createdAt']) &&
    isNumber(value['usedAt'])
  );
}

function validRun(value: unknown): value is RunRecord {
  return (
    isPlainObject(value) &&
    isString(value['id']) &&
    isToolId(value['tool']) &&
    ['running', 'ok', 'error', 'aborted'].includes(value['status'] as string) &&
    isString(value['model']) &&
    Array.isArray(value['models']) &&
    isNumber(value['startedAt']) &&
    isPlainObject(value['usage'])
  );
}

function validJob(value: unknown): value is JobRecord {
  return (
    isPlainObject(value) &&
    isString(value['id']) &&
    isToolId(value['tool']) &&
    isString(value['type']) &&
    ['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(value['state'] as string) &&
    isNumber(value['createdAt'])
  );
}

function validToolState(value: unknown): value is KvEntry {
  return (
    isPlainObject(value) &&
    isString(value['key']) &&
    value['key'].startsWith(TOOL_STATE_PREFIX) &&
    'value' in value
  );
}

function validStatsRow(value: unknown): value is StoredStatsRow {
  return (
    isPlainObject(value) &&
    isString(value['key']) &&
    isString(value['day']) &&
    /^\d{4}-\d{2}-\d{2}$/.test(value['day']) &&
    isToolId(value['tool']) &&
    isString(value['model']) &&
    isString(value['keyId']) &&
    ['runs', 'errors', 'requests', 'promptTokens', 'completionTokens', 'costUsd', 'latencyMsTotal']
      .map((field) => value[field])
      .every(isNumber)
  );
}

function validEnvelope(value: unknown): value is PassphraseEnvelope {
  return (
    isPlainObject(value) &&
    isString(value['salt']) &&
    isNumber(value['iterations']) &&
    isString(value['iv']) &&
    isString(value['ct'])
  );
}

function validKeysFile(value: unknown): value is StoredKeysFile {
  return isPlainObject(value) && value['version'] === 1 && Array.isArray(value['keys']);
}

/** Records of an optional list that pass `valid`; anything else in the list is dropped. */
function records<T>(value: unknown, valid: (item: unknown) => item is T): T[] | undefined {
  return Array.isArray(value) ? value.filter(valid) : undefined;
}

async function parseBackup(blob: Blob): Promise<BackupFile> {
  let data: unknown;
  try {
    data = JSON.parse(await blob.text());
  } catch {
    throw new BackupError('This file is not an ORtoolbox backup: it is not valid JSON.');
  }
  if (!isPlainObject(data) || data['format'] !== BACKUP_FORMAT) {
    throw new BackupError('This file is not an ORtoolbox backup.');
  }
  const version = data['version'];
  if (isNumber(version) && version > BACKUP_VERSION) {
    throw new BackupError(
      'This backup was made by a newer version of ORtoolbox. Reload the page to update, then try again.',
    );
  }
  if (version !== BACKUP_VERSION) throw new BackupError('This backup version is not supported.');
  const scope = data['scope'];
  if (
    (scope !== 'all' && scope !== 'settings') ||
    !isPlainObject(data['settings']) ||
    !Array.isArray(data['savedPrompts']) ||
    (data['keys'] !== undefined && !validEnvelope(data['keys']))
  ) {
    throw new BackupError('This backup file is damaged.');
  }
  const prompts = (value: unknown, kind: PromptEntry['kind']) =>
    records(value, validPrompt)?.filter((entry) => entry.kind === kind);

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: isNumber(data['createdAt']) ? data['createdAt'] : 0,
    appVersion: isString(data['appVersion']) ? data['appVersion'] : 'unknown',
    scope,
    settings: normalizeSettings(data['settings']),
    savedPrompts: prompts(data['savedPrompts'], 'saved') ?? [],
    keys: data['keys'],
    ...(scope === 'all' && {
      runs: records(data['runs'], validRun) ?? [],
      recentPrompts: prompts(data['recentPrompts'], 'recent') ?? [],
      jobs: records(data['jobs'], validJob) ?? [],
      toolState: records(data['toolState'], validToolState) ?? [],
      stats: records(data['stats'], validStatsRow) ?? [],
    }),
  };
}

/** The decrypted keys file; null when the backup has none or no passphrase was given. */
async function decodeKeys(
  file: BackupFile,
  passphrase: string | undefined,
): Promise<StoredKeysFile | null> {
  if (!file.keys || !passphrase) return null;
  let plain: string;
  try {
    plain = await decryptWithPassphrase(passphrase, file.keys);
  } catch {
    throw new BackupError(
      'Wrong passphrase: the keys in this backup could not be decrypted. Nothing was imported.',
    );
  }
  let keys: unknown;
  try {
    keys = JSON.parse(plain);
  } catch {
    keys = null;
  }
  if (!validKeysFile(keys)) throw new BackupError('The keys in this backup are damaged.');
  return keys;
}

// --- change descriptions ---------------------------------------------------------------------------

type Noun = [one: string, many: string];
const N = {
  setting: ['setting', 'settings'],
  key: ['key', 'keys'],
  saved: ['saved prompt', 'saved prompts'],
  recent: ['recent prompt', 'recent prompts'],
  run: ['run', 'runs'],
  job: ['job', 'jobs'],
  toolState: ['tool state entry', 'tool state entries'],
  stats: ['stats row', 'stats rows'],
} satisfies Record<string, Noun>;

const plural = (count: number, [one, many]: Noun): string => `${count} ${count === 1 ? one : many}`;

function replaceLine(current: number, incoming: number, noun: Noun): string | null {
  if (current === 0 && incoming === 0) return null;
  if (current === 0) return `Add ${plural(incoming, noun)}`;
  if (incoming === 0) return `Delete ${plural(current, noun)}`;
  return `Replace ${plural(current, noun)} with ${incoming} from the backup`;
}

function mergeLines(currentIds: Set<string>, incomingIds: string[], noun: Noun): string[] {
  const existing = incomingIds.filter((id) => currentIds.has(id)).length;
  const added = incomingIds.length - existing;
  const lines: string[] = [];
  if (added > 0) lines.push(`Add ${plural(added, noun)}`);
  if (existing > 0) lines.push(`Overwrite ${plural(existing, noun)} with the backup's copy`);
  return lines;
}

/** Number of differing leaves between two settings objects (arrays count as one leaf). */
function diffCount(a: unknown, b: unknown): number {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].reduce((sum, key) => sum + diffCount(a[key], b[key]), 0);
  }
  return JSON.stringify(a) === JSON.stringify(b) ? 0 : 1;
}

const sameLock = (a: StoredKeysFile['lock'], b: StoredKeysFile['lock']): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

// --- service ---------------------------------------------------------------------------------------

export function createBackupService(core: CoreServices): BackupService {
  /** Validates and decodes the file, then describes and (optionally) applies the import. */
  const prepare = async (
    blob: Blob,
    opts: { mode: 'merge' | 'replace'; passphrase?: string },
  ): Promise<{ preview: BackupPreview; apply: () => Promise<void> }> => {
    const file = await parseBackup(blob);
    const importedKeys = await decodeKeys(file, opts.passphrase);
    const replace = opts.mode === 'replace';
    const all = file.scope === 'all';
    const keyChanges: string[] = [];
    const changes: string[] = [];

    // Keys (decided first: the default key setting depends on whether they are taken).
    const currentKeys = readJson<StoredKeysFile>(local(), LS_KEYS.keys) ?? EMPTY_KEYS;
    let nextKeys: StoredKeysFile | null = null;
    if (file.keys && !importedKeys) {
      keyChanges.push('Skip keys (enter the backup passphrase to import them)');
    } else if (importedKeys) {
      if (replace || currentKeys.keys.length === 0) {
        nextKeys = importedKeys;
        const line = replaceLine(
          replace ? currentKeys.keys.length : 0,
          importedKeys.keys.length,
          N.key,
        );
        if (line) keyChanges.push(line);
      } else if (sameLock(currentKeys.lock, importedKeys.lock)) {
        const byId = new Map(currentKeys.keys.map((key) => [key.id, key]));
        for (const key of importedKeys.keys) byId.set(key.id, key);
        nextKeys = { ...currentKeys, keys: [...byId.values()] };
        keyChanges.push(
          ...mergeLines(
            new Set(currentKeys.keys.map((key) => key.id)),
            importedKeys.keys.map((key) => key.id),
            N.key,
          ),
        );
      } else {
        keyChanges.push(
          'Skip keys: the backup and this browser protect keys with different passphrase locks (use Replace to take the backup’s keys)',
        );
      }
    }

    // Settings. The default key follows the backup only when its keys are taken.
    const current = core.settings.get();
    const takeDefaultKey = nextKeys !== null && (replace || file.settings.defaultKeyId !== null);
    const nextSettings = normalizeSettings({
      ...(replace
        ? file.settings
        : deepMerge(
            jsonCopy(current),
            jsonCopy(file.settings) as unknown as Record<string, unknown>,
          )),
      defaultKeyId: takeDefaultKey ? file.settings.defaultKeyId : current.defaultKeyId,
    });
    const settingsDiff = diffCount(current, nextSettings);
    changes.push(
      settingsDiff === 0
        ? 'Settings unchanged'
        : replace
          ? `Replace all settings (${plural(settingsDiff, N.setting)} differ)`
          : `Change ${plural(settingsDiff, N.setting)}`,
      ...keyChanges,
    );

    // Records.
    const db = await getDb();
    const prompts = await db.getAll('prompts');
    const savedIds = new Set(prompts.filter((p) => p.kind === 'saved').map((p) => p.id));
    const recentIds = new Set(prompts.filter((p) => p.kind === 'recent').map((p) => p.id));
    const [runIds, jobIds, kvKeys, statsKeys] = await Promise.all([
      db.getAllKeys('runs'),
      db.getAllKeys('jobs'),
      db.getAllKeys('kv', prefixRange(TOOL_STATE_PREFIX)),
      db.getAllKeys('stats'),
    ]);
    const describe = (currentIds: Set<string>, incomingIds: string[], noun: Noun): void => {
      if (replace) {
        const line = replaceLine(currentIds.size, incomingIds.length, noun);
        if (line) changes.push(line);
      } else {
        changes.push(...mergeLines(currentIds, incomingIds, noun));
      }
    };
    describe(
      savedIds,
      file.savedPrompts.map((p) => p.id),
      N.saved,
    );
    if (all) {
      describe(
        new Set(runIds),
        (file.runs ?? []).map((r) => r.id),
        N.run,
      );
      describe(
        recentIds,
        (file.recentPrompts ?? []).map((p) => p.id),
        N.recent,
      );
      describe(
        new Set(jobIds),
        (file.jobs ?? []).map((j) => j.id),
        N.job,
      );
      describe(
        new Set(kvKeys),
        (file.toolState ?? []).map((e) => e.key),
        N.toolState,
      );
      describe(
        new Set(statsKeys),
        (file.stats ?? []).map((s) => s.key),
        N.stats,
      );
    }

    const preview: BackupPreview = {
      createdAt: file.createdAt,
      appVersion: file.appVersion,
      scope: file.scope,
      keysIncluded: file.keys !== undefined,
      keysEncrypted: file.keys !== undefined,
      counts: {
        keys: importedKeys?.keys.length ?? 0,
        runs: file.runs?.length ?? 0,
        prompts: file.savedPrompts.length + (file.recentPrompts?.length ?? 0),
        jobs: file.jobs?.length ?? 0,
        toolState: file.toolState?.length ?? 0,
        statsRows: file.stats?.length ?? 0,
      },
      changes,
    };

    const apply = async (): Promise<void> => {
      const stores: ('runs' | 'prompts' | 'jobs' | 'kv' | 'stats')[] = all
        ? ['runs', 'prompts', 'jobs', 'kv', 'stats']
        : ['prompts'];
      const tx = db.transaction(stores, 'readwrite');
      const promptStore = tx.objectStore('prompts');
      const writes: Promise<unknown>[] = [];
      if (replace) {
        for (const p of prompts) {
          if (p.kind === 'saved' || all) writes.push(promptStore.delete(p.id));
        }
      }
      for (const p of [...file.savedPrompts, ...(file.recentPrompts ?? [])]) {
        writes.push(promptStore.put(p));
      }
      if (all) {
        const runs = tx.objectStore('runs');
        const jobs = tx.objectStore('jobs');
        const kv = tx.objectStore('kv');
        const stats = tx.objectStore('stats');
        if (replace) {
          writes.push(
            runs.clear(),
            jobs.clear(),
            stats.clear(),
            ...kvKeys.map((key) => kv.delete(key)),
          );
        }
        for (const run of file.runs ?? []) writes.push(runs.put(run));
        for (const job of file.jobs ?? []) writes.push(jobs.put(job));
        for (const entry of file.toolState ?? []) writes.push(kv.put(entry));
        for (const row of file.stats ?? []) writes.push(stats.put(row));
      }
      await Promise.all([...writes, tx.done]);

      if (nextKeys) {
        writeJson(local(), LS_KEYS.keys, nextKeys);
        // Material unlocked with another passphrase cannot open the new keys.
        if (!sameLock(currentKeys.lock, nextKeys.lock)) removeItem(session(), SS_KEYS.unlocked);
        core.bus.emit({ type: 'keys-changed' });
      }
      core.settings.update((draft) => {
        Object.assign(draft, jsonCopy(nextSettings));
      });

      core.bus.emit({ type: 'prompts-changed', tool: 'all' });
      if (all) {
        core.bus.emit({ type: 'history-changed' });
        core.bus.emit({ type: 'stats-changed' });
        const touched = new Set([
          ...(replace ? jobIds : []),
          ...(file.jobs ?? []).map((j) => j.id),
        ]);
        for (const id of touched) core.bus.emit({ type: 'jobs-changed', id });
      }
    };

    return { preview, apply };
  };

  return {
    async export(opts) {
      const db = await getDb();
      const prompts = await db.getAll('prompts');
      const file: BackupFile = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        createdAt: Date.now(),
        appVersion: APP_VERSION,
        scope: opts.scope,
        settings: jsonCopy(core.settings.get()),
        savedPrompts: prompts.filter((p) => p.kind === 'saved'),
      };
      if (opts.includeKeys) {
        if (!opts.passphrase) {
          throw new BackupError('Choose a passphrase to protect the keys in this backup.');
        }
        let raw: string | null;
        try {
          raw = local()?.getItem(LS_KEYS.keys) ?? null;
        } catch {
          raw = null;
        }
        file.keys = await encryptWithPassphrase(opts.passphrase, raw ?? JSON.stringify(EMPTY_KEYS));
      }
      if (opts.scope === 'all') {
        file.runs = await db.getAll('runs');
        file.recentPrompts = prompts.filter((p) => p.kind === 'recent');
        file.jobs = await db.getAll('jobs');
        file.toolState = await db.getAll('kv', prefixRange(TOOL_STATE_PREFIX));
        file.stats = await db.getAll('stats');
      }
      return new Blob([JSON.stringify(file)], { type: 'application/json' });
    },

    async inspect(blob, opts) {
      return (await prepare(blob, opts)).preview;
    },

    async import(blob, opts) {
      const { preview, apply } = await prepare(blob, opts);
      await apply();
      return preview;
    },
  };
}
