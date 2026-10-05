/**
 * The conversation between two bots, as stored in the tool's state (`conversation`, one per browser): the opening
 * prompt, the bots' turns, moderator messages and end markers, in order, plus the totals the limits count against
 * across pauses (time on the clock, money spent). Pure data and rules; tool.ts does the drawing and the runs.
 *
 * - **Entries** are `opener` (always first), `bot`, `moderator` and `end` (where a stop condition ended the loop; a
 *   Resume carries on after it). A bot turn records the name and model it spoke with, its status, usage and how
 *   many earlier entries were left out of its context.
 * - **Failed turns** (`status: 'error'`) are a record only: they are not sent to the bots, do not count as turns
 *   and do not decide who speaks next (the failed speaker tries again). Empty ones are dropped on the next Resume.
 * - **Who speaks next** is the other bot of the last turn spoken, or `first` before any turn.
 * - `rev` grows with every stored change; a tab that is not running follows a newer stored version.
 */
import { isFiniteNumber, isPlainObject, isString } from '../../core/util';

export const CONVERSATION_VERSION = 1;

export type Speaker = 'a' | 'b';
export const SPEAKERS: readonly Speaker[] = ['a', 'b'];
export const other = (speaker: Speaker): Speaker => (speaker === 'a' ? 'b' : 'a');

/** Why a conversation ended (the first stop condition hit). */
export type StopReason = 'turns' | 'time' | 'cost' | 'phrase' | 'stopped';
const STOP_REASONS: readonly StopReason[] = ['turns', 'time', 'cost', 'phrase', 'stopped'];

/** `cut`: the time limit ended it mid-stream; `stopped`: the Stop button did. Both keep the partial text. */
export type TurnStatus = 'streaming' | 'done' | 'cut' | 'stopped' | 'error';
const TURN_STATUSES: readonly TurnStatus[] = ['streaming', 'done', 'cut', 'stopped', 'error'];

export interface TurnUsage {
  promptTokens: number;
  completionTokens: number;
  /** What the turn cost (the estimate when the cost is unknown: `costUnknown`). */
  costUsd: number;
  latencyMs: number;
  costEstimated?: boolean;
  costUnknown?: boolean;
}

export type EntryKind = 'opener' | 'moderator' | 'bot' | 'end';
const ENTRY_KINDS: readonly EntryKind[] = ['opener', 'moderator', 'bot', 'end'];

export interface Entry {
  id: string;
  kind: EntryKind;
  /** The text; for an `end` entry, what ended it ("Turn limit reached (20 turns)"). */
  content: string;
  createdAt: number;
  /** Bot turns: who spoke, under which name and on which model. */
  speaker?: Speaker;
  name?: string;
  model?: string;
  status?: TurnStatus;
  error?: string;
  /** A failed turn whose request may have gone through and been billed (`isOutcomeUnknown`). */
  outcomeUnknown?: boolean;
  usage?: TurnUsage;
  /** Bot turns: earlier entries left out of this turn's context to fit the model's window. */
  trimmed?: number;
  edited?: boolean;
  /** `end` entries. */
  reason?: StopReason;
}

export interface BotRecord {
  name: string;
  /** The model it last spoke with. */
  model: string;
  persona: string;
}

export interface Conversation {
  version: number;
  id: string;
  rev: number;
  /**
   * New on every stored write: tabs tell versions apart by it (two tabs can write the same `rev`). A tab that is
   * idle and has no write pending shows the stored version whenever its `writeId` differs.
   */
  writeId?: string;
  createdAt: number;
  updatedAt: number;
  first: Speaker;
  /** The bots as set up for the last run (for exports and History). */
  bots: Record<Speaker, BotRecord>;
  entries: Entry[];
  /** Time on the clock so far: it runs only while the loop runs. */
  elapsedMs: number;
  /** Money spent so far, including turns removed since (an edit, a failure). */
  spentUsd: number;
  /** Some of `spentUsd` is an estimate. */
  spentApprox: boolean;
}

export const newId = (): string => crypto.randomUUID();

export function createConversation(input: {
  opener: string;
  first: Speaker;
  bots: Record<Speaker, BotRecord>;
  now?: number;
}): Conversation {
  const now = input.now ?? Date.now();
  return {
    version: CONVERSATION_VERSION,
    id: newId(),
    rev: 0,
    createdAt: now,
    updatedAt: now,
    first: input.first,
    bots: { a: { ...input.bots.a }, b: { ...input.bots.b } },
    entries: [{ id: newId(), kind: 'opener', content: input.opener, createdAt: now }],
    elapsedMs: 0,
    spentUsd: 0,
    spentApprox: false,
  };
}

/** A bot turn that was said (in full or in part): sent to the bots, counted, deciding who is next. */
export const isSpoken = (entry: Entry): boolean =>
  entry.kind === 'bot' && entry.status !== 'error' && entry.status !== 'streaming';

/** Turns the conversation has had (counted against the turn limit). */
export function turnCount(conversation: Conversation): number {
  return conversation.entries.filter(isSpoken).length;
}

/** Who speaks next: the other bot of the last turn spoken, else the first speaker. */
export function nextSpeaker(conversation: Conversation): Speaker {
  for (let i = conversation.entries.length - 1; i >= 0; i--) {
    const entry = conversation.entries[i]!;
    if (isSpoken(entry) && entry.speaker) return other(entry.speaker);
  }
  return conversation.first;
}

export const opener = (conversation: Conversation): string =>
  conversation.entries.find((entry) => entry.kind === 'opener')?.content ?? '';

/** The stop condition that ended the conversation, while that end is its last entry. */
export function endedBy(conversation: Conversation): StopReason | null {
  const last = conversation.entries.at(-1);
  return last?.kind === 'end' ? (last.reason ?? null) : null;
}

/** Drops failed turns that said nothing: the next turn retries them. True when any went. */
export function dropFailedEmpty(conversation: Conversation): boolean {
  const before = conversation.entries.length;
  conversation.entries = conversation.entries.filter(
    (entry) => !(entry.kind === 'bot' && entry.status === 'error' && !entry.content.trim()),
  );
  return conversation.entries.length !== before;
}

export function touch(conversation: Conversation, now = Date.now()): void {
  conversation.updatedAt = now;
}

/** What an edit removed, for Undo. */
export interface EditUndo {
  id: string;
  previous: string;
  previousEdited: boolean;
  previousStatus: TurnStatus | undefined;
  /** The text the edit wrote: Undo applies only while the entry still says it. */
  written: string;
  removed: Entry[];
}

/**
 * Replaces an entry's text and removes everything after it (the conversation goes on from there). An edited turn
 * that was cut or stopped counts as finished. Returns what Undo needs, or null when the entry is gone or cannot be
 * edited (an end marker, a failed or streaming turn).
 */
export function editEntry(conversation: Conversation, id: string, text: string): EditUndo | null {
  const index = conversation.entries.findIndex((entry) => entry.id === id);
  const entry = conversation.entries[index];
  if (!entry || entry.kind === 'end') return null;
  if (entry.kind === 'bot' && (entry.status === 'error' || entry.status === 'streaming')) {
    return null;
  }
  const undo: EditUndo = {
    id,
    previous: entry.content,
    previousEdited: entry.edited === true,
    previousStatus: entry.status,
    written: text,
    removed: conversation.entries.slice(index + 1),
  };
  entry.content = text;
  entry.edited = true;
  if (entry.kind === 'bot') entry.status = 'done';
  conversation.entries = conversation.entries.slice(0, index + 1);
  return undo;
}

/**
 * Takes an edit back: the old text and the removed entries return, but only while the edited entry is still the
 * last one and still says what the edit wrote (nothing happened since). True when it was undone.
 */
export function undoEdit(conversation: Conversation, undo: EditUndo): boolean {
  const last = conversation.entries.at(-1);
  if (last?.id !== undo.id || last.content !== undo.written) return false;
  last.content = undo.previous;
  if (undo.previousEdited) last.edited = true;
  else delete last.edited;
  if (undo.previousStatus) last.status = undo.previousStatus;
  conversation.entries.push(...undo.removed);
  return true;
}

// --- parsing ------------------------------------------------------------------------------------------------

const oneOf = <T extends string>(value: unknown, list: readonly T[]): value is T =>
  isString(value) && (list as readonly string[]).includes(value);

const count = (value: unknown): number => (isFiniteNumber(value) && value >= 0 ? value : 0);

function parseUsage(value: unknown): TurnUsage | undefined {
  if (!isPlainObject(value)) return undefined;
  const usage: TurnUsage = {
    promptTokens: count(value['promptTokens']),
    completionTokens: count(value['completionTokens']),
    costUsd: count(value['costUsd']),
    latencyMs: count(value['latencyMs']),
  };
  if (value['costEstimated'] === true) usage.costEstimated = true;
  if (value['costUnknown'] === true) usage.costUnknown = true;
  return usage;
}

function parseEntry(value: unknown): Entry | null {
  if (!isPlainObject(value)) return null;
  const { id, kind, content } = value;
  if (!isString(id) || !id || !oneOf(kind, ENTRY_KINDS) || !isString(content)) return null;
  const entry: Entry = {
    id,
    kind,
    content,
    createdAt: count(value['createdAt']),
  };
  if (value['edited'] === true) entry.edited = true;
  if (kind === 'end') {
    if (!oneOf(value['reason'], STOP_REASONS)) return null;
    entry.reason = value['reason'];
    return entry;
  }
  if (kind !== 'bot') return entry;
  const { speaker, name, model, status } = value;
  if (!oneOf(speaker, SPEAKERS) || !isString(name) || !isString(model)) return null;
  entry.speaker = speaker;
  entry.name = name;
  entry.model = model;
  entry.status = oneOf(status, TURN_STATUSES) ? status : 'done';
  if (isString(value['error'])) entry.error = value['error'];
  if (value['outcomeUnknown'] === true) entry.outcomeUnknown = true;
  const usage = parseUsage(value['usage']);
  if (usage) entry.usage = usage;
  if (count(value['trimmed']) > 0) entry.trimmed = Math.floor(count(value['trimmed']));
  return entry;
}

function parseBot(value: unknown, fallback: string): BotRecord {
  const record = isPlainObject(value) ? value : {};
  return {
    name: isString(record['name']) && record['name'].trim() ? record['name'] : fallback,
    model: isString(record['model']) ? record['model'] : '',
    persona: isString(record['persona']) ? record['persona'] : '',
  };
}

/**
 * A stored conversation, validated and repaired, or null when it cannot be used (missing, another version, no
 * opener). A turn left `streaming` (the page closed while it spoke) keeps its text as `stopped`, or goes when it had
 * none; entries that make no sense are dropped.
 */
export function parseConversation(value: unknown): Conversation | null {
  if (!isPlainObject(value) || value['version'] !== CONVERSATION_VERSION) return null;
  const { id } = value;
  if (!isString(id) || !id || !Array.isArray(value['entries'])) return null;
  const seen = new Set<string>();
  const entries: Entry[] = [];
  for (const raw of value['entries']) {
    const entry = parseEntry(raw);
    if (!entry || seen.has(entry.id)) continue;
    if (entry.kind === 'opener' && entries.length > 0) continue;
    if (entry.status === 'streaming') {
      if (!entry.content.trim()) continue;
      entry.status = 'stopped';
    }
    seen.add(entry.id);
    entries.push(entry);
  }
  if (entries[0]?.kind !== 'opener') return null;
  const bots = isPlainObject(value['bots']) ? value['bots'] : {};
  return {
    version: CONVERSATION_VERSION,
    id,
    rev: count(value['rev']),
    ...(isString(value['writeId']) ? { writeId: value['writeId'] } : {}),
    createdAt: count(value['createdAt']),
    updatedAt: count(value['updatedAt']),
    first: oneOf(value['first'], SPEAKERS) ? value['first'] : 'a',
    bots: { a: parseBot(bots['a'], 'Bot A'), b: parseBot(bots['b'], 'Bot B') },
    entries,
    elapsedMs: count(value['elapsedMs']),
    spentUsd: count(value['spentUsd']),
    spentApprox: value['spentApprox'] === true,
  };
}
