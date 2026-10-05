/**
 * Settings → Data: storage estimate, per-tool deletion, "Delete all prompts and history" and "Reset
 * everything". Stores are cleared rather than the database deleted, because deleting would wait for every
 * other open tab to close its connection.
 */

import type { CoreServices, DataService } from '../types';
import { getDb } from '../storage/db';
import { LS_KEYS, SS_KEYS, local, removeItem, session } from '../storage/local';
import { TOOL_STATE_PREFIX, announceToolState, prefixRange, wipeKv } from '../tool-state';

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
      await core.history.clear({ tool });
      await core.prompts.clear(tool, 'all');
    },

    async deleteAllPromptsAndHistory() {
      // Stats rollups hold no prompt text (tool, model, tokens, cost) and are the budget ledger, so they
      // survive this; otherwise clearing history for privacy would silently reset this month's spend.
      const db = await getDb();
      const tx = db.transaction(['runs', 'prompts', 'jobs', 'kv'], 'readwrite');
      const jobIds = await tx.objectStore('jobs').getAllKeys();
      const stateKeys = await tx.objectStore('kv').getAllKeys(prefixRange(TOOL_STATE_PREFIX));
      await Promise.all([
        tx.objectStore('runs').clear(),
        tx.objectStore('prompts').clear(),
        tx.objectStore('jobs').clear(),
        tx.objectStore('kv').delete(prefixRange(TOOL_STATE_PREFIX)),
        tx.done,
      ]);
      core.bus.emit({ type: 'history-changed' });
      core.bus.emit({ type: 'prompts-changed', tool: 'all' });
      for (const id of jobIds) core.bus.emit({ type: 'jobs-changed', id });
      announceToolState(core.bus, stateKeys); // open tools read their state again and show it gone
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
