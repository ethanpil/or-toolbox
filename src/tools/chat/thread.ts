/**
 * Chat threads as a tree of messages. Editing a user message or regenerating a reply adds a sibling instead of
 * overwriting, so earlier branches stay reachable (‹ 1/3 ›). Each parent remembers which child is selected; the
 * **active path** (selected root, then each node's selected child) is what the conversation shows, what the next
 * request sends and what Export writes.
 *
 * Threads are JSON in the tool's state (`thread:<id>`, one key per thread). Attachments keep only their name, type
 * and size (text files also their text, which is what the model reads); image, PDF and audio bytes live in memory
 * for the session and are never stored. `parseThread` validates, repairs and migrates whatever storage returns.
 */
import { isFiniteNumber, isPlainObject, isString, isUnsafeKey } from '../../core/util';

export const THREAD_VERSION = 1;

export type AttachmentKind = 'image' | 'pdf' | 'audio' | 'text';

export interface AttachmentRef {
  id: string;
  name: string;
  /** MIME type. */
  type: string;
  size: number;
  kind: AttachmentKind;
  /** Text files only: the content, inlined into the message. Binaries are never kept. */
  text?: string;
}

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

/** Removes a message and everything after it on every branch below it. Returns the removed ids. */
export function deleteBranch(thread: Thread, id: string): string[] {
  const node = thread.nodes[id];
  if (!node) return [];
  const removed: string[] = [];
  const stack = [id];
  while (stack.length > 0) {
    const current = thread.nodes[stack.pop()!];
    if (!current) continue;
    removed.push(current.id);
    stack.push(...current.children);
    delete thread.nodes[current.id];
  }
  const siblings = childrenOf(thread, node.parent);
  const index = siblings.indexOf(id);
  if (index >= 0) siblings.splice(index, 1);
  if (selectedOf(thread, node.parent) === id) {
    // The neighbour that took its place, else the one before it, else nothing.
    select(thread, node.parent, siblings[index] ?? siblings[index - 1] ?? null);
  }
  return removed;
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

/** Case-insensitive match on the title and the text of every message (all branches). */
export function matchesQuery(thread: Thread, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (thread.title.toLowerCase().includes(needle)) return true;
  return Object.values(thread.nodes).some((node) => node.content.toLowerCase().includes(needle));
}

/** A deep copy (for Undo). */
export function cloneThread(thread: Thread): Thread {
  return structuredClone(thread);
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
