/**
 * The editor's version history: the original and every edit result, each knowing the version it was made from.
 * One version is the working one (shown on the canvas, the base of the next edit); any version can become it
 * again ("continue from here"), and a new edit is always added at the end, so nothing is ever overwritten.
 */
import type { EditMode } from './request';

export interface Version {
  id: string;
  /** 0 for the original, then 1, 2, … in the order made (numbers of removed versions are not reused). */
  number: number;
  blob: Blob;
  name: string;
  width: number;
  height: number;
  /** The version this one was made from; null for the original. */
  parentId: string | null;
  mode: EditMode | null;
  instruction: string;
  model: string | null;
  createdAt: number;
}

export type NewVersion = Omit<Version, 'id' | 'number' | 'createdAt'>;

export class VersionHistory {
  private list: Version[] = [];
  private workingId: string | null = null;
  private next = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Every version, oldest first (the original first). */
  all(): readonly Version[] {
    return this.list;
  }

  get(id: string): Version | undefined {
    return this.list.find((version) => version.id === id);
  }

  get working(): Version | null {
    return (this.workingId && this.get(this.workingId)) || null;
  }

  get original(): Version | null {
    return this.list[0] ?? null;
  }

  /** Starts over from a new original (the old versions are forgotten). */
  reset(original: Omit<NewVersion, 'parentId' | 'mode' | 'instruction' | 'model'>): Version {
    this.list = [];
    this.next = 0;
    const version = this.push({
      ...original,
      parentId: null,
      mode: null,
      instruction: '',
      model: null,
    });
    this.workingId = version.id;
    return version;
  }

  /** Adds an edit result and makes it the working version. */
  add(input: NewVersion): Version {
    if (this.list.length === 0) throw new Error('Load an original first.');
    const version = this.push(input);
    this.workingId = version.id;
    return version;
  }

  /** Makes `id` the working version; false when there is no such version. */
  select(id: string): boolean {
    if (!this.get(id)) return false;
    this.workingId = id;
    return true;
  }

  /** The version `id` was made from. */
  parentOf(id: string): Version | null {
    const parent = this.get(id)?.parentId;
    return parent ? (this.get(parent) ?? null) : null;
  }

  /**
   * Removes an edit (never the original). Versions made from it now count as made from its parent; if it was
   * the working version, its parent becomes the working one. Returns the removed version.
   */
  remove(id: string): Version | null {
    const at = this.list.findIndex((version) => version.id === id);
    if (at <= 0) return null;
    const [removed] = this.list.splice(at, 1);
    if (!removed) return null;
    for (const version of this.list) {
      if (version.parentId === id) version.parentId = removed.parentId;
    }
    if (this.workingId === id) this.workingId = removed.parentId ?? this.list[0]?.id ?? null;
    return removed;
  }

  private push(input: NewVersion): Version {
    const version: Version = {
      ...input,
      id: `v${this.next}-${Math.random().toString(36).slice(2, 8)}`,
      number: this.next,
      createdAt: this.now(),
    };
    this.next += 1;
    this.list.push(version);
    return version;
  }
}

/** "Original" or "Version 3". */
export const versionLabel = (version: Pick<Version, 'number'>): string =>
  version.number === 0 ? 'Original' : `Version ${version.number}`;
