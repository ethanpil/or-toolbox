/**
 * The local vote tally: per model, the rounds it answered in a voted round, its wins, ties and "all bad" verdicts.
 * Stored as JSON in the tool's state (`tally`), changed only read-modify-write (arena.ts holds a Web Lock), and
 * validated whenever it is read.
 */
import { isFiniteNumber, isPlainObject, isUnsafeKey } from '../../core/util';
import { hasAnswer, type Round, type Vote } from './round';

export const TALLY_VERSION = 1;

export interface TallyRow {
  /** Voted rounds in which the model answered. */
  rounds: number;
  wins: number;
  ties: number;
  bad: number;
}

export interface Tally {
  v: typeof TALLY_VERSION;
  models: Record<string, TallyRow>;
}

export const emptyTally = (): Tally => ({ v: TALLY_VERSION, models: {} });

const count = (value: unknown): number =>
  isFiniteNumber(value) && value > 0 ? Math.floor(value) : 0;

/** A tally from storage; anything unreadable counts as nothing. */
export function parseTally(raw: unknown): Tally {
  const tally = emptyTally();
  if (!isPlainObject(raw) || raw['v'] !== TALLY_VERSION || !isPlainObject(raw['models'])) {
    return tally;
  }
  for (const [model, row] of Object.entries(raw['models'])) {
    if (isUnsafeKey(model) || !model || !isPlainObject(row)) continue;
    const parsed: TallyRow = {
      rounds: count(row['rounds']),
      wins: count(row['wins']),
      ties: count(row['ties']),
      bad: count(row['bad']),
    };
    if (parsed.rounds + parsed.wins + parsed.ties + parsed.bad > 0) tally.models[model] = parsed;
  }
  return tally;
}

const zero = (): TallyRow => ({ rounds: 0, wins: 0, ties: 0, bad: 0 });

/** `tally` with `round`'s vote counted (a new object). Each model counts once per round, however often it ran. */
export function addVote(tally: Tally, round: Round, vote: Vote): Tally {
  const next: Tally = { v: TALLY_VERSION, models: { ...tally.models } };
  const answered = [...new Set(round.entries.filter(hasAnswer).map((entry) => entry.model))].filter(
    (model) => !isUnsafeKey(model),
  );
  const winner =
    vote.kind === 'winner' ? round.entries[round.order[vote.panel] ?? -1]?.model : undefined;
  for (const model of answered) {
    const row = { ...(next.models[model] ?? zero()) };
    row.rounds += 1;
    if (model === winner) row.wins += 1;
    if (vote.kind === 'tie') row.ties += 1;
    if (vote.kind === 'bad') row.bad += 1;
    next.models[model] = row;
  }
  return next;
}

/** Both tallies added up (Undo of a reset keeps the votes cast since). */
export function mergeTallies(a: Tally, b: Tally): Tally {
  const next = emptyTally();
  for (const source of [a, b]) {
    for (const [model, row] of Object.entries(source.models)) {
      const sum = next.models[model] ?? zero();
      next.models[model] = {
        rounds: sum.rounds + row.rounds,
        wins: sum.wins + row.wins,
        ties: sum.ties + row.ties,
        bad: sum.bad + row.bad,
      };
    }
  }
  return next;
}

/** Rows for the table: most wins first, then most rounds, then by id. */
export function tallyRows(tally: Tally): ({ model: string } & TallyRow)[] {
  return Object.entries(tally.models)
    .map(([model, row]) => ({ model, ...row }))
    .sort((a, b) => b.wins - a.wins || b.rounds - a.rounds || a.model.localeCompare(b.model));
}

export const isEmptyTally = (tally: Tally): boolean => Object.keys(tally.models).length === 0;
