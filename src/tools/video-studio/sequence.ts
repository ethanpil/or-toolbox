/**
 * The auto-extend sequence: an ordered list of steps (a prompt and optional images), run as jobs. Pure state
 * transitions on a JSON-safe `SequenceRun`, which the tool stores in `ctx.state`, so a reload resumes it.
 *
 * - **Slots:** Start expands the steps into slots, `repeat` rounds of every step, in order. A slot is
 *   `pending` â†’ `starting` (claimed: its frame is captured and its run begins) â†’ `running` (a job polls it) â†’
 *   `done` | `failed`.
 * - **Chained** slots start one at a time, each from the previous finished clip's last frame (the source clip for
 *   the first one, if any); **independent** slots run up to `MAX_PARALLEL` at once from their own prompt and images.
 * - **Spend cap:** a slot starts only if what the sequence has spent (actual costs as they arrive, an unknown one
 *   counted at its estimate) plus the estimates of the slots in flight plus its own estimate stays within the cap;
 *   otherwise the sequence stops with a message, and nothing more is sent. With a cap, a step whose cost cannot be
 *   estimated stops it too (the cap could not be kept).
 * - **Failures:** `stop` ends the sequence at a failed step, `skip` goes on (a chained step after it continues from
 *   the last clip that was made).
 * - **Pause** starts nothing new (jobs already sent finish and land on the timeline); **Resume** goes on, past
 *   failed steps. **Re-run** puts one finished or failed slot back as `forced`: it starts even while the sequence is
 *   paused or stopped, without redoing the others.
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
  jobId: string | null;
  runId: string | null;
  clipId: string | null;
  /** The estimate of the attempt in flight (or the last one). */
  estimateUsd: number | null;
  /** What finished attempts cost (an unknown cost counts at its estimate). */
  spentUsd: number;
  error: string | null;
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
   * How many images each step had at Start (by step id). Pictures stay in memory only, so after a reload a step
   * that had some and now has none must not be sent without them.
   */
  stepImages: Record<string, number>;
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
export function slotNumber(run: SequenceRun, key: string): number {
  return run.slots.findIndex((slot) => slot.key === key) + 1;
}

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
    for (const step of input.spec.steps) {
      slots.push({
        key: slotKey(round, step.id),
        stepId: step.id,
        round,
        status: 'pending',
        attempt: 1,
        forced: false,
        jobId: null,
        runId: null,
        clipId: null,
        estimateUsd: null,
        spentUsd: 0,
        error: null,
      });
    }
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
    slots,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

const withSlot = (run: SequenceRun, key: string, patch: Partial<Slot>): SequenceRun => ({
  ...run,
  slots: run.slots.map((slot) => (slot.key === key ? { ...slot, ...patch } : slot)),
});

/** Spent so far plus the estimates of the slots in flight. */
export function committedUsd(run: SequenceRun): number {
  return run.slots.reduce(
    (sum, slot) => sum + slot.spentUsd + (isInFlight(slot) ? (slot.estimateUsd ?? 0) : 0),
    0,
  );
}

/** Actual spend of the finished attempts. */
export function spentUsd(run: SequenceRun): number {
  return run.slots.reduce((sum, slot) => sum + slot.spentUsd, 0);
}

/** Total estimate before starting: every slot at the per-step estimate (null when unknown). */
export function totalEstimate(spec: SequenceSpec, perStep: number | null): number | null {
  if (perStep === null) return null;
  return perStep * spec.steps.length * spec.repeat;
}

const formatMoney = (usd: number): string => formatUsd(usd);

export interface Plan {
  /** Slot keys to claim and start now, in order. */
  start: string[];
  /** A status change (stopped by the cap, done). */
  status?: SequenceStatus;
  message?: string | null;
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
    const cap = run.spec.capUsd;
    if (cap !== null) {
      const number = slotNumber(run, slot.key);
      if (estimate === null) {
        return {
          start,
          status: 'stopped',
          message: `Stopped before step ${number}: its cost cannot be estimated, so the ${formatMoney(cap)} spend cap could not be kept.`,
        };
      }
      if (committed + estimate > cap + 1e-9) {
        return {
          start,
          status: 'stopped',
          message: `Stopped before step ${number}: it would bring this sequence to about ${formatMoney(committed + estimate)}, over its ${formatMoney(cap)} spend cap (${formatMoney(spentUsd(run))} spent so far).`,
        };
      }
    }
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

/** Claims a pending slot for starting, with the estimate it starts at. Null when it is not pending any more. */
export function claim(
  run: SequenceRun,
  key: string,
  estimateUsd: number | null,
  now: number,
): SequenceRun | null {
  const slot = run.slots.find((candidate) => candidate.key === key);
  if (!slot || slot.status !== 'pending') return null;
  return {
    ...withSlot(run, key, { status: 'starting', estimateUsd, error: null }),
    updatedAt: now,
  };
}

/** The job is queued: the slot runs (unless its job already finished and settled it). */
export function markRunning(
  run: SequenceRun,
  key: string,
  ids: { jobId: string; runId: string },
  now: number,
): SequenceRun {
  const slot = run.slots.find((candidate) => candidate.key === key);
  if (!slot || slot.status !== 'starting') return run;
  return { ...withSlot(run, key, { status: 'running', ...ids }), updatedAt: now };
}

/**
 * Whether a finished job belongs to the slot's current attempt: its job id, or (the job finished before the
 * starting page recorded the id) a slot still starting.
 */
function ownsJob(slot: Slot, jobId: string): boolean {
  return (
    (slot.status === 'running' && slot.jobId === jobId) ||
    (slot.status === 'starting' && slot.jobId === null)
  );
}

/**
 * Starting failed before anything was sent (no key, budget declined, the frame could not be read): the slot goes
 * back to pending and the sequence pauses with the reason, so nothing else starts behind the user's back.
 */
export function releaseClaim(
  run: SequenceRun,
  key: string,
  reason: string,
  now: number,
): SequenceRun {
  const next = withSlot(run, key, { status: 'pending', estimateUsd: null });
  return { ...next, status: 'paused', message: reason, updatedAt: now };
}

/** The slot's job made a clip. `costUsd` null (unknown) counts at the slot's estimate. */
export function markDone(
  run: SequenceRun,
  key: string,
  outcome: { jobId: string; clipId: string; costUsd: number | null },
  now: number,
): SequenceRun {
  const slot = run.slots.find((candidate) => candidate.key === key);
  if (!slot || !ownsJob(slot, outcome.jobId)) return run;
  return {
    ...withSlot(run, key, {
      status: 'done',
      forced: false,
      jobId: outcome.jobId,
      clipId: outcome.clipId,
      spentUsd: slot.spentUsd + (outcome.costUsd ?? slot.estimateUsd ?? 0),
      error: null,
    }),
    updatedAt: now,
  };
}

/**
 * The slot failed (its submit or its job). `jobId` null: the submit itself failed (only then is `key` matched
 * without a job). `costUsd`: what the failure is known to have cost (usually nothing). Applies the failure
 * policy: `stop` stops the sequence with the reason.
 */
export function markFailed(
  run: SequenceRun,
  key: string,
  failure: { jobId: string | null; error: string; costUsd?: number },
  now: number,
): SequenceRun {
  const slot = run.slots.find((candidate) => candidate.key === key);
  if (!slot || !isInFlight(slot)) return run;
  if (failure.jobId === null ? slot.status !== 'starting' : !ownsJob(slot, failure.jobId)) {
    return run;
  }
  let next: SequenceRun = {
    ...withSlot(run, key, {
      status: 'failed',
      forced: false,
      error: failure.error,
      spentUsd: slot.spentUsd + (failure.costUsd ?? 0),
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
    message: 'Stopped: steps already sent still finish.',
    slots: run.slots.map((slot) => ({ ...slot, forced: false })),
    updatedAt: now,
  };
}

/** Resume a paused or stopped sequence: failed steps are passed over (Re-run tries one again). */
export function resume(run: SequenceRun, now: number): SequenceRun {
  if (run.status !== 'paused' && run.status !== 'stopped') return run;
  return { ...run, status: 'running', message: null, updatedAt: now };
}

/** Re-run one slot that finished or failed, without redoing the others. */
export function rerun(run: SequenceRun, key: string, now: number): SequenceRun | null {
  const slot = run.slots.find((candidate) => candidate.key === key);
  if (!slot || !isFinalSlot(slot)) return null;
  return {
    ...withSlot(run, key, {
      status: 'pending',
      forced: true,
      attempt: slot.attempt + 1,
      error: null,
    }),
    status: run.status === 'done' ? 'running' : run.status,
    message: run.status === 'done' ? null : run.message,
    updatedAt: now,
  };
}

/**
 * After a reload: a slot left `starting` belongs to a page that closed mid-start (its frame or its submit). It
 * may or may not have reached OpenRouter, so it is never sent again by itself: it fails with that reason and the
 * sequence pauses for the user to decide (Re-run, or Resume past it).
 */
export function abandonStart(run: SequenceRun, key: string, now: number): SequenceRun {
  const slot = run.slots.find((candidate) => candidate.key === key);
  if (!slot || slot.status !== 'starting') return run;
  const next = withSlot(run, key, {
    status: 'failed',
    forced: false,
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
 * The clip a chained slot continues from: the clip of the nearest earlier slot that has one (passing failed or
 * skipped steps), else the sequence's source clip, else null (the first step starts from its prompt).
 * `hasClip` says whether a clip id is still on the timeline.
 */
export function chainSource(
  run: SequenceRun,
  key: string,
  hasClip: (clipId: string) => boolean,
): string | null {
  const index = run.slots.findIndex((slot) => slot.key === key);
  for (let i = index - 1; i >= 0; i--) {
    const clipId = run.slots[i]?.clipId;
    if (run.slots[i]?.status === 'done' && clipId && hasClip(clipId)) return clipId;
  }
  return run.sourceClipId && hasClip(run.sourceClipId) ? run.sourceClipId : null;
}

/** Whether a slot will start from a first frame (chained, with a clip before it). */
export function startsFromFrame(
  run: Pick<SequenceRun, 'spec' | 'sourceClipId'>,
  index: number,
): boolean {
  return run.spec.mode === 'chained' && (index > 0 || run.sourceClipId !== null);
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
    error: nullableString(raw['error']),
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
    slots,
    createdAt: isFiniteNumber(created) ? created : 0,
    updatedAt: isFiniteNumber(updated) ? updated : 0,
  };
}
