/**
 * Backup and restore as a `.ortoolbox.json` file:
 * `{ format: 'ortoolbox-backup', version: 1, createdAt, appVersion, scope, settings, savedPrompts, keys?,
 *    runs?, recentPrompts?, jobs?, toolState?, stats? }`.
 *
 * - Scope `settings`: settings and saved prompts (plus keys when opted in). Scope `all` adds history,
 *   recent prompts, jobs, tool state and stats rows.
 * - Keys are included only on request, always as a passphrase envelope (crypto.ts) around the keys file
 *   from `core.keys.exportFile()`. With the key lock on, the secrets inside are encrypted a second time.
 * - Every record is validated field by field; invalid ones are skipped and counted in the preview.
 * - Import `merge`: only the settings present in the file override current ones. Records are added when
 *   missing; existing ones are replaced only by a newer copy (runs by `finishedAt`, jobs by `updatedAt`),
 *   a final run or job never goes back to an earlier state, a run that is running here is never touched,
 *   and stats rows keep the larger value of each field (a backup of this same device must not double
 *   count). Keys are merged only when both sides use the same passphrase lock (or there is no lock and no
 *   key here yet): a merge never removes or swaps a lock.
 * - Import `replace`: the backup's scope is replaced. Keys are replaced only when the backup carries keys.
 * - Runs that were `running` when the backup was made arrive as `aborted`.
 * - Atomic: everything is decoded, validated and planned first (a wrong passphrase imports nothing). Then
 *   keys (through `core.keys.replaceFile`, refused if another tab changed them since the preview) and
 *   settings are written, then every IndexedDB change in one transaction; if that fails, keys and settings
 *   are rolled back. Without a passphrase, keys are skipped and the rest is imported.
 */

import type {
  BackupPreview,
  BackupService,
  CoreServices,
  JobRecord,
  JobState,
  ModelUsageTotals,
  PromptEntry,
  RunRecord,
  RunStatus,
  Settings,
  StoredKeysFile,
  UsageTotals,
} from '../types';
import { TOOL_IDS, type ToolId } from '../../tools/types';
import { BackupError, WrongPassphraseError } from '../errors';
import { decryptWithPassphrase, encryptWithPassphrase, type PassphraseEnvelope } from '../crypto';
import { getDb, type KvEntry, type StoredStatsRow } from '../storage/db';
import { deepMerge, jsonCopy } from '../settings/merge';
import { migrateSettings, normalizeSettings } from '../settings/schema';
import { statsKey } from '../stats';
import { TOOL_STATE_PREFIX, prefixRange } from '../tool-state';
import { isFinalState } from '../jobs';
import { isFiniteNumber, isPlainObject, isString, parseJsonSafe, stripUnsafeKeys } from '../util';
import { version as APP_VERSION } from '../../../package.json';

export { BackupError };

export const BACKUP_FORMAT = 'ortoolbox-backup';
export const BACKUP_VERSION = 1;
/** Files may set their own PBKDF2 cost; anything above this would freeze the page (or be an attack). */
export const MAX_PBKDF2_ITERATIONS = 2_000_000;

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

// --- nouns and change lines ------------------------------------------------------------------------

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
  keyPin: ['tool key pin', 'tool key pins'],
  keyBudget: ['per-key budget', 'per-key budgets'],
} satisfies Record<string, Noun>;

const plural = (count: number, [one, many]: Noun): string => `${count} ${count === 1 ? one : many}`;

function replaceLine(current: number, incoming: number, noun: Noun): string | null {
  if (current === 0 && incoming === 0) return null;
  if (current === 0) return `Add ${plural(incoming, noun)}`;
  if (incoming === 0) return `Delete ${plural(current, noun)}`;
  return `Replace ${plural(current, noun)} with ${incoming} from the backup`;
}

function mergeLines(added: number, updated: number, noun: Noun): string[] {
  const lines: string[] = [];
  if (added > 0) lines.push(`Add ${plural(added, noun)}`);
  if (updated > 0) lines.push(`Update ${plural(updated, noun)}`);
  return lines;
}

const skipLine = (count: number, noun: Noun): string[] =>
  count > 0 ? [`Skip ${plural(count, noun)} (invalid records)`] : [];

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Dotted paths of the leaves that differ (arrays count as one leaf). */
function diffPaths(a: unknown, b: unknown, path = ''): string[] {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((key) => diffPaths(a[key], b[key], path ? `${path}.${key}` : key));
  }
  return same(a, b) ? [] : [path];
}

function listPaths(paths: string[], max = 6): string {
  const shown = paths.slice(0, max).join(', ');
  return paths.length > max ? `${shown} and ${paths.length - max} more` : shown;
}

// --- validation of imported records ----------------------------------------------------------------

const RUN_STATUSES: readonly RunStatus[] = ['running', 'ok', 'error', 'aborted'];
const JOB_STATES: readonly JobState[] = ['queued', 'running', 'succeeded', 'failed', 'cancelled'];
const INTERRUPTED = 'Interrupted: this run was still going when the backup was made.';

const isToolId = (value: unknown): value is ToolId =>
  isString(value) && (TOOL_IDS as readonly string[]).includes(value);
const isId = (value: unknown): value is string => isString(value) && value !== '';
const isCount = (value: unknown): value is number => isFiniteNumber(value) && value >= 0;
const orNull =
  <T>(check: (value: unknown) => value is T) =>
  (value: unknown): value is T | null =>
    value === null || check(value);
const stringOrNull = orNull(isString);
const numberOrNull = orNull(isFiniteNumber);
const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);
/** A JSON-ish plain object, copied without unsafe keys. */
const plain = (value: unknown): Record<string, unknown> | null =>
  isPlainObject(value) ? stripUnsafeKeys(value) : null;

function toModelTotals(value: unknown): ModelUsageTotals | null {
  if (!isPlainObject(value)) return null;
  const { requests, promptTokens, completionTokens, costUsd, latencyMsTotal } = value;
  if (![requests, promptTokens, completionTokens, costUsd, latencyMsTotal].every(isCount)) {
    return null;
  }
  return { requests, promptTokens, completionTokens, costUsd, latencyMsTotal } as ModelUsageTotals;
}

function toUsage(value: unknown): UsageTotals | null {
  const totals = toModelTotals(value);
  if (!totals || !isPlainObject(value) || !isPlainObject(value['byModel'])) return null;
  const { costEstimated, costUnknown = false } = value;
  if (typeof costEstimated !== 'boolean' || typeof costUnknown !== 'boolean') return null;
  const byModel: Record<string, ModelUsageTotals> = {};
  for (const [model, entry] of Object.entries(stripUnsafeKeys(value['byModel']))) {
    const parsed = toModelTotals(entry);
    if (!parsed) return null;
    byModel[model] = parsed;
  }
  return { ...totals, costEstimated, costUnknown, byModel };
}

function toPrompt(value: unknown, kind: PromptEntry['kind']): PromptEntry | null {
  if (!isPlainObject(value)) return null;
  const { id, tool, name, text, createdAt, usedAt } = value;
  const settings = plain(value['settings']);
  if (
    !isId(id) ||
    !isToolId(tool) ||
    value['kind'] !== kind ||
    !stringOrNull(name) ||
    !isString(text) ||
    !settings ||
    !isFiniteNumber(createdAt) ||
    !isFiniteNumber(usedAt)
  ) {
    return null;
  }
  return { id, tool, kind, name, text, settings, createdAt, usedAt };
}

function toRun(value: unknown): RunRecord | null {
  if (!isPlainObject(value)) return null;
  const v = value;
  const usage = toUsage(v['usage']);
  const meta = plain(v['meta']);
  const settings = v['settings'] === null ? null : plain(v['settings']);
  const reservedUsd = v['reservedUsd'] ?? 0;
  const jobId = v['jobId'] ?? null;
  if (
    !isId(v['id']) ||
    !isToolId(v['tool']) ||
    !RUN_STATUSES.includes(v['status'] as RunStatus) ||
    !isString(v['model']) ||
    !isStringList(v['models']) ||
    !isString(v['keyId']) ||
    !isString(v['keyName']) ||
    !isFiniteNumber(v['startedAt']) ||
    !numberOrNull(v['finishedAt']) ||
    !numberOrNull(v['latencyMs']) ||
    !isString(v['title']) ||
    !stringOrNull(v['prompt']) ||
    (v['settings'] !== null && !settings) ||
    !stringOrNull(v['output']) ||
    !stringOrNull(v['error']) ||
    !usage ||
    !isCount(reservedUsd) ||
    !stringOrNull(jobId) ||
    !meta ||
    typeof v['starred'] !== 'boolean' ||
    !stringOrNull(v['groupId'])
  ) {
    return null;
  }
  const run: RunRecord = {
    id: v['id'],
    tool: v['tool'],
    status: v['status'] as RunStatus,
    model: v['model'],
    models: v['models'],
    keyId: v['keyId'],
    keyName: v['keyName'],
    startedAt: v['startedAt'],
    finishedAt: v['finishedAt'],
    latencyMs: v['latencyMs'],
    title: v['title'],
    prompt: v['prompt'],
    settings,
    output: v['output'],
    error: v['error'],
    usage,
    reservedUsd,
    jobId,
    meta,
    starred: v['starred'],
    groupId: v['groupId'],
  };
  // A run cannot continue in another browser (or after a restore): it arrives finished.
  if (run.status === 'running') {
    Object.assign(run, {
      status: 'aborted',
      finishedAt: run.startedAt,
      latencyMs: 0,
      error: INTERRUPTED,
    });
  }
  return run;
}

function toJob(value: unknown): JobRecord | null {
  if (!isPlainObject(value)) return null;
  const v = value;
  if (
    !isId(v['id']) ||
    !isToolId(v['tool']) ||
    !isString(v['type']) ||
    !JOB_STATES.includes(v['state'] as JobState) ||
    !stringOrNull(v['runId']) ||
    !isString(v['keyId']) ||
    !stringOrNull(v['remoteId']) ||
    !stringOrNull(v['groupId']) ||
    !('payload' in v) ||
    !numberOrNull(v['progress']) ||
    !stringOrNull(v['remoteStatus']) ||
    !stringOrNull(v['error']) ||
    !isFiniteNumber(v['createdAt']) ||
    !isFiniteNumber(v['updatedAt']) ||
    !isCount(v['attempts'])
  ) {
    return null;
  }
  return {
    id: v['id'],
    tool: v['tool'],
    type: v['type'],
    state: v['state'] as JobState,
    runId: v['runId'],
    keyId: v['keyId'],
    remoteId: v['remoteId'],
    groupId: v['groupId'],
    payload: stripUnsafeKeys(v['payload']),
    result: stripUnsafeKeys(v['result'] ?? null),
    progress: v['progress'],
    remoteStatus: v['remoteStatus'],
    error: v['error'],
    createdAt: v['createdAt'],
    updatedAt: v['updatedAt'],
    attempts: v['attempts'],
  };
}

function toToolState(value: unknown): KvEntry | null {
  if (!isPlainObject(value)) return null;
  const { key, updatedAt } = value;
  if (!isString(key) || !key.startsWith(TOOL_STATE_PREFIX) || !('value' in value)) return null;
  if (!isFiniteNumber(updatedAt)) return null;
  return { key, value: stripUnsafeKeys(value['value']), updatedAt };
}

const STATS_NUMBERS = [
  'runs',
  'errors',
  'requests',
  'promptTokens',
  'completionTokens',
  'costUsd',
  'latencyMsTotal',
] as const;

function toStatsRow(value: unknown): StoredStatsRow | null {
  if (!isPlainObject(value)) return null;
  const { key, day, tool, model, keyId, free } = value;
  if (
    !isString(day) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !isToolId(tool) ||
    !isString(model) ||
    !isString(keyId) ||
    typeof free !== 'boolean' ||
    !STATS_NUMBERS.every((field) => isCount(value[field])) ||
    key !== statsKey({ day, tool, model, keyId })
  ) {
    return null;
  }
  const row = { key, day, tool, model, keyId, free } as StoredStatsRow;
  for (const field of STATS_NUMBERS) row[field] = value[field] as number;
  return row;
}

interface Checked<T> {
  items: T[];
  skipped: number;
}

/** Valid records of an optional list; a present value that is not a list makes the file damaged. */
function check<T>(value: unknown, convert: (item: unknown) => T | null): Checked<T> {
  if (value === undefined) return { items: [], skipped: 0 };
  if (!Array.isArray(value)) throw new BackupError('This backup file is damaged.');
  const items = value.map(convert).filter((item): item is T => item !== null);
  return { items, skipped: value.length - items.length };
}

function validEnvelope(value: unknown): value is PassphraseEnvelope {
  return (
    isPlainObject(value) &&
    isString(value['salt']) &&
    Number.isInteger(value['iterations']) &&
    (value['iterations'] as number) >= 1 &&
    (value['iterations'] as number) <= MAX_PBKDF2_ITERATIONS &&
    isString(value['iv']) &&
    isString(value['ct'])
  );
}

function validKeysFile(value: unknown): value is StoredKeysFile {
  return (
    isPlainObject(value) &&
    value['version'] === 1 &&
    Array.isArray(value['keys']) &&
    value['keys'].every((key) => isPlainObject(key) && isId(key['id'])) &&
    (value['lock'] === null || isPlainObject(value['lock']))
  );
}

// --- parsing ---------------------------------------------------------------------------------------

interface ParsedBackup {
  createdAt: number;
  appVersion: string;
  scope: 'all' | 'settings';
  /** As stored in the file (migrated, unsafe keys removed): only these fields override on merge. */
  settings: Record<string, unknown>;
  keys?: PassphraseEnvelope;
  savedPrompts: Checked<PromptEntry>;
  recentPrompts: Checked<PromptEntry>;
  runs: Checked<RunRecord>;
  jobs: Checked<JobRecord>;
  toolState: Checked<KvEntry>;
  stats: Checked<StoredStatsRow>;
}

async function parseBackup(blob: Blob): Promise<ParsedBackup> {
  let data: unknown;
  try {
    data = parseJsonSafe(await blob.text());
  } catch {
    throw new BackupError('This file is not an ORtoolbox backup: it is not valid JSON.');
  }
  if (!isPlainObject(data) || data['format'] !== BACKUP_FORMAT) {
    throw new BackupError('This file is not an ORtoolbox backup.');
  }
  const version = data['version'];
  if (isFiniteNumber(version) && version > BACKUP_VERSION) {
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
  const all = scope === 'all';
  const none = { items: [], skipped: 0 };
  return {
    createdAt: isFiniteNumber(data['createdAt']) ? data['createdAt'] : 0,
    appVersion: isString(data['appVersion']) ? data['appVersion'] : 'unknown',
    scope,
    settings: migrateSettings(data['settings']),
    keys: data['keys'],
    savedPrompts: check(data['savedPrompts'], (v) => toPrompt(v, 'saved')),
    recentPrompts: all ? check(data['recentPrompts'], (v) => toPrompt(v, 'recent')) : none,
    runs: all ? check(data['runs'], toRun) : none,
    jobs: all ? check(data['jobs'], toJob) : none,
    toolState: all ? check(data['toolState'], toToolState) : none,
    stats: all ? check(data['stats'], toStatsRow) : none,
  };
}

/** The decrypted keys file; null when the backup has none or no passphrase was given. */
async function decodeKeys(
  envelope: PassphraseEnvelope | undefined,
  passphrase: string | undefined,
): Promise<StoredKeysFile | null> {
  if (!envelope || !passphrase) return null;
  let plainText: string;
  try {
    plainText = await decryptWithPassphrase(passphrase, envelope);
  } catch (error) {
    // AES-GCM authentication failure: the passphrase (or the data) is wrong. Name check, not instanceof:
    // WebCrypto's DOMException may come from another realm.
    if ((error as { name?: unknown } | null)?.name === 'OperationError') {
      throw new WrongPassphraseError(
        'Wrong passphrase: the keys in this backup could not be decrypted. Nothing was imported.',
      );
    }
    throw new BackupError('The keys in this backup are damaged.', { cause: error });
  }
  let keys: unknown;
  try {
    keys = parseJsonSafe(plainText);
  } catch {
    keys = null;
  }
  if (!validKeysFile(keys)) throw new BackupError('The keys in this backup are damaged.');
  return keys;
}

const lockName = (lock: StoredKeysFile['lock']): string => JSON.stringify(lock);

/**
 * Removes tool key pins, per-key budgets and the default key that refer to keys missing from `keyIds` (the
 * keys this browser will have after the import), and describes what was removed.
 */
function dropUnknownKeyIds(
  settings: Settings,
  keyIds: Set<string>,
): { settings: Settings; lines: string[] } {
  const next = structuredClone(settings);
  let pins = 0;
  for (const binding of Object.values(next.tools)) {
    if (binding.keyId !== undefined && !keyIds.has(binding.keyId)) {
      delete binding.keyId;
      pins++;
    }
  }
  let limits = 0;
  for (const keyId of Object.keys(next.budgets.perKeyMonthlyUsd)) {
    if (!keyIds.has(keyId)) {
      delete next.budgets.perKeyMonthlyUsd[keyId];
      limits++;
    }
  }
  const lines: string[] = [];
  const because = (count: number): string =>
    count === 1 ? 'its key is not in this browser' : 'their keys are not in this browser';
  if (pins > 0) lines.push(`${plural(pins, N.keyPin)} removed: ${because(pins)}`);
  if (limits > 0) lines.push(`${plural(limits, N.keyBudget)} removed: ${because(limits)}`);
  if (next.defaultKeyId !== null && !keyIds.has(next.defaultKeyId)) {
    next.defaultKeyId = null;
    lines.push('Default key cleared: it is not in this browser');
  }
  return { settings: next, lines };
}

// --- service ---------------------------------------------------------------------------------------

type StoreName = 'runs' | 'prompts' | 'jobs' | 'kv' | 'stats';

interface Plan {
  preview: BackupPreview;
  apply: () => Promise<void>;
}

export function createBackupService(core: CoreServices): BackupService {
  const prepare = async (
    blob: Blob,
    opts: { mode: 'merge' | 'replace'; passphrase?: string },
  ): Promise<Plan> => {
    const file = await parseBackup(blob);
    const importedKeys = await decodeKeys(file.keys, opts.passphrase);
    const replace = opts.mode === 'replace';
    const all = file.scope === 'all';
    const changes: string[] = [];

    // Keys (decided first: the default key setting depends on whether they are taken).
    const keysBefore = core.keys.exportFile();
    const keyLines: string[] = [];
    let nextKeys: StoredKeysFile | null = null;
    if (file.keys && !importedKeys) {
      keyLines.push('Skip keys (enter the backup passphrase to import them)');
    } else if (importedKeys) {
      const sameLock = lockName(keysBefore.lock) === lockName(importedKeys.lock);
      if (replace) {
        nextKeys = importedKeys;
        const line = replaceLine(keysBefore.keys.length, importedKeys.keys.length, N.key);
        if (line) keyLines.push(line);
        if (!sameLock) {
          keyLines.push(
            !importedKeys.lock
              ? 'Turn off the passphrase lock'
              : keysBefore.lock
                ? 'Use the backup’s passphrase lock'
                : 'Turn on the backup’s passphrase lock',
          );
        }
      } else if (sameLock) {
        const byId = new Map(keysBefore.keys.map((key) => [key.id, key]));
        let added = 0;
        let updated = 0;
        for (const key of importedKeys.keys) {
          const existing = byId.get(key.id);
          if (!existing) added++;
          else if (!same(existing, key)) updated++;
          byId.set(key.id, key);
        }
        if (added + updated > 0) nextKeys = { ...keysBefore, keys: [...byId.values()] };
        keyLines.push(...mergeLines(added, updated, N.key));
      } else if (!keysBefore.lock && keysBefore.keys.length === 0) {
        // Nothing here yet and no lock to lose: take the backup's keys (and its lock).
        nextKeys = importedKeys;
        keyLines.push(...mergeLines(importedKeys.keys.length, 0, N.key));
        if (importedKeys.lock) keyLines.push('Turn on the backup’s passphrase lock');
      } else {
        keyLines.push(
          'Skip keys: the backup and this browser protect keys with different passphrase locks (use Replace to take the backup’s keys)',
        );
      }
    }

    // Settings: the default key follows the backup only when its keys are taken, and nothing may point to a
    // key this browser will not have.
    const current = core.settings.get();
    const raw = { ...file.settings };
    const takeDefaultKey =
      nextKeys !== null &&
      (replace || (isString(raw['defaultKeyId']) && raw['defaultKeyId'] !== ''));
    if (!takeDefaultKey) raw['defaultKeyId'] = current.defaultKeyId;
    const { settings: nextSettings, lines: orphanLines } = dropUnknownKeyIds(
      normalizeSettings(replace ? raw : deepMerge(jsonCopy(current), stripUnsafeKeys(raw))),
      new Set((nextKeys ?? keysBefore).keys.map((key) => key.id)),
    );
    const settingPaths = diffPaths(current, nextSettings);
    changes.push(
      settingPaths.length === 0
        ? 'Settings unchanged'
        : replace
          ? `Replace all settings (${plural(settingPaths.length, N.setting)} differ)`
          : `Change ${plural(settingPaths.length, N.setting)}: ${listPaths(settingPaths)}`,
      ...orphanLines,
      ...keyLines,
    );

    // Records: read what is here, then plan every write.
    const db = await getDb();
    const read = db.transaction(['runs', 'prompts', 'jobs', 'kv', 'stats']);
    const localPrompts = await read.objectStore('prompts').getAll();
    const lookup = async <T>(store: StoreName, ids: string[]): Promise<Map<string, T>> => {
      const found = await Promise.all(ids.map((id) => read.objectStore(store).get(id)));
      return new Map(ids.flatMap((id, i) => (found[i] === undefined ? [] : [[id, found[i] as T]])));
    };
    const [localRuns, localJobs, localTool, localStats, counts] = await Promise.all([
      lookup<RunRecord>(
        'runs',
        file.runs.items.map((r) => r.id),
      ),
      lookup<JobRecord>(
        'jobs',
        file.jobs.items.map((j) => j.id),
      ),
      lookup<KvEntry>(
        'kv',
        file.toolState.items.map((e) => e.key),
      ),
      lookup<StoredStatsRow>(
        'stats',
        file.stats.items.map((s) => s.key),
      ),
      Promise.all([
        read.objectStore('runs').count(),
        read.objectStore('jobs').count(),
        read.objectStore('kv').getAllKeys(prefixRange(TOOL_STATE_PREFIX)),
        read.objectStore('stats').count(),
      ]),
    ]);
    await read.done;
    const [runCount, jobCount, toolKeys, statsCount] = counts;

    const puts = {
      prompts: [] as PromptEntry[],
      runs: [] as RunRecord[],
      jobs: [] as JobRecord[],
      kv: [] as KvEntry[],
      stats: [] as StoredStatsRow[],
    };

    /** Plans one kind of record; `pick` returns the record to write (or null to keep the local one). */
    const plan = <T>(
      noun: Noun,
      checked: Checked<T>,
      localCount: number,
      existing: (item: T) => T | undefined,
      pick: (incoming: T, local: T) => T | null,
      out: T[],
    ): void => {
      if (replace) {
        out.push(...checked.items);
        const line = replaceLine(localCount, checked.items.length, noun);
        if (line) changes.push(line);
      } else {
        let added = 0;
        let updated = 0;
        for (const item of checked.items) {
          const local = existing(item);
          const next = local === undefined ? item : pick(item, local);
          if (next === null || (local !== undefined && same(next, local))) continue;
          out.push(next);
          if (local === undefined) added++;
          else updated++;
        }
        changes.push(...mergeLines(added, updated, noun));
      }
      changes.push(...skipLine(checked.skipped, noun));
    };

    const promptsById = new Map(localPrompts.map((p) => [p.id, p]));
    const promptsOf = (kind: PromptEntry['kind']) => localPrompts.filter((p) => p.kind === kind);
    const takeIncoming = <T>(incoming: T): T => incoming;

    plan(
      N.saved,
      file.savedPrompts,
      promptsOf('saved').length,
      (p) => promptsById.get(p.id),
      takeIncoming,
      puts.prompts,
    );
    if (all) {
      plan(
        N.run,
        file.runs,
        runCount,
        (r) => localRuns.get(r.id),
        // Never touch a run that is going here; otherwise the later finish wins.
        (incoming, local) =>
          local.status !== 'running' && (incoming.finishedAt ?? 0) > (local.finishedAt ?? 0)
            ? incoming
            : null,
        puts.runs,
      );
      plan(
        N.recent,
        file.recentPrompts,
        promptsOf('recent').length,
        (p) => promptsById.get(p.id),
        takeIncoming,
        puts.prompts,
      );
      plan(
        N.job,
        file.jobs,
        jobCount,
        (j) => localJobs.get(j.id),
        (incoming, local) =>
          incoming.updatedAt > local.updatedAt &&
          !(isFinalState(local.state) && !isFinalState(incoming.state))
            ? incoming
            : null,
        puts.jobs,
      );
      plan(
        N.toolState,
        file.toolState,
        toolKeys.length,
        (e) => localTool.get(e.key),
        takeIncoming,
        puts.kv,
      );
      plan(
        N.stats,
        file.stats,
        statsCount,
        (s) => localStats.get(s.key),
        (incoming, local) => {
          const merged = { ...local };
          for (const field of STATS_NUMBERS)
            merged[field] = Math.max(local[field], incoming[field]);
          return merged;
        },
        puts.stats,
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
        runs: file.runs.items.length,
        prompts: file.savedPrompts.items.length + file.recentPrompts.items.length,
        jobs: file.jobs.items.length,
        toolState: file.toolState.items.length,
        statsRows: file.stats.items.length,
      },
      changes,
    };

    /** Every IndexedDB change in one transaction: all of it lands, or none. */
    const writeRecords = async (): Promise<void> => {
      const stores: StoreName[] = all ? ['runs', 'prompts', 'jobs', 'kv', 'stats'] : ['prompts'];
      const tx = db.transaction(stores, 'readwrite');
      const done = tx.done;
      done.catch(() => undefined); // observed below; an abort must not surface as unhandled
      const ops: Promise<unknown>[] = [];
      // Each request is observed at once: after an abort they all reject, and none may go unhandled.
      const op = (request: Promise<unknown>): void => {
        request.catch(() => undefined);
        ops.push(request);
      };
      try {
        const prompts = tx.objectStore('prompts');
        if (replace) {
          for (const p of localPrompts) {
            if (p.kind === 'saved' || all) op(prompts.delete(p.id));
          }
        }
        for (const p of puts.prompts) op(prompts.put(p));
        if (all) {
          const runs = tx.objectStore('runs');
          const jobs = tx.objectStore('jobs');
          const kv = tx.objectStore('kv');
          const stats = tx.objectStore('stats');
          if (replace) {
            op(runs.clear());
            op(jobs.clear());
            op(stats.clear());
            for (const key of toolKeys) op(kv.delete(key));
          }
          for (const run of puts.runs) op(runs.put(run));
          for (const job of puts.jobs) op(jobs.put(job));
          for (const entry of puts.kv) op(kv.put(entry));
          for (const row of puts.stats) op(stats.put(row));
        }
        await Promise.all(ops);
      } catch (error) {
        try {
          tx.abort();
        } catch {
          // already finished or aborted
        }
        throw error;
      }
      await done;
    };

    const settingsChanged = settingPaths.length > 0;
    const apply = async (): Promise<void> => {
      const settingsBefore = current;
      let keysWritten = false;
      let settingsWritten = false;
      try {
        if (nextKeys) {
          core.keys.replaceFile(nextKeys, { expected: keysBefore });
          keysWritten = true;
        }
        if (settingsChanged) {
          core.settings.update((draft) => {
            Object.assign(draft, jsonCopy(nextSettings));
          });
          settingsWritten = true;
        }
        await writeRecords();
      } catch (error) {
        if (settingsWritten) {
          try {
            core.settings.update((draft) => {
              Object.assign(draft, jsonCopy(settingsBefore));
            });
          } catch (rollbackError) {
            console.error(rollbackError);
          }
        }
        if (keysWritten && nextKeys) {
          try {
            core.keys.replaceFile(keysBefore, { expected: nextKeys });
          } catch (rollbackError) {
            console.error(rollbackError);
          }
        }
        throw error;
      }

      if (replace || puts.prompts.length > 0)
        core.bus.emit({ type: 'prompts-changed', tool: 'all' });
      if (all) {
        if (replace || puts.runs.length > 0) core.bus.emit({ type: 'history-changed' });
        if (replace || puts.stats.length > 0) core.bus.emit({ type: 'stats-changed' });
        const touched = new Set([
          ...(replace ? [...localJobs.keys()] : []),
          ...puts.jobs.map((j) => j.id),
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
        file.keys = await encryptWithPassphrase(
          opts.passphrase,
          JSON.stringify(core.keys.exportFile()),
        );
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
