/**
 * The Decision tool's data model and rules, with no DOM: the questions and the situation as the form holds them,
 * how they are validated, the request they become (docs/openrouter-api.md §8.1) and what the page reads back
 * from storage. The builder, the templates and the saved deciders all speak `QuestionDef`.
 *
 * A `QuestionDef` is flat on purpose: it keeps the Yes/No criteria, the options and the levels at the same time,
 * and only the ones of its current type reach the request, so switching a question's type loses nothing the user
 * typed (the image tools do the same with model parameters).
 */
import type { DecisionQuestion, DecisionRequest, DecisionValue } from '../../core/api/types';
import { isFiniteNumber, isRecord, isString, isUnsafeKey } from '../../core/util';

export const QUESTION_TYPES = ['noul', 'choice', 'score'] as const;
/** The wire names: `noul` is the Yes/No question. */
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const TYPE_LABELS: Readonly<Record<QuestionType, string>> = {
  noul: 'Yes/No',
  choice: 'Choice',
  score: 'Score',
};

/** The confidence a question's answer must reach to be called clear, in percent. */
export const DEFAULT_THRESHOLD = 80;
export const MIN_OPTIONS = 2;
export const MIN_LEVELS = 2;

export interface OptionDef {
  name: string;
  /** Optional; sent as `null` when empty. */
  description: string;
}

/** One question as the form, a template, a saved decider and a run's settings hold it. JSON-safe. */
export interface QuestionDef {
  /** Short name shown on the question's card and in the results. */
  name: string;
  /** The key of the question in the request and in the answers: a slug of the name, editable. */
  id: string;
  instructions: string;
  type: QuestionType;
  /** Percent, 0 to 100: the confidence below which an answer "needs review". */
  threshold: number;
  /** Yes/No: what makes the answer yes and no (both or neither). */
  yes: string;
  no: string;
  /** Choice: at least two, with unique names. */
  options: OptionDef[];
  /** Score: the scale, lowest first, at least two. */
  levels: string[];
}

export type StateMode = 'text' | 'fields';

export interface FieldRow {
  key: string;
  value: string;
}

/** The situation being judged: a text block or key-value fields (the other is kept while one is in use). */
export interface StateDef {
  mode: StateMode;
  text: string;
  fields: FieldRow[];
}

export function isQuestionType(value: unknown): value is QuestionType {
  return typeof value === 'string' && (QUESTION_TYPES as readonly string[]).includes(value);
}

/** Clamps to 0..100; anything that is not a number is the default. */
export function thresholdOf(value: unknown): number {
  return isFiniteNumber(value) ? Math.min(100, Math.max(0, value)) : DEFAULT_THRESHOLD;
}

export function blankQuestion(threshold: number = DEFAULT_THRESHOLD): QuestionDef {
  return {
    name: '',
    id: '',
    instructions: '',
    type: 'noul',
    threshold: thresholdOf(threshold),
    yes: '',
    no: '',
    options: [
      { name: '', description: '' },
      { name: '', description: '' },
    ],
    levels: ['', ''],
  };
}

export function blankState(): StateDef {
  return { mode: 'text', text: '', fields: [{ key: '', value: '' }] };
}

// --- ids -------------------------------------------------------------------------------------------------

const MAX_ID_LENGTH = 40;

/** `Is it a bug?` → `is_it_a_bug`: lower-case ASCII letters, digits and single underscores. May be empty. */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+/, '')
    .slice(0, MAX_ID_LENGTH)
    .replace(/_+$/, '');
}

/**
 * `base`, else `base_2`, `base_3`… (an empty base is `question`). Keys the response parser drops (`__proto__`,
 * `constructor`, `prototype`: src/core/util.ts `parseJsonSafe`) count as taken, since an answer filed under one
 * would never arrive.
 */
export function uniqueId(base: string, taken: readonly string[]): string {
  const stem = base || 'question';
  let id = stem;
  for (let n = 2; taken.includes(id) || isUnsafeKey(id); n++) id = `${stem}_${n}`;
  return id;
}

/** True when `id` is what the name would have produced (so a rename may keep it in step). */
export function isDerivedId(id: string, name: string): boolean {
  const base = slugify(name) || 'question';
  return id === base || new RegExp(`^${base}_\\d+$`).test(id);
}

// --- reading what storage returns ------------------------------------------------------------------------

const text = (value: unknown): string => (isString(value) ? value : '');

function readOptions(value: unknown): OptionDef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): OptionDef[] =>
    isRecord(item) ? [{ name: text(item['name']), description: text(item['description']) }] : [],
  );
}

export function readQuestion(value: unknown): QuestionDef | null {
  if (!isRecord(value)) return null;
  const name = text(value['name']);
  const rawId = text(value['id']);
  const blank = blankQuestion();
  const options = readOptions(value['options']);
  const levels = Array.isArray(value['levels']) ? value['levels'].filter(isString) : [];
  return {
    name,
    id: rawId || slugify(name),
    instructions: text(value['instructions']),
    type: isQuestionType(value['type']) ? value['type'] : 'noul',
    threshold: thresholdOf(value['threshold']),
    yes: text(value['yes']),
    no: text(value['no']),
    options: options.length > 0 ? options : blank.options,
    levels: levels.length > 0 ? levels : blank.levels,
  };
}

/** A list of questions from storage or a snapshot; null when it is not a list at all. */
export function readQuestions(value: unknown): QuestionDef[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((item) => readQuestion(item) ?? []);
}

export function readFieldRows(value: unknown): FieldRow[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((item): FieldRow[] =>
    isRecord(item) ? [{ key: text(item['key']), value: text(item['value']) }] : [],
  );
}

export function readState(value: { mode?: unknown; text?: unknown; fields?: unknown }): StateDef {
  return {
    mode: value.mode === 'fields' ? 'fields' : 'text',
    text: text(value.text),
    fields: readFieldRows(value.fields) ?? [],
  };
}

// --- validation ------------------------------------------------------------------------------------------

export type ProblemField =
  | 'questions'
  | 'name'
  | 'id'
  | 'instructions'
  | 'threshold'
  | 'yes'
  | 'no'
  | 'options'
  | 'option'
  | 'levels'
  | 'level';

export interface Problem {
  /** Index of the question; -1 for the whole list. */
  question: number;
  field: ProblemField;
  /** The option or level, for `option` and `level`. */
  item?: number;
  message: string;
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Every reason the questions cannot be sent, in the order the form shows them (the first is what to fix first). */
export function validateQuestions(questions: readonly QuestionDef[]): Problem[] {
  const problems: Problem[] = [];
  if (questions.length === 0) {
    return [{ question: -1, field: 'questions', message: 'Add at least one question.' }];
  }
  const ids = questions.map((question) => question.id.trim());
  questions.forEach((question, index) => {
    const add = (field: ProblemField, message: string, item?: number): void => {
      problems.push({ question: index, field, message, ...(item === undefined ? {} : { item }) });
    };
    if (!question.name.trim()) add('name', 'Give the question a short name.');
    const id = question.id.trim();
    // A blank id only matters once there is a name to make it from (the name's own message comes first).
    if (!id) {
      if (question.name.trim()) add('id', 'Give the question an id.');
    } else if (ids.indexOf(id) !== index) {
      add('id', `Another question already uses “${id}”.`);
    } else if (isUnsafeKey(id)) {
      add('id', `“${id}” cannot be an id: answers filed under it are dropped. Use another.`);
    }
    if (!question.instructions.trim()) add('instructions', 'Tell the model what to decide.');
    if (!isFiniteNumber(question.threshold) || question.threshold < 0 || question.threshold > 100) {
      add('threshold', 'Use a percentage from 0 to 100.');
    }
    if (question.type === 'noul') {
      const yes = question.yes.trim();
      const no = question.no.trim();
      if (yes && !no) add('no', 'Describe the No case too, or clear the Yes criteria.');
      if (no && !yes) add('yes', 'Describe the Yes case too, or clear the No criteria.');
    } else if (question.type === 'choice') {
      if (question.options.length < MIN_OPTIONS) {
        add('options', `Add at least ${MIN_OPTIONS} options.`);
      }
      question.options.forEach((option, i) => {
        if (!option.name.trim()) {
          add('option', 'Give the option a name.', i);
        } else if (question.options.findIndex((other) => same(other.name, option.name)) !== i) {
          add('option', `Another option is already called “${option.name.trim()}”.`, i);
        } else if (isUnsafeKey(option.name.trim())) {
          add(
            'option',
            `“${option.name.trim()}” cannot be an option name: its probability would be dropped. Use another.`,
            i,
          );
        }
      });
    } else {
      if (question.levels.length < MIN_LEVELS) add('levels', `Add at least ${MIN_LEVELS} levels.`);
      question.levels.forEach((level, i) => {
        if (!level.trim()) add('level', 'Describe this level.', i);
      });
    }
  });
  return problems;
}

export interface StateProblem {
  field: 'text' | 'rows' | 'key';
  /** The row, for `key`. */
  row?: number;
  message: string;
}

const isBlankRow = (row: FieldRow): boolean => !row.key.trim() && !row.value.trim();

export function validateState(state: StateDef): StateProblem[] {
  if (state.mode === 'text') {
    return state.text.trim()
      ? []
      : [{ field: 'text', message: 'Describe the situation to decide on.' }];
  }
  const rows = state.fields.filter((row) => !isBlankRow(row));
  if (rows.length === 0) {
    return [{ field: 'rows', message: 'Add at least one field with a value.' }];
  }
  const problems: StateProblem[] = [];
  state.fields.forEach((row, index) => {
    if (isBlankRow(row)) return;
    const key = row.key.trim();
    if (!key) {
      problems.push({ field: 'key', row: index, message: 'Give this field a name.' });
    } else if (state.fields.findIndex((other) => other.key.trim() === key) !== index) {
      problems.push({ field: 'key', row: index, message: `“${key}” is used by another field.` });
    }
  });
  return problems;
}

// --- the request -----------------------------------------------------------------------------------------

/** What the model is asked to judge: the text block, or an object of the fields (blank rows left out). */
export function stateValue(state: StateDef): DecisionValue {
  if (state.mode === 'text') return state.text.trim();
  return Object.fromEntries(
    state.fields.filter((row) => !isBlankRow(row)).map((row) => [row.key.trim(), row.value.trim()]),
  );
}

export function wireQuestion(question: QuestionDef): DecisionQuestion {
  const instructions = question.instructions.trim();
  if (question.type === 'noul') {
    const yes = question.yes.trim();
    const no = question.no.trim();
    return {
      type: 'noul',
      instructions,
      ...(yes && no ? { criteria: { true: yes, false: no } } : {}),
    };
  }
  if (question.type === 'choice') {
    return {
      type: 'choice',
      instructions,
      criteria: Object.fromEntries(
        question.options
          .filter((option) => option.name.trim())
          .map((option) => [option.name.trim(), option.description.trim() || null]),
      ),
    };
  }
  return { type: 'score', instructions, criteria: question.levels.map((level) => level.trim()) };
}

/**
 * The request body for `POST /api/alpha/decisions`. It trusts its input: validate first (the estimate builds one
 * from a half-filled form and does not mind).
 */
export function buildRequest(
  model: string,
  state: StateDef,
  questions: readonly QuestionDef[],
): DecisionRequest {
  return {
    model,
    state: stateValue(state),
    questions: Object.fromEntries(
      questions.map((question) => [question.id.trim(), wireQuestion(question)]),
    ),
  };
}

/** A short label for History: the question names. */
export function runTitle(questions: readonly QuestionDef[]): string {
  const names = questions.map((question) => question.name.trim() || question.id.trim());
  const joined = names.filter(Boolean).join(', ');
  const label = `Decide: ${joined || 'questions'}`;
  return label.length > 80 ? `${label.slice(0, 79)}…` : label;
}

/** Moves the item at `from` so it ends up at `to` (both indexes of the list as it is now). */
export function moveTo<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length) return next;
  const target = Math.min(Math.max(to, 0), next.length - 1);
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item as T);
  return next;
}

/** Moves an item one place up (-1) or down (+1). */
export function moveBy<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  return moveTo(list, index, index + delta);
}
