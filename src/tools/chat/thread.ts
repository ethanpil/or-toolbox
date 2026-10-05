/**
 * Chat threads as a tree of messages. Editing a user message or regenerating a reply adds a sibling instead of
 * overwriting, so earlier branches stay reachable (‹ 1/3 ›). Each parent remembers which child is selected; the
 * **active path** (selected root, then each node's selected child) is what the conversation shows, what the next
 * request sends and what Export writes.
 *
 * Threads are JSON in the tool's state (`thread:<id>`, one key per thread). Attachments keep only their name, type
 * and size (text files also their text, PDFs the parser's text once a reply brought it); image, PDF and audio bytes
 * live in memory for the session and are never stored. `parseThread` validates, repairs and migrates whatever
 * storage returns.
 *
 * Every stored change bumps `rev`. A tab that finds a higher `rev` in storage than the one it based its change on
 * merges (`mergeInto`, three-way against `baseOf` that version) instead of writing over the other tab's change.
 */
import type { AttachmentKind, AttachmentRef } from '../../core/attachments/attachments';
import { isFiniteNumber, isPlainObject, isString, isUnsafeKey } from '../../core/util';
import { normalize } from '../../ui/shell/palette-search';

export const THREAD_VERSION = 1;

export interface ReplyUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
  costEstimated?: boolean;
  costUnknown?: boolean;
}

export type ReplyStatus = 'streaming' | 'done' | 'stopped' | 'error';

export interface ChatNode {
  id: string;
  /** null for the first message of a thread (a root). */
  parent: string | null;
  /** Child ids, oldest first (siblings are branches). */
  children: string[];
  /** The child on the active path, or null for a leaf. */
  selected: string | null;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  /** User messages. */
  attachments?: AttachmentRef[];
  /** Replies: the model asked for, and the one OpenRouter reports (a fallback, a dated snapshot). */
  model?: string;
  servedModel?: string;
  reasoning?: string;
  usage?: ReplyUsage;
  status?: ReplyStatus;
  /** A user-safe error message (status `error`). */
  error?: string;
  /** The failed request may have gone through and been billed (`isOutcomeUnknown`): no plain Retry is offered. */
  outcomeUnknown?: true;
  /** Earliest messages left out of the request to fit the model's context. */
  trimmed?: number;
}

export interface Thread {
  v: typeof THREAD_VERSION;
  id: string;
  title: string;
  /** True once the user renamed the thread; until then the first message names it. */
  named: boolean;
  createdAt: number;
  updatedAt: number;
  /** Bumped on every stored change (cross-tab conflict detection). */
  rev: number;
  /** System prompt for this thread ('' = none). */
  system: string;
  /** The composer's model for this thread; null follows the header's (default) model. */
  model: string | null;
  nodes: Record<string, ChatNode>;
  roots: string[];
  /** The selected root. */
  selected: string | null;
}

export interface ThreadTotals {
  replies: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
  /** Some reply's cost was estimated or unknown. */
  approximate: boolean;
}

export const newId = (): string => crypto.randomUUID();

const TITLE_LENGTH = 60;

/** A title from the first message: its first non-empty line, at most 60 characters. */
export function titleFrom(text: string): string {
  const line =
    text
      .split('\n')
      .map((part) => part.trim())
      .find(Boolean) ?? '';
  if (!line) return 'New chat';
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : line;
}

export function createThread(
  init: { id?: string; now?: number; system?: string; model?: string | null } = {},
): Thread {
  const now = init.now ?? Date.now();
  return {
    v: THREAD_VERSION,
    id: init.id ?? newId(),
    title: 'New chat',
    named: false,
    createdAt: now,
    updatedAt: now,
    rev: 0,
    system: init.system ?? '',
    model: init.model ?? null,
    nodes: {},
    roots: [],
    selected: null,
  };
}

export const isEmpty = (thread: Thread): boolean => thread.roots.length === 0;

/** The child ids of `parent` (null: the roots). */
export function childrenOf(thread: Thread, parent: string | null): string[] {
  return parent === null ? thread.roots : (thread.nodes[parent]?.children ?? []);
}

function selectedOf(thread: Thread, parent: string | null): string | null {
  return parent === null ? thread.selected : (thread.nodes[parent]?.selected ?? null);
}

function select(thread: Thread, parent: string | null, child: string | null): void {
  if (parent === null) thread.selected = child;
  else {
    const node = thread.nodes[parent];
    if (node) node.selected = child;
  }
}

/** The messages on screen: the selected root, then each node's selected child. */
export function activePath(thread: Thread): ChatNode[] {
  const path: ChatNode[] = [];
  const seen = new Set<string>();
  let id = thread.selected;
  while (id !== null && !seen.has(id)) {
    const node = thread.nodes[id];
    if (!node) break;
    seen.add(id);
    path.push(node);
    id = node.selected;
  }
  return path;
}

/** The messages from the root down to `id` (inclusive), or [] when `id` is unknown. */
export function pathTo(thread: Thread, id: string): ChatNode[] {
  const path: ChatNode[] = [];
  const seen = new Set<string>();
  let node = thread.nodes[id];
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    path.unshift(node);
    node = node.parent === null ? undefined : thread.nodes[node.parent];
  }
  return path;
}

/** The last message of the active path, or null for an empty thread. */
export function leaf(thread: Thread): ChatNode | null {
  return activePath(thread).at(-1) ?? null;
}

type NodeInit = Omit<ChatNode, 'id' | 'parent' | 'children' | 'selected' | 'createdAt'> & {
  id?: string;
  createdAt?: number;
};

/** Adds a message as the last child of `parent` (null: a new root) and selects it. */
export function addNode(thread: Thread, parent: string | null, init: NodeInit): ChatNode {
  if (parent !== null && !thread.nodes[parent]) throw new Error(`Unknown message ${parent}`);
  const node: ChatNode = {
    ...init,
    id: init.id ?? newId(),
    parent,
    children: [],
    selected: null,
    createdAt: init.createdAt ?? Date.now(),
  };
  thread.nodes[node.id] = node;
  childrenOf(thread, parent).push(node.id);
  select(thread, parent, node.id);
  thread.updatedAt = Math.max(thread.updatedAt, node.createdAt);
  if (!thread.named && node.role === 'user' && parent === null && thread.roots.length === 1) {
    thread.title = titleFrom(node.content || node.attachments?.[0]?.name || '');
  }
  return node;
}

/** Appends a user message after the end of the active path. */
export function appendUser(
  thread: Thread,
  content: string,
  attachments: AttachmentRef[] = [],
): ChatNode {
  return addNode(thread, leaf(thread)?.id ?? null, {
    role: 'user',
    content,
    ...(attachments.length > 0 ? { attachments } : {}),
  });
}

/** Editing a user message: a new sibling with the new text (same attachments), selected. */
export function editUser(thread: Thread, id: string, content: string): ChatNode {
  const original = thread.nodes[id];
  if (original?.role !== 'user') throw new Error(`Not a user message: ${id}`);
  return addNode(thread, original.parent, {
    role: 'user',
    content,
    ...(original.attachments?.length ? { attachments: original.attachments } : {}),
  });
}

/** Regenerating a reply: a new, empty sibling reply, selected. */
export function regenerate(thread: Thread, id: string, model: string): ChatNode {
  const original = thread.nodes[id];
  if (original?.role !== 'assistant') throw new Error(`Not a reply: ${id}`);
  return addNode(thread, original.parent, {
    role: 'assistant',
    content: '',
    model,
    status: 'streaming',
  });
}

/** Where a message sits among its siblings: `index` of `count` (0-based). */
export function siblingInfo(thread: Thread, id: string): { index: number; count: number } {
  const node = thread.nodes[id];
  if (!node) return { index: 0, count: 0 };
  const siblings = childrenOf(thread, node.parent);
  return { index: siblings.indexOf(id), count: siblings.length };
}

/** Shows the previous (-1) or next (+1) sibling of `id`; returns the newly selected id (or null at an end). */
export function selectSibling(thread: Thread, id: string, delta: -1 | 1): string | null {
  const node = thread.nodes[id];
  if (!node) return null;
  const siblings = childrenOf(thread, node.parent);
  const next = siblings[siblings.indexOf(id) + delta];
  if (next === undefined) return null;
  select(thread, node.parent, next);
  return next;
}

/** What `deleteBranch` took out, enough to put it back (`restoreBranch`). */
export interface RemovedBranch {
  parent: string | null;
  /** Its place among its siblings. */
  index: number;
  /** It was its parent's selected child. */
  selected: boolean;
  /** The removed messages, parents before children. */
  nodes: ChatNode[];
}

/** Removes a message and everything after it on every branch below it; null when `id` is unknown. */
export function deleteBranch(thread: Thread, id: string): RemovedBranch | null {
  const node = thread.nodes[id];
  if (!node) return null;
  const nodes: ChatNode[] = [];
  const queue = [id];
  while (queue.length > 0) {
    const current = thread.nodes[queue.shift()!];
    if (!current) continue;
    nodes.push(current);
    queue.push(...current.children);
    delete thread.nodes[current.id];
  }
  const siblings = childrenOf(thread, node.parent);
  const index = siblings.indexOf(id);
  if (index >= 0) siblings.splice(index, 1);
  const selected = selectedOf(thread, node.parent) === id;
  if (selected) {
    // The neighbour that took its place, else the one before it, else nothing.
    select(thread, node.parent, siblings[index] ?? siblings[index - 1] ?? null);
  }
  return { parent: node.parent, index: Math.max(0, index), selected, nodes };
}

/**
 * Puts a deleted branch back into the thread as it is now (whatever happened since stays). False, and nothing
 * changes, when the branch's parent is gone or the branch is already back.
 */
export function restoreBranch(thread: Thread, removed: RemovedBranch): boolean {
  const [top] = removed.nodes;
  if (!top) return false;
  if (removed.parent !== null && !thread.nodes[removed.parent]) return false;
  if (removed.nodes.some((node) => thread.nodes[node.id])) return false;
  for (const node of removed.nodes) thread.nodes[node.id] = node;
  const siblings = childrenOf(thread, removed.parent);
  siblings.splice(Math.min(removed.index, siblings.length), 0, top.id);
  if (removed.selected || selectedOf(thread, removed.parent) === null) {
    select(thread, removed.parent, top.id);
  }
  return true;
}

/** Ids of every attachment in the thread (all branches). */
export function attachmentIds(thread: Thread): Set<string> {
  const ids = new Set<string>();
  for (const node of Object.values(thread.nodes)) {
    for (const ref of node.attachments ?? []) ids.add(ref.id);
  }
  return ids;
}

/** Usage of every reply in the thread, on every branch (each one was paid for). */
export function threadTotals(thread: Thread): ThreadTotals {
  const totals: ThreadTotals = {
    replies: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    latencyMs: 0,
    approximate: false,
  };
  for (const node of Object.values(thread.nodes)) {
    if (node.role !== 'assistant' || !node.usage) continue;
    totals.replies++;
    totals.promptTokens += node.usage.promptTokens;
    totals.completionTokens += node.usage.completionTokens;
    totals.costUsd += node.usage.costUsd;
    totals.latencyMs += node.usage.latencyMs;
    if (node.usage.costEstimated || node.usage.costUnknown) totals.approximate = true;
  }
  return totals;
}

/** Normalised search text per thread, kept while the thread is unchanged (`rev`, title, message count). */
const searchCache = new WeakMap<Thread, { stamp: string; text: string }>();

function searchText(thread: Thread): string {
  const stamp = `${thread.rev}\u0000${thread.title}\u0000${Object.keys(thread.nodes).length}`;
  const hit = searchCache.get(thread);
  if (hit?.stamp === stamp) return hit.text;
  const text = normalize(
    [thread.title, ...Object.values(thread.nodes).map((node) => node.content)].join('\n'),
  );
  searchCache.set(thread, { stamp, text });
  return text;
}

/**
 * True when every word of a search (already normalised, `queryWords` of src/ui/shell/palette-search.ts) is in
 * the title or the text of some message, on any branch; accents and case do not matter.
 */
export function matchesQuery(thread: Thread, words: readonly string[]): boolean {
  if (words.length === 0) return true;
  const text = searchText(thread);
  return words.every((word) => text.includes(word));
}

// --- changes from other tabs ----------------------------------------------------------------------------

/** What a tab knew of a thread when it last read or wrote it: the base of a three-way merge. */
export interface ThreadBase {
  rev: number;
  ids: ReadonlySet<string>;
  title: string;
  named: boolean;
  system: string;
  model: string | null;
}

export function baseOf(thread: Thread): ThreadBase {
  return {
    rev: thread.rev,
    ids: new Set(Object.keys(thread.nodes)),
    title: thread.title,
    named: thread.named,
    system: thread.system,
    model: thread.model,
  };
}

/** How final a reply is: a finished one beats a stopped or failed one, which beats one still streaming. */
const replyRank = (node: ChatNode): number =>
  node.status === 'done' ? 2 : node.status === 'streaming' ? 0 : 1;

const REPLY_FIELDS = [
  'content',
  'model',
  'servedModel',
  'reasoning',
  'usage',
  'status',
  'error',
  'outcomeUnknown',
  'trimmed',
] as const;

/**
 * Merges `theirs` (the stored version another tab wrote) into `ours` (this tab's, changed since `base`), in
 * place, so references to `ours` and its messages stay valid. Messages either side added are kept; messages either
 * side deleted stay deleted; a reply keeps its most final version (one still streaming here is never touched);
 * the title, system prompt and model are ours where we changed them, else theirs. `ours.rev` becomes theirs.
 */
export function mergeInto(ours: Thread, base: ThreadBase, theirs: Thread): void {
  if (ours.title === base.title && ours.named === base.named) {
    ours.title = theirs.title;
    ours.named = theirs.named;
  }
  if (ours.system === base.system) ours.system = theirs.system;
  if (ours.model === base.model) ours.model = theirs.model;
  // Their deletions: messages we both had that they no longer have.
  for (const id of base.ids) if (ours.nodes[id] && !theirs.nodes[id]) delete ours.nodes[id];
  for (const node of Object.values(theirs.nodes)) {
    const mine = ours.nodes[node.id];
    if (!mine) {
      // Theirs alone: they added it (or we deleted it, then it stays deleted).
      if (!base.ids.has(node.id)) ours.nodes[node.id] = structuredClone(node);
      continue;
    }
    mine.children = [
      ...node.children,
      ...mine.children.filter((id) => !node.children.includes(id)),
    ];
    if (node.role === 'assistant' && mine.status !== 'streaming') {
      const newer =
        replyRank(node) > replyRank(mine) ||
        (replyRank(node) === replyRank(mine) && node.content.length > mine.content.length);
      if (newer) {
        const target = mine as unknown as Record<string, unknown>;
        const source = node as unknown as Record<string, unknown>;
        for (const field of REPLY_FIELDS) {
          if (source[field] === undefined) delete target[field];
          else target[field] = structuredClone(source[field]);
        }
      }
    }
  }
  ours.rev = Math.max(ours.rev, theirs.rev);
  ours.updatedAt = Math.max(ours.updatedAt, theirs.updatedAt);
  relink(ours, [...theirs.roots, ...ours.roots.filter((id) => !theirs.roots.includes(id))]);
}

// --- storage (a Thread is JSON-safe by construction and stored as it is) -------------------------------

const ATTACHMENT_KINDS: readonly AttachmentKind[] = ['image', 'pdf', 'audio', 'text'];
const STATUSES: readonly ReplyStatus[] = ['streaming', 'done', 'stopped', 'error'];

const finite = (value: unknown, fallback: number): number =>
  isFiniteNumber(value) ? value : fallback;

function parseAttachment(raw: unknown): AttachmentRef | null {
  if (!isPlainObject(raw)) return null;
  const { id, name, type, size, kind, text } = raw;
  if (!isString(id) || !isString(name) || !ATTACHMENT_KINDS.includes(kind as AttachmentKind)) {
    return null;
  }
  return {
    id,
    name,
    type: isString(type) ? type : '',
    size: Math.max(0, finite(size, 0)),
    kind: kind as AttachmentKind,
    ...(kind === 'text' && isString(text) ? { text } : {}),
    ...(kind === 'pdf' && isString(raw['parsed']) && raw['parsed']
      ? { parsed: raw['parsed'] }
      : {}),
  };
}

function parseUsage(raw: unknown): ReplyUsage | undefined {
  if (!isPlainObject(raw)) return undefined;
  return {
    promptTokens: Math.max(0, finite(raw['promptTokens'], 0)),
    completionTokens: Math.max(0, finite(raw['completionTokens'], 0)),
    costUsd: Math.max(0, finite(raw['costUsd'], 0)),
    latencyMs: Math.max(0, finite(raw['latencyMs'], 0)),
    ...(raw['costEstimated'] === true ? { costEstimated: true } : {}),
    ...(raw['costUnknown'] === true ? { costUnknown: true } : {}),
  };
}

/** One node with only the fields we know, or null when it is unusable. Links are checked by the caller. */
function parseNode(raw: unknown, fallbackTime: number): ChatNode | null {
  if (!isPlainObject(raw)) return null;
  const { id, role, content } = raw;
  if (!isString(id) || isUnsafeKey(id) || (role !== 'user' && role !== 'assistant')) return null;
  const node: ChatNode = {
    id,
    parent: isString(raw['parent']) ? raw['parent'] : null,
    children: Array.isArray(raw['children']) ? raw['children'].filter(isString) : [],
    selected: isString(raw['selected']) ? raw['selected'] : null,
    role,
    content: isString(content) ? content : '',
    createdAt: finite(raw['createdAt'], fallbackTime),
  };
  if (role === 'user' && Array.isArray(raw['attachments'])) {
    const attachments = raw['attachments']
      .map(parseAttachment)
      .filter((item): item is AttachmentRef => item !== null);
    if (attachments.length > 0) node.attachments = attachments;
  }
  if (role === 'assistant') {
    if (isString(raw['model'])) node.model = raw['model'];
    if (isString(raw['servedModel'])) node.servedModel = raw['servedModel'];
    if (isString(raw['reasoning']) && raw['reasoning']) node.reasoning = raw['reasoning'];
    const usage = parseUsage(raw['usage']);
    if (usage) node.usage = usage;
    const status = raw['status'];
    // A reply still streaming when the page went away is as far as it got.
    node.status = STATUSES.includes(status as ReplyStatus)
      ? status === 'streaming'
        ? 'stopped'
        : (status as ReplyStatus)
      : 'done';
    if (isString(raw['error'])) node.error = raw['error'];
    if (node.status === 'error' && raw['outcomeUnknown'] === true) node.outcomeUnknown = true;
    if (isFiniteNumber(raw['trimmed']) && raw['trimmed'] > 0) node.trimmed = raw['trimmed'];
  }
  return node;
}

/**
 * Re-links nodes from their `parent` pointers (the source of truth), keeping the stored child order where it is
 * consistent, dropping nodes whose parent is missing (with everything below them) and fixing selections.
 */
function relink(thread: Thread, storedRoots: string[]): void {
  const nodes = thread.nodes;
  // Drop orphans until none is left (a dropped node orphans its children).
  for (let changed = true; changed;) {
    changed = false;
    for (const node of Object.values(nodes)) {
      if (node.parent !== null && (!nodes[node.parent] || node.parent === node.id)) {
        delete nodes[node.id];
        changed = true;
      }
    }
  }
  const byParent = new Map<string | null, ChatNode[]>();
  for (const node of Object.values(nodes)) {
    const list = byParent.get(node.parent) ?? [];
    list.push(node);
    byParent.set(node.parent, list);
  }
  const ordered = (parent: string | null, stored: string[]): string[] => {
    const actual = byParent.get(parent) ?? [];
    const ids = new Set(actual.map((node) => node.id));
    const kept = [...new Set(stored)].filter((id) => ids.has(id));
    const rest = actual
      .filter((node) => !kept.includes(node.id))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((node) => node.id);
    return [...kept, ...rest];
  };
  thread.roots = ordered(null, storedRoots);
  if (thread.selected === null || !thread.roots.includes(thread.selected)) {
    thread.selected = thread.roots.at(-1) ?? null;
  }
  for (const node of Object.values(nodes)) {
    node.children = ordered(node.id, node.children);
    if (node.selected === null || !node.children.includes(node.selected)) {
      node.selected = node.children.at(-1) ?? null;
    }
  }
  // Nodes that no root reaches (a parent cycle) can never be shown: drop them.
  const reached = new Set<string>();
  const stack = [...thread.roots];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    stack.push(...(nodes[id]?.children ?? []));
  }
  for (const id of Object.keys(nodes)) if (!reached.has(id)) delete nodes[id];
}

/** A thread from the linear form (`{ title, system, messages: [{ role, content, model }] }`, our JSON export). */
function fromLinear(raw: Record<string, unknown>, now: number): Thread | null {
  const messages = raw['messages'];
  if (!Array.isArray(messages)) return null;
  const thread = createThread({
    ...(isString(raw['id']) && !isUnsafeKey(raw['id']) ? { id: raw['id'] } : {}),
    now: finite(raw['createdAt'], now),
    system: isString(raw['system']) ? raw['system'] : '',
  });
  let parent: string | null = null;
  for (const message of messages) {
    if (!isPlainObject(message)) continue;
    const role = message['role'];
    const content = message['content'];
    if ((role !== 'user' && role !== 'assistant') || !isString(content)) continue;
    const node = addNode(thread, parent, {
      role,
      content,
      createdAt: finite(message['createdAt'], thread.createdAt),
      ...(role === 'assistant'
        ? {
            status: 'done' as const,
            ...(isString(message['model']) ? { model: message['model'] } : {}),
          }
        : {}),
    });
    parent = node.id;
  }
  if (isString(raw['title']) && raw['title'].trim()) {
    thread.title = raw['title'].trim();
    thread.named = true;
  }
  thread.updatedAt = finite(raw['updatedAt'], thread.updatedAt);
  return thread;
}

/**
 * A stored thread, validated and repaired, or null when it is unusable. Accepts the current version and the
 * linear form (no `v`); a newer version than this code knows is refused (and left in storage untouched).
 */
export function parseThread(raw: unknown, now: number = Date.now()): Thread | null {
  if (!isPlainObject(raw)) return null;
  const version = raw['v'];
  if (version === undefined) return fromLinear(raw, now);
  if (version !== THREAD_VERSION) return null;
  const id = raw['id'];
  if (!isString(id) || !id || isUnsafeKey(id) || !isPlainObject(raw['nodes'])) return null;
  const createdAt = finite(raw['createdAt'], now);
  const thread: Thread = {
    v: THREAD_VERSION,
    id,
    title: isString(raw['title']) && raw['title'].trim() ? raw['title'] : 'New chat',
    named: raw['named'] === true,
    createdAt,
    updatedAt: finite(raw['updatedAt'], createdAt),
    rev: Math.max(0, Math.floor(finite(raw['rev'], 0))),
    system: isString(raw['system']) ? raw['system'] : '',
    model: isString(raw['model']) && raw['model'] ? raw['model'] : null,
    nodes: {},
    roots: [],
    selected: isString(raw['selected']) ? raw['selected'] : null,
  };
  for (const [key, value] of Object.entries(raw['nodes'])) {
    const node = parseNode(value, createdAt);
    if (node && node.id === key) thread.nodes[key] = node;
  }
  relink(thread, Array.isArray(raw['roots']) ? raw['roots'].filter(isString) : []);
  return thread;
}
