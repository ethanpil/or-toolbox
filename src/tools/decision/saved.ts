/**
 * Saved deciders: a named question set, optionally with the situation it was written for, kept in the tool's
 * state (IndexedDB `kv`, JSON only). Each decider is its own key (`decider:<id>`), so two tabs saving, renaming
 * or deleting different ones never overwrite each other (one array under one key would lose updates), and an
 * Undo puts back exactly the record that was removed, under its old id.
 *
 * Everything read from storage goes through `readDecider`: a record that is not valid is skipped, never trusted.
 */
import type { ToolStateStore } from '../../core/types';
import { isFiniteNumber, isRecord, isString } from '../../core/util';
import { hasSituation, type QuestionDef, readQuestions, readState, type StateDef } from './schema';

export interface SavedDecider {
  id: string;
  name: string;
  questions: QuestionDef[];
  /** The situation saved with the questions, or null when only the questions were. */
  state: StateDef | null;
  savedAt: number;
}

const PREFIX = 'decider:';
const storeKey = (id: string): string => `${PREFIX}${id}`;

export function readDecider(value: unknown): SavedDecider | null {
  if (!isRecord(value) || !isString(value['id']) || !value['id']) return null;
  if (!isString(value['name']) || !value['name'].trim()) return null;
  const questions = readQuestions(value['questions']);
  if (!questions || questions.length === 0) return null;
  const state = value['state'];
  return {
    id: value['id'],
    name: value['name'].trim(),
    questions,
    state: isRecord(state)
      ? readState({ mode: state['mode'], text: state['text'], fields: state['fields'] })
      : null,
    savedAt: isFiniteNumber(value['savedAt']) ? value['savedAt'] : 0,
  };
}

/** Alphabetical, the way a list of names is read. */
export function sortDeciders(list: readonly SavedDecider[]): SavedDecider[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export async function loadDeciders(store: ToolStateStore): Promise<SavedDecider[]> {
  const keys = (await store.keys()).filter((key) => key.startsWith(PREFIX));
  const found = await Promise.all(
    keys.map((key) => store.get<unknown>(key).then(readDecider, () => null)),
  );
  return sortDeciders(found.flatMap((decider) => decider ?? []));
}

export function saveDecider(store: ToolStateStore, decider: SavedDecider): Promise<void> {
  return store.set(storeKey(decider.id), decider);
}

export function removeDecider(store: ToolStateStore, id: string): Promise<void> {
  return store.delete(storeKey(id));
}

/** The decider with this name, ignoring case and surrounding spaces. */
export function findByName(list: readonly SavedDecider[], name: string): SavedDecider | undefined {
  const wanted = name.trim().toLowerCase();
  return list.find((decider) => decider.name.toLowerCase() === wanted);
}

export function newDeciderId(): string {
  return crypto.randomUUID();
}

export interface LoadLoss {
  /** The questions in the form were edited since they were loaded or saved. */
  questions: boolean;
  /** The decider brings a situation that would replace a different one in the form. */
  situation: boolean;
}

/** What loading a decider into the form would throw away, so the person is asked before it happens. */
export function lossOnLoad(input: {
  questionsEdited: boolean;
  current: StateDef;
  incoming: StateDef | null;
}): LoadLoss {
  const { current, incoming } = input;
  return {
    questions: input.questionsEdited,
    situation:
      incoming !== null &&
      hasSituation(current) &&
      JSON.stringify(current) !== JSON.stringify(incoming),
  };
}
