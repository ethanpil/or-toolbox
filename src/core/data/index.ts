/**
 * Settings → Data: storage estimate, per-tool deletion, "Delete all prompts and history" and "Reset
 * everything". Stores are cleared rather than the database deleted, because deleting would wait for every
 * other open tab to close its connection.
 *
 * The two deletions never delete work in progress (`liveWork`): a running run (live in a page, or handed off to a
 * job) must still book its spend when it ends, and a job must still be polled and delivered. A tool with such work
 * also keeps its saved state, which its delivery may write to (Video studio's timeline). What was kept is returned
 * (`DataDeletion`) for the page to say. Reset everything deletes everything: its runs abort without booking.
 */

import type {
  CoreServices,
  DataDeletion,
  DataService,
  JobRecord,
  RunRecord,
  ToolId,
} from '../types';
import { isFinalState } from '../jobs';
import { getDb } from '../storage/db';
import { LS_KEYS, SS_KEYS, local, removeItem, session } from '../storage/local';
import {
  TOOL_STATE_PREFIX,
  announceToolState,
  parseToolStateKey,
  prefixRange,
  wipeKv,
} from '../tool-state';

/** Work in progress, which deletions keep (see the module comment). */
export interface LiveWork {
  /** Running runs. */
  runIds: Set<string>;
  /** Open jobs, and finished jobs whose run is still running (not delivered yet). */
  jobIds: Set<string>;
  /** Tools with any of the above. */
  tools: Set<ToolId>;
}

/** What of `jobs` (and the `running` runs) a deletion must keep. Also for Backup's Replace. */
export function liveWork(
  running: readonly Pick<RunRecord, 'id' | 'tool' | 'status'>[],
  jobs: readonly Pick<JobRecord, 'id' | 'tool' | 'state' | 'runId'>[],
): LiveWork {
  const live: LiveWork = { runIds: new Set(), jobIds: new Set(), tools: new Set() };
  for (const run of running) {
    if (run.status !== 'running') continue;
    live.runIds.add(run.id);
    live.tools.add(run.tool);
  }
  for (const job of jobs) {
    if (!isFinalState(job.state) || (job.runId !== null && live.runIds.has(job.runId))) {
      live.jobIds.add(job.id);
      live.tools.add(job.tool);
    }
  }
  return live;
}

const kept = (live: LiveWork): DataDeletion => ({
  keptRuns: live.runIds.size,
  keptTools: [...live.tools],
});

export function createDataService(core: CoreServices): DataService {
  return {
    async storage() {
      try {
        const estimate = await navigator.storage.estimate();
        return { usedBytes: estimate.usage ?? null, quotaBytes: estimate.quota ?? null };
      } catch {
        return { usedBytes: null, quotaBytes: null }; // no StorageManager (older Safari, insecure context)
      }
    },

    async deleteToolData(tool) {
      await core.history.clear({ tool }); // keeps running runs
      const db = await getDb();
      const tx = db.transaction(['runs', 'jobs', 'kv'], 'readwrite');
      const jobs = tx.objectStore('jobs');
      const kv = tx.objectStore('kv');
      const [running, toolJobs, stateKeys] = await Promise.all([
        tx.objectStore('runs').index('status').getAll('running'),
        jobs.index('tool').getAll(tool),
        kv.getAllKeys(prefixRange(`${TOOL_STATE_PREFIX}${tool}:`)),
      ]);
      const live = liveWork(
        running.filter((run) => run.tool === tool),
        toolJobs,
      );
      const doomedJobs = toolJobs.filter((job) => !live.jobIds.has(job.id)).map((job) => job.id);
      const doomedState = live.tools.has(tool) ? [] : stateKeys;
      await Promise.all([
        ...doomedJobs.map((id) => jobs.delete(id)),
        ...doomedState.map((key) => kv.delete(key)),
        tx.done,
      ]);
      await core.prompts.clear(tool, 'all');
      for (const id of doomedJobs) core.bus.emit({ type: 'jobs-changed', id });
      announceToolState(core.bus, doomedState); // open tools read their state again and show it gone
      return kept(live);
    },

    async deleteAllPromptsAndHistory() {
      // Stats rollups hold no prompt text (tool, model, tokens, cost) and are the budget ledger, so they
      // survive this; otherwise clearing history for privacy would silently reset this month's spend.
      const db = await getDb();
      const tx = db.transaction(['runs', 'prompts', 'jobs', 'kv'], 'readwrite');
      const runs = tx.objectStore('runs');
      const jobs = tx.objectStore('jobs');
      const kv = tx.objectStore('kv');
      const [running, allJobs, runIds, stateKeys] = await Promise.all([
        runs.index('status').getAll('running'),
        jobs.getAll(),
        runs.getAllKeys(),
        kv.getAllKeys(prefixRange(TOOL_STATE_PREFIX)),
      ]);
      const live = liveWork(running, allJobs);
      const doomedRuns = runIds.filter((id) => !live.runIds.has(id));
      const doomedJobs = allJobs.filter((job) => !live.jobIds.has(job.id)).map((job) => job.id);
      const doomedState = stateKeys.filter((key) => {
        const parsed = parseToolStateKey(key);
        return !parsed || !live.tools.has(parsed.tool);
      });
      await Promise.all([
        ...doomedRuns.map((id) => runs.delete(id)),
        ...doomedJobs.map((id) => jobs.delete(id)),
        ...doomedState.map((key) => kv.delete(key)),
        tx.objectStore('prompts').clear(),
        tx.done,
      ]);
      core.bus.emit({ type: 'history-changed' });
      core.bus.emit({ type: 'prompts-changed', tool: 'all' });
      for (const id of doomedJobs) core.bus.emit({ type: 'jobs-changed', id });
      announceToolState(core.bus, doomedState); // open tools read their state again and show it gone
      return kept(live);
    },

    async resetEverything() {
      const db = await getDb();
      const tx = db.transaction(['runs', 'prompts', 'jobs', 'stats', 'kv'], 'readwrite');
      const jobIds = await tx.objectStore('jobs').getAllKeys();
      const stateKeys = await tx.objectStore('kv').getAllKeys(prefixRange(TOOL_STATE_PREFIX));
      await Promise.all([
        tx.objectStore('runs').clear(),
        tx.objectStore('prompts').clear(),
        tx.objectStore('jobs').clear(),
        tx.objectStore('stats').clear(),
        // Clears kv and bumps the reset generation in this transaction: no tool state write lands behind it.
        wipeKv(tx.objectStore('kv')),
        tx.done,
      ]);
      core.keys.clear(); // keys, lock and this tab's unlocked session; emits keys-changed
      for (const key of Object.values(LS_KEYS)) removeItem(local(), key);
      for (const key of Object.values(SS_KEYS)) {
        // The isolation-reload guard must survive, or a reset could start a reload loop.
        if (key !== SS_KEYS.isolationReload) removeItem(session(), key);
      }
      core.bus.emit({ type: 'settings-changed' });
      for (const id of jobIds) core.bus.emit({ type: 'jobs-changed', id });
      // Every service (here and in other tabs) drops its live work: runs abort without booking, polling stops. (Tool
      // state stores refuse what their pages held from before already: the wipe bumped the reset generation.)
      core.bus.emit({ type: 'data-reset' });
      // Then open tools read their state again (after the reset, so that read counts as a fresh one).
      announceToolState(core.bus, stateKeys);
    },
  };
}
