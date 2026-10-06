/**
 * The auto-extend sequence: an ordered list of steps (a prompt and optional images), run as jobs. Pure state
 * transitions on a JSON-safe `SequenceRun`, which the tool stores in `ctx.state`, so a reload resumes it.
 *
 * - **Slots:** Start expands the steps into slots, `repeat` rounds of every step, in order. A slot is
 *   `pending` -> `starting` (claimed by one tab: its frame is captured and its run begins) -> `running` (a job
 *   polls it) -> `done` | `failed`. Each Re-run is a new `attempt`; a job belongs to the attempt that sent it.
 * - **Chained** slots start one at a time, each from the last frame of the clip of the nearest earlier step that
 *   was made (the source clip for the first one, if any); **independent** slots run up to `MAX_PARALLEL` at once
 *   from their own prompt and images. A chained step whose clip to continue is gone is never sent from its prompt
 *   alone: the sequence pauses with a `blocker`, and the user picks another clip, no first frame, or a re-run of
 *   the step before.
 * - **Spend cap:** a slot starts only if what the sequence has spent, plus the estimates of the slots in flight,
 *   plus its own estimate stays within the cap; otherwise the sequence stops with a message and nothing more is
 *   sent. Spent means billed or maybe billed: a known cost, or the reservation (the estimate) of a step whose cost
 *   is unknown, that failed after it was sent, that was abandoned mid-send or that the user stopped waiting for
 *   (`spentEstimated` marks those). With a cap, a step whose cost cannot be estimated stops the sequence too.
 * - **Failures:** `stop` ends the sequence at a failed step (a failed start included), `skip` goes on.
 * - **Pause** starts nothing new (jobs already sent finish and land on the timeline); **Resume** goes on, past
 *   failed steps. **Re-run** puts one finished or failed slot back as `forced`: it starts even while the sequence is
 *   paused or stopped, without redoing the others; the chained step after it is then marked `stale` (it continued
 *   the old take).
 */
import { isFiniteNumber, isRecord, isString, isUnsafeKey } from '../../core/util';
import { formatUsd } from '../../ui/format';
import { type ClipFormat, parseFormat } from './format';

export type SequenceMode = 'chained' | 'independent';
export type FailurePolicy = 'stop' | 'skip';
/** What a step's images are for: style/content references, or the frame the step should end on. */
export type ImageRole = 'references' | 'last-frame';

export const MAX_PARALLEL = 3;
export const MAX_REPEAT = 10;
export const MAX_STEPS = 20;

export interface StepSpec {
  id: string;
  prompt: string;
  imageRole: ImageRole;
}

export interface SequenceSpec {
  mode: SequenceMode;
  /** Times the whole list runs (1 = once). */
  repeat: number;
  /** Appended to every step's prompt. */
  style: string;
  /** Spend cap in USD for the whole sequence, or null for none. */
  capUsd: number | null;
  onFailure: FailurePolicy;
  steps: StepSpec[];
}

export const DEFAULT_SEQUENCE: SequenceSpec = {
  mode: 'chained',
  repeat: 1,
  style: '',
  capUsd: null,
  onFailure: 'stop',
  steps: [{ id: 'step-1', prompt: '', imageRole: 'references' }],
};

export type SlotStatus = 'pending' | 'starting' | 'running' | 'done' | 'failed';
export type SequenceStatus = 'running' | 'paused' | 'stopped' | 'done';

export interface Slot {
  /** `<round>:<stepId>`. */
  key: string;
  stepId: string;
  /** 0-based repeat round. */
  round: number;
  status: SlotStatus;
  /** 1 for the first try; each Re-run adds one. */
  attempt: number;
  /** Re-run: starts even while the sequence is paused or stopped. */
  forced: boolean;
  /** The current attempt's job and run (null until it is queued). */
  jobId: string | null;
  runId: string | null;
  clipId: string | null;
  /** The estimate of the attempt in flight (or the last one). */
  estimateUsd: number | null;
  /** What finished attempts cost or may have cost (see `spentEstimated`). */
  spentUsd: number;
  /** Part of `spentUsd` is a reservation, not a known cost. */
  spentEstimated: boolean;
  error: string | null;
  /** The user's choice of what this chained slot continues: another clip, or (with `noFrame`) nothing. */
  chainFrom: string | null;
  noFrame: boolean;
  /** Its clip continued an older take of the step before, which a Re-run replaced. */
  stale: boolean;
  /** The tab that claimed it for starting, and when. */
  claimedBy: string | null;
  claimedAt: number | null;
}

/** Why a paused sequence waits for the user, and which slot it is about. */
export interface Blocker {
  slotKey: string;
  kind: 'source-missing' | 'images-lost';
  message: string;
}

export interface SequenceRun {
  v: 1;
  id: string;
  status: SequenceStatus;
  /** Why it is paused, stopped or done, for the panel. */
  message: string | null;
  spec: SequenceSpec;
  /** Model and format at Start: a later change of the form does not change a running sequence. */
  model: string;
  format: ClipFormat;
  /** The clip the first chained step continues from, or null. */
  sourceClipId: string | null;
  /**
   * How many images each step has (by step id), kept up to date as the user changes them. Pictures stay in memory
   * only, so after a reload a step that has fewer than this must not be sent without them.
   */
  stepImages: Record<string, number>;
  blocker: Blocker | null;
  slots: Slot[];
  createdAt: number;
  updatedAt: number;
}

const FINAL: readonly SlotStatus[] = ['done', 'failed'];
const IN_FLIGHT: readonly SlotStatus[] = ['starting', 'running'];
export const isFinalSlot = (slot: Slot): boolean => FINAL.includes(slot.status);
export const isInFlight = (slot: Slot): boolean => IN_FLIGHT.includes(slot.status);

/** A run that still has work to do or could resume (not `done`). */
export const isActive = (run: SequenceRun | null): run is SequenceRun =>
  run !== null && run.status !== 'done';

export function slotKey(round: number, stepId: string): string {
  return `${round}:${stepId}`;
}

/** The step's prompt as sent: its own text, then the shared style. */
export function stepPrompt(spec: SequenceSpec, prompt: string): string {
  const style = spec.style.trim();
  const text = prompt.trim();
  if (!style) return text;
  return text ? `${text}\n\nStyle: ${style}` : `Style: ${style}`;
}

/** 1-based position of a slot in the whole sequence ("step 7 of 10"). */
export function slotNumber(run: Pick<SequenceRun, 'slots'>, key: string): number {
  return run.slots.findIndex((slot) => slot.key === key) + 1;
}

const newSlot = (round: number, stepId: string): Slot => ({
  key: slotKey(round, stepId),
  stepId,
  round,
  status: 'pending',
  attempt: 1,
  forced: false,
  jobId: null,
  runId: null,
  clipId: null,
  estimateUsd: null,
  spentUsd: 0,
  spentEstimated: false,
  error: null,
  chainFrom: null,
  noFrame: false,
  stale: false,
  claimedBy: null,
  claimedAt: null,
});

export function createRun(input: {
  id: string;
  spec: SequenceSpec;
  model: string;
  format: ClipFormat;
  sourceClipId: string | null;
  stepImages?: Record<string, number>;
  now: number;
}): SequenceRun {
  const slots: Slot[] = [];
  for (let round = 0; round < input.spec.repeat; round++) {
    for (const step of input.spec.steps) slots.push(newSlot(round, step.id));
  }
  return {
    v: 1,
    id: input.id,
    status: 'running',
    message: null,
    spec: structuredClone(input.spec),
    model: input.model,
    format: { ...input.format },
    sourceClipId: input.sourceClipId,
    stepImages: { ...input.stepImages },
    blocker: null,
    slots,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

const findSlot = (run: SequenceRun, key: string): Slot | undefined =>
  run.slots.find((slot) => slot.key === key);

const withSlot = (run: SequenceRun, key: string, patch: Partial<Slot>): SequenceRun => ({
  ...run,
  slots: run.slots.map((slot) => (slot.key === key ? { ...slot, ...patch } : slot)),
});

/** Spent (billed or maybe billed) plus the estimates of the slots in flight. */
export function committedUsd(run: SequenceRun): number {
  return run.slots.reduce(
    (sum, slot) => sum + slot.spentUsd + (isInFlight(slot) ? (slot.estimateUsd ?? 0) : 0),
    0,
  );
}

/** Billed or maybe billed so far. */
export function spentUsd(run: SequenceRun): number {
  return run.slots.reduce((sum, slot) => sum + slot.spentUsd, 0);
}

/** Some of the spend is a reservation rather than a known cost (show it as "≈"). */
export function spentIsEstimate(run: SequenceRun): boolean {
  return run.slots.some((slot) => slot.spentEstimated);
}

/** Money as the panel shows it: `≈ $0.10` when part of it is a reservation. */
export const moneyText = (usd: number, estimated: boolean): string =>
  `${estimated ? '≈ ' : ''}${formatUsd(usd)}`;

export interface Plan {
  /** Slot keys to claim and start now, in order. */
  start: string[];
  /** A status change (stopped by the cap, done). */
  status?: SequenceStatus;
  message?: string | null;
}

/** Why the cap stops a slot about to start, or null when it may start. */
export function capProblem(
  run: SequenceRun,
  key: string,
  committed: number,
  estimate: number | null,
): string | null {
  const cap = run.spec.capUsd;
  if (cap === null) return null;
  const number = slotNumber(run, key);
  if (estimate === null) {
    return `Stopped before step ${number}: its cost cannot be estimated, so the ${formatUsd(cap)} spend cap could not be kept.`;
  }
  if (committed + estimate <= cap + 1e-9) return null;
  return `Stopped before step ${number}: it would bring this sequence to about ${formatUsd(committed + estimate)}, over its ${formatUsd(cap)} spend cap (${moneyText(spentUsd(run), spentIsEstimate(run))} spent so far).`;
}

/**
 * What to do next. `estimateOf` is the cost of starting a slot now (null when unknown). Pure: the caller applies
 * the plan with `claim()` under its lock, so two tabs never start the same slot.
 */
export function plan(run: SequenceRun, estimateOf: (slot: Slot) => number | null): Plan {
  const inFlight = run.slots.filter(isInFlight);
  const pending = run.slots.filter((slot) => slot.status === 'pending');
  if (pending.length === 0) {
    if (inFlight.length === 0 && run.status !== 'done') {
      return { start: [], status: 'done', message: doneMessage(run) };
    }
    return { start: [] };
  }
  const startable = run.status === 'running' ? pending : pending.filter((slot) => slot.forced);
  if (startable.length === 0) return { start: [] };
  const room =
    run.spec.mode === 'chained' ? (inFlight.length > 0 ? 0 : 1) : MAX_PARALLEL - inFlight.length;
  if (room <= 0) return { start: [] };

  const start: string[] = [];
  let committed = committedUsd(run);
  for (const slot of startable.slice(0, room)) {
    const estimate = estimateOf(slot);
    const problem = capProblem(run, slot.key, committed, estimate);
    if (problem) return { start, status: 'stopped', message: problem };
    committed += estimate ?? 0;
    start.push(slot.key);
  }
  return { start };
}

function doneMessage(run: SequenceRun): string {
  const done = run.slots.filter((slot) => slot.status === 'done').length;
  const failed = run.slots.filter((slot) => slot.status === 'failed').length;
  const total = run.slots.length;
  return failed > 0
    ? `Finished: ${done} of ${total} steps made, ${failed} failed.`
    : `Finished: all ${total} steps made.`;
}

/** Applies a plan's status change (the starts are claimed one by one with `claim`). */
export function applyStatus(run: SequenceRun, next: Plan, now: number): SequenceRun {
  if (!next.status) return run;
  return { ...run, status: next.status, message: next.message ?? null, updatedAt: now };
}

/**
 * Claims a pending slot for starting by tab `claimer`, with the estimate it starts at; the previous attempt's job
 * no longer belongs to it. Null when it is not pending any more.
 */
export function claim(
  run: SequenceRun,
  key: string,
  estimateUsd: number | null,
  now: number,
  claimer = 'this-tab',
): SequenceRun | null {
  const slot = findSlot(run, key);
  if (!slot || slot.status !== 'pending') return null;
  return {
    ...withSlot(run, key, {
      status: 'starting',
      estimateUsd,
      error: null,
      jobId: null,
      runId: null,
      claimedBy: claimer,
      claimedAt: now,
    }),
    updatedAt: now,
  };
}

/** The job of attempt `attempt` is queued: the slot runs (unless that job already finished and settled it). */
export function markRunning(
  run: SequenceRun,
  key: string,
  ids: { jobId: string; runId: string; attempt: number },
  now: number,
): SequenceRun {
  const slot = findSlot(run, key);
  if (!slot || slot.status !== 'starting' || slot.attempt !== ids.attempt) return run;
  return {
    ...withSlot(run, key, { status: 'running', jobId: ids.jobId, runId: ids.runId }),
    updatedAt: now,
  };
}

/**
 * Whether a finished job is the slot's current attempt: its recorded job, or (the job finished before the starting
 * page recorded it) a slot still starting that attempt.
 */
export function ownsJob(slot: Slot, jobId: string, attempt: number): boolean {
  if (slot.status === 'running') return slot.jobId === jobId;
  return slot.status === 'starting' && slot.jobId === null && slot.attempt === attempt;
}

/** A pending slot again, nothing sent; the sequence's status stays (Pause, Stop or the cap stopped the start). */
export function returnClaim(run: SequenceRun, key: string, now: number): SequenceRun {
  const slot = findSlot(run, key);
  if (!slot || slot.status !== 'starting') return run;
  return {
    ...withSlot(run, key, {
      status: 'pending',
      estimateUsd: null,
      claimedBy: null,
      claimedAt: null,
    }),
    updatedAt: now,
  };
}

/**
 * Starting failed before anything was sent (no key, the frame could not be read): the slot goes back to pending
 * and a running sequence pauses with the reason, so nothing else starts behind the user's back. A stopped one
 * stays stopped.
 */
export function releaseClaim(
  run: SequenceRun,
  key: string,
  reason: string,
  now: number,
): SequenceRun {
  const next = returnClaim(run, key, now);
  if (next === run) return run;
  return {
    ...next,
    status: run.status === 'running' ? 'paused' : run.status,
    message: reason,
  };
}

/** A chained slot cannot start without the user's decision: back to pending, paused (stopped stays stopped). */
export function block(
  run: SequenceRun,
  key: string,
  blocker: Omit<Blocker, 'slotKey'>,
  now: number,
): SequenceRun {
  const next = returnClaim(run, key, now);
  if (next === run) return run;
  return {
    ...next,
    status: run.status === 'running' ? 'paused' : run.status,
    message: blocker.message,
    blocker: { slotKey: key, ...blocker },
  };
}

/**
 * The user's answer to a `source-missing` blocker: continue `clipId` instead, or (null) send the step without a
 * first frame. The sequence goes on.
 */
export function chooseSource(
  run: SequenceRun,
  key: string,
  clipId: string | null,
  now: number,
): SequenceRun {
  const next = withSlot(run, key, { chainFrom: clipId, noFrame: clipId === null });
  return { ...next, blocker: null, status: 'running', message: null, updatedAt: now };
}

/** The user's answer to an `images-lost` blocker: send the step without the images it had. */
export function dropStepImages(run: SequenceRun, stepId: string, now: number): SequenceRun {
  const stepImages = { ...run.stepImages };
  delete stepImages[stepId];
  return { ...run, stepImages, blocker: null, status: 'running', message: null, updatedAt: now };
}

/** The slot's job made a clip. `costUsd` null (unknown) counts at the slot's estimate. */
export function markDone(
  run: SequenceRun,
  key: string,
  outcome: { jobId: string; attempt: number; clipId: string; costUsd: number | null },
  now: number,
): SequenceRun {
  const slot = findSlot(run, key);
  if (!slot || !ownsJob(slot, outcome.jobId, outcome.attempt)) return run;
  const unknown = outcome.costUsd === null;
  return {
    ...withSlot(run, key, {
      status: 'done',
      forced: false,
      jobId: outcome.jobId,
      clipId: outcome.clipId,
      spentUsd: slot.spentUsd + (outcome.costUsd ?? slot.estimateUsd ?? 0),
      spentEstimated: slot.spentEstimated || unknown,
      error: null,
      stale: false,
      claimedBy: null,
      claimedAt: null,
    }),
    updatedAt: now,
  };
}

/** What a failure cost: nothing (refused before work), a known amount, or maybe its reservation. */
export type Billed = 'no' | 'maybe' | number;

/**
 * The slot failed: its start (`jobId` null: matched while still starting) or its job. `billed` says whether it
 * may have cost money; a maybe counts at the slot's estimate. Applies the failure policy: `stop` stops the
 * sequence with the reason.
 */
export function markFailed(
  run: SequenceRun,
  key: string,
  failure: { jobId: string | null; attempt: number; error: string; billed: Billed },
  now: number,
): SequenceRun {
  const slot = findSlot(run, key);
  if (!slot || !isInFlight(slot)) return run;
  const owns =
    failure.jobId === null
      ? slot.status === 'starting' && slot.attempt === failure.attempt
      : ownsJob(slot, failure.jobId, failure.attempt);
  if (!owns) return run;
  const cost =
    failure.billed === 'no'
      ? 0
      : failure.billed === 'maybe'
        ? (slot.estimateUsd ?? 0)
        : failure.billed;
  let next: SequenceRun = {
    ...withSlot(run, key, {
      status: 'failed',
      forced: false,
      error: failure.error,
      spentUsd: slot.spentUsd + cost,
      spentEstimated: slot.spentEstimated || failure.billed === 'maybe',
      claimedBy: null,
      claimedAt: null,
    }),
    updatedAt: now,
  };
  if (run.spec.onFailure === 'stop' && run.status === 'running') {
    next = {
      ...next,
      status: 'stopped',
      message: `Stopped: step ${slotNumber(run, key)} failed (${failure.error.replace(/\.$/, '')}).`,
    };
  }
  return next;
}

export function pause(run: SequenceRun, now: number): SequenceRun {
  if (run.status !== 'running') return run;
  return {
    ...run,
    status: 'paused',
    message: 'Paused: steps already sent still finish.',
    updatedAt: now,
  };
}

/** Stop: nothing new starts; pending slots stay pending so Resume can still go on. */
export function stop(run: SequenceRun, now: number): SequenceRun {
  if (run.status === 'done') return run;
  return {
    ...run,
    status: 'stopped',
    message:
      'Stopped: steps already sent still finish. Resume sends the rest, or start a new sequence.',
    slots: run.slots.map((slot) => ({ ...slot, forced: false })),
    updatedAt: now,
  };
}

/** Resume a paused or stopped sequence: failed steps are passed over (Re-run tries one again). */
export function resume(run: SequenceRun, now: number): SequenceRun {
  if (run.status !== 'paused' && run.status !== 'stopped') return run;
  return { ...run, status: 'running', message: null, blocker: null, updatedAt: now };
}

/** Re-run one slot that finished or failed, without redoing the others. */
export function rerun(run: SequenceRun, key: string, now: number): SequenceRun | null {
  const slot = findSlot(run, key);
  if (!slot || !isFinalSlot(slot)) return null;
  return {
    ...withSlot(run, key, {
      status: 'pending',
      forced: true,
      attempt: slot.attempt + 1,
      error: null,
      chainFrom: null,
      noFrame: false,
    }),
    status: run.status === 'done' ? 'running' : run.status,
    message: run.status === 'done' ? null : run.message,
    blocker: run.blocker?.slotKey === key ? null : run.blocker,
    updatedAt: now,
  };
}

/** The chained slot after `key`, if any (the one that continued its clip). */
export function nextChained(run: SequenceRun, key: string): Slot | null {
  if (run.spec.mode !== 'chained') return null;
  const index = run.slots.findIndex((slot) => slot.key === key);
  return index >= 0 ? (run.slots[index + 1] ?? null) : null;
}

/** Marks the slot whose clip continued an old take (it should be made again from the new one). */
export function markStale(run: SequenceRun, key: string, now: number): SequenceRun {
  const slot = findSlot(run, key);
  if (!slot || slot.status !== 'done' || slot.stale) return run;
  return { ...withSlot(run, key, { stale: true }), updatedAt: now };
}

/**
 * After a reload: a slot left `starting` belongs to a page that closed mid-start (its frame or its submit). It
 * may or may not have reached OpenRouter, so it is never sent again by itself: it fails, its reservation counts as
 * maybe billed, and the sequence pauses for the user to decide (Re-run, or Resume past it).
 */
export function abandonStart(run: SequenceRun, key: string, now: number): SequenceRun {
  const slot = findSlot(run, key);
  if (!slot || slot.status !== 'starting') return run;
  const next = withSlot(run, key, {
    status: 'failed',
    forced: false,
    spentUsd: slot.spentUsd + (slot.estimateUsd ?? 0),
    spentEstimated: true,
    claimedBy: null,
    claimedAt: null,
    error:
      'The page closed while this step was being sent; it may have been billed. Re-run it if no clip arrives.',
  });
  return {
    ...next,
    status: run.status === 'running' ? 'paused' : run.status,
    message: `Paused: step ${slotNumber(run, key)} was being sent when the page closed.`,
    updatedAt: now,
  };
}

/**
 * What a slot starts from. `expected`: it should start from a clip's last frame (chained, with a step or a source
 * clip before it, unless the user chose no frame); `clipId`: that clip (the user's choice, else the clip of the
 * nearest earlier step that was made, else the source clip), or null when there is none to continue.
 */
export function chainSourceOf(
  run: Pick<SequenceRun, 'spec' | 'slots' | 'sourceClipId'>,
  key: string,
): { expected: boolean; clipId: string | null } {
  const index = run.slots.findIndex((slot) => slot.key === key);
  const slot = run.slots[index];
  if (run.spec.mode !== 'chained' || !slot || slot.noFrame)
    return { expected: false, clipId: null };
  if (slot.chainFrom) return { expected: true, clipId: slot.chainFrom };
  for (let i = index - 1; i >= 0; i--) {
    const earlier = run.slots[i];
    if (earlier?.status === 'done' && earlier.clipId)
      return { expected: true, clipId: earlier.clipId };
  }
  if (run.sourceClipId) return { expected: true, clipId: run.sourceClipId };
  return { expected: index > 0, clipId: null };
}

/**
 * What a step's images do in a run: reference images cannot go with a first frame (frames win), so a step that
 * starts from a frame takes only a last frame (null: none, when the model cannot end on a chosen frame).
 */
export function effectiveRole(
  role: ImageRole,
  fromFrame: boolean,
  lastFrame: boolean,
): ImageRole | null {
  if (fromFrame) return lastFrame ? 'last-frame' : null;
  if (role === 'last-frame' && !lastFrame) return 'references';
  return role;
}

/** An edit of a stored run's editable fields; only the fields present are written. */
export interface SpecEdit {
  style?: string;
  capUsd?: number | null;
  onFailure?: FailurePolicy;
  steps?: readonly { id: string; prompt?: string; imageRole?: ImageRole }[];
  /** Image counts per step, as the user set them now. */
  stepImages?: Readonly<Record<string, number>>;
}

/** Applies `edit` field by field to the run as stored now (steps the run does not have are ignored). */
export function applySpecEdit(run: SequenceRun, edit: SpecEdit, now: number): SequenceRun {
  const spec: SequenceSpec = {
    ...run.spec,
    ...(edit.style !== undefined ? { style: edit.style } : {}),
    ...(edit.capUsd !== undefined ? { capUsd: edit.capUsd } : {}),
    ...(edit.onFailure !== undefined ? { onFailure: edit.onFailure } : {}),
    steps: run.spec.steps.map((step) => {
      const changed = edit.steps?.find((candidate) => candidate.id === step.id);
      return changed
        ? {
            ...step,
            ...(changed.prompt !== undefined ? { prompt: changed.prompt } : {}),
            ...(changed.imageRole !== undefined ? { imageRole: changed.imageRole } : {}),
          }
        : step;
    }),
  };
  const stepImages = { ...run.stepImages };
  for (const [id, count] of Object.entries(edit.stepImages ?? {})) {
    if (!run.spec.steps.some((step) => step.id === id)) continue;
    if (count > 0) stepImages[id] = count;
    else delete stepImages[id];
  }
  return { ...run, spec, stepImages, updatedAt: now };
}

// --- parsing ----------------------------------------------------------------------------------------------

const oneOf = <T extends string>(value: unknown, values: readonly T[], fallback: T): T =>
  typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : fallback;

function parseStep(raw: unknown, index: number): StepSpec | null {
  if (!isRecord(raw)) return null;
  return {
    id: isString(raw['id']) && raw['id'] ? raw['id'] : `step-${index + 1}`,
    prompt: isString(raw['prompt']) ? raw['prompt'] : '',
    imageRole: oneOf(raw['imageRole'], ['references', 'last-frame'] as const, 'references'),
  };
}

export function parseSequenceSpec(raw: unknown): SequenceSpec {
  if (!isRecord(raw)) return structuredClone(DEFAULT_SEQUENCE);
  const repeat = raw['repeat'];
  const cap = raw['capUsd'];
  const seen = new Set<string>();
  const steps = (Array.isArray(raw['steps']) ? raw['steps'] : [])
    .slice(0, MAX_STEPS)
    .map(parseStep)
    .filter((step): step is StepSpec => {
      if (!step || seen.has(step.id)) return false;
      seen.add(step.id);
      return true;
    });
  return {
    mode: oneOf(raw['mode'], ['chained', 'independent'] as const, 'chained'),
    repeat:
      isFiniteNumber(repeat) && Number.isInteger(repeat) && repeat >= 1 && repeat <= MAX_REPEAT
        ? repeat
        : 1,
    style: isString(raw['style']) ? raw['style'] : '',
    capUsd: isFiniteNumber(cap) && cap > 0 ? cap : null,
    onFailure: oneOf(raw['onFailure'], ['stop', 'skip'] as const, 'stop'),
    steps: steps.length > 0 ? steps : structuredClone(DEFAULT_SEQUENCE.steps),
  };
}

const SLOT_STATUSES: readonly SlotStatus[] = ['pending', 'starting', 'running', 'done', 'failed'];

function parseSlot(raw: unknown): Slot | null {
  if (!isRecord(raw) || !isString(raw['key']) || !isString(raw['stepId'])) return null;
  const nullableString = (value: unknown): string | null => (isString(value) ? value : null);
  const round = raw['round'];
  const attempt = raw['attempt'];
  const estimate = raw['estimateUsd'];
  const spent = raw['spentUsd'];
  const claimedAt = raw['claimedAt'];
  return {
    key: raw['key'],
    stepId: raw['stepId'],
    round: isFiniteNumber(round) && round >= 0 ? Math.floor(round) : 0,
    status: oneOf(raw['status'], SLOT_STATUSES, 'pending'),
    attempt: isFiniteNumber(attempt) && attempt >= 1 ? Math.floor(attempt) : 1,
    forced: raw['forced'] === true,
    jobId: nullableString(raw['jobId']),
    runId: nullableString(raw['runId']),
    clipId: nullableString(raw['clipId']),
    estimateUsd: isFiniteNumber(estimate) ? estimate : null,
    spentUsd: isFiniteNumber(spent) && spent >= 0 ? spent : 0,
    spentEstimated: raw['spentEstimated'] === true,
    error: nullableString(raw['error']),
    chainFrom: nullableString(raw['chainFrom']),
    noFrame: raw['noFrame'] === true,
    stale: raw['stale'] === true,
    claimedBy: nullableString(raw['claimedBy']),
    claimedAt: isFiniteNumber(claimedAt) ? claimedAt : null,
  };
}

function parseCounts(raw: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!isRecord(raw)) return counts;
  for (const [key, value] of Object.entries(raw)) {
    if (!isUnsafeKey(key) && isFiniteNumber(value) && value > 0) counts[key] = Math.floor(value);
  }
  return counts;
}

function parseBlocker(raw: unknown): Blocker | null {
  if (!isRecord(raw) || !isString(raw['slotKey']) || !isString(raw['message'])) return null;
  const kind = raw['kind'];
  if (kind !== 'source-missing' && kind !== 'images-lost') return null;
  return { slotKey: raw['slotKey'], kind, message: raw['message'] };
}

/** A stored run, validated; null when it is missing or unusable. */
export function parseRun(raw: unknown): SequenceRun | null {
  if (!isRecord(raw) || raw['v'] !== 1 || !isString(raw['id']) || !isString(raw['model'])) {
    return null;
  }
  const slots = (Array.isArray(raw['slots']) ? raw['slots'] : [])
    .map(parseSlot)
    .filter((slot): slot is Slot => slot !== null);
  if (slots.length === 0) return null;
  const created = raw['createdAt'];
  const updated = raw['updatedAt'];
  return {
    v: 1,
    id: raw['id'],
    status: oneOf(raw['status'], ['running', 'paused', 'stopped', 'done'] as const, 'paused'),
    message: isString(raw['message']) ? raw['message'] : null,
    spec: parseSequenceSpec(raw['spec']),
    model: raw['model'],
    format: parseFormat(raw['format']),
    sourceClipId: isString(raw['sourceClipId']) ? raw['sourceClipId'] : null,
    stepImages: parseCounts(raw['stepImages']),
    blocker: parseBlocker(raw['blocker']),
    slots,
    createdAt: isFiniteNumber(created) ? created : 0,
    updatedAt: isFiniteNumber(updated) ? updated : 0,
  };
}
