/**
 * Prompts per tool in IndexedDB `prompts`: Recent (filled by runs, capped at 50 per tool, follows history
 * retention) and Saved (kept until deleted). Every change is broadcast as `prompts-changed`.
 */

import type { CoreServices, PromptEntry, PromptsService, ToolId } from '../types';
import { InvalidInputError } from '../errors';
import { getDb } from '../storage/db';
import { jsonCopy } from '../settings/merge';

export const RECENT_PROMPTS_CAP = 50;

const byUsedAtDesc = (a: PromptEntry, b: PromptEntry): number => b.usedAt - a.usedAt;

export function createPromptsService(core: CoreServices): PromptsService {
  const changed = (tool: ToolId | 'all'): void => core.bus.emit({ type: 'prompts-changed', tool });

  /** One event for a single tool, `all` when several tools changed. */
  const changedFor = (entries: PromptEntry[]): void => {
    const tools = new Set(entries.map((entry) => entry.tool));
    if (tools.size === 0) return;
    changed(tools.size === 1 ? [...tools][0]! : 'all');
  };

  const mutateEntry = async (id: string, patch: (entry: PromptEntry) => PromptEntry) => {
    const db = await getDb();
    const tx = db.transaction('prompts', 'readwrite');
    const entry = await tx.store.get(id);
    if (entry) await tx.store.put(patch(entry));
    await tx.done;
    if (entry) changed(entry.tool);
  };

  const save: PromptsService['save'] = async ({ tool, text, settings, name }) => {
    const now = Date.now();
    const entry: PromptEntry = {
      id: crypto.randomUUID(),
      tool,
      kind: 'saved',
      name: name?.trim() || null,
      text,
      settings: jsonCopy(settings),
      createdAt: now,
      usedAt: now,
    };
    await (await getDb()).put('prompts', entry);
    changed(tool);
    return entry;
  };

  return {
    async list(tool, kind) {
      const entries = await (await getDb()).getAllFromIndex('prompts', 'tool-kind', [tool, kind]);
      return entries.sort(byUsedAtDesc);
    },

    async addRecent(tool, text, settings) {
      if (!core.settings.get().data.recordRecentPrompts || text.trim() === '') return null;
      const now = Date.now();
      const db = await getDb();
      const tx = db.transaction('prompts', 'readwrite');
      const recent = (await tx.store.index('tool-kind').getAll([tool, 'recent'])).sort(
        byUsedAtDesc,
      );
      const same = recent.find((entry) => entry.text.trim() === text.trim());
      const entry: PromptEntry = same
        ? { ...same, text, settings: jsonCopy(settings), usedAt: now }
        : {
            id: crypto.randomUUID(),
            tool,
            kind: 'recent',
            name: null,
            text,
            settings: jsonCopy(settings),
            createdAt: now,
            usedAt: now,
          };
      await tx.store.put(entry);
      const others = recent.filter((other) => other.id !== entry.id);
      await Promise.all(others.slice(RECENT_PROMPTS_CAP - 1).map((old) => tx.store.delete(old.id)));
      await tx.done;
      changed(tool);
      return entry;
    },

    save,

    async saveFromRecent(recentId, name) {
      const source = await (await getDb()).get('prompts', recentId);
      if (!source) throw new InvalidInputError('That prompt no longer exists.');
      return save({
        tool: source.tool,
        text: source.text,
        settings: source.settings,
        name: name ?? source.name,
      });
    },

    rename(id, name) {
      return mutateEntry(id, (entry) => ({ ...entry, name: name?.trim() || null }));
    },

    touch(id) {
      return mutateEntry(id, (entry) => ({ ...entry, usedAt: Date.now() }));
    },

    async remove(ids) {
      const db = await getDb();
      const tx = db.transaction('prompts', 'readwrite');
      const found = await Promise.all(ids.map((id) => tx.store.get(id)));
      const removed = found.filter((entry): entry is PromptEntry => entry !== undefined);
      await Promise.all(removed.map((entry) => tx.store.delete(entry.id)));
      await tx.done;
      changedFor(removed);
      return removed;
    },

    async clear(tool, kind) {
      const db = await getDb();
      const tx = db.transaction('prompts', 'readwrite');
      // Small store (≤ 50 recent per tool plus saved ones): a full read is simpler than index ranges.
      const removed = (await tx.store.getAll()).filter(
        (entry) =>
          (tool === 'all' || entry.tool === tool) && (kind === 'all' || entry.kind === kind),
      );
      await Promise.all(removed.map((entry) => tx.store.delete(entry.id)));
      await tx.done;
      if (removed.length > 0) changed(tool);
      return removed;
    },

    async restore(entries) {
      if (entries.length === 0) return;
      const db = await getDb();
      const tx = db.transaction('prompts', 'readwrite');
      await Promise.all([...entries.map((entry) => tx.store.put(jsonCopy(entry))), tx.done]);
      changedFor(entries);
    },

    async counts() {
      const counts: Partial<Record<ToolId, { recent: number; saved: number }>> = {};
      for (const entry of await (await getDb()).getAll('prompts')) {
        const row = (counts[entry.tool] ??= { recent: 0, saved: 0 });
        row[entry.kind]++;
      }
      return counts;
    },

    subscribe(fn) {
      const offs = [
        core.bus.on('prompts-changed', (event) => fn(event.tool)),
        core.bus.on('data-reset', () => fn('all')),
      ];
      return () => offs.forEach((off) => off());
    },
  };
}
