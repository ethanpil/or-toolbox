/**
 * Settings → Data: storage estimate, per-tool deletion, "Delete all prompts and history" and "Reset
 * everything". Stores are cleared rather than the database deleted, because deleting would wait for every
 * other open tab to close its connection.
 */

import type { CoreServices, DataService } from '../types';
import { getDb } from '../storage/db';
import { LS_KEYS, SS_KEYS, local, removeItem, session } from '../storage/local';
import { TOOL_STATE_PREFIX, prefixRange } from '../tool-state';

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
      const db = await getDb();
      const tx = db.transaction(['runs', 'prompts', 'jobs', 'stats', 'kv'], 'readwrite');
      const jobIds = await tx.objectStore('jobs').getAllKeys();
      await Promise.all([
        tx.objectStore('runs').clear(),
        tx.objectStore('prompts').clear(),
        tx.objectStore('jobs').clear(),
        tx.objectStore('stats').clear(),
        tx.objectStore('kv').delete(prefixRange(TOOL_STATE_PREFIX)),
        tx.done,
      ]);
      core.bus.emit({ type: 'history-changed' });
      core.bus.emit({ type: 'prompts-changed', tool: 'all' });
      core.bus.emit({ type: 'stats-changed' });
      for (const id of jobIds) core.bus.emit({ type: 'jobs-changed', id });
    },

    async resetEverything() {
      const db = await getDb();
      const tx = db.transaction(['runs', 'prompts', 'jobs', 'stats', 'kv'], 'readwrite');
      await Promise.all([
        tx.objectStore('runs').clear(),
        tx.objectStore('prompts').clear(),
        tx.objectStore('jobs').clear(),
        tx.objectStore('stats').clear(),
        tx.objectStore('kv').clear(),
        tx.done,
      ]);
      for (const key of [LS_KEYS.settings, LS_KEYS.keys, LS_KEYS.bus]) removeItem(local(), key);
      for (const key of [SS_KEYS.unlocked, SS_KEYS.oauth]) removeItem(session(), key);
      core.bus.emit({ type: 'settings-changed' });
      core.bus.emit({ type: 'keys-changed' });
      core.bus.emit({ type: 'data-reset' });
    },
  };
}
