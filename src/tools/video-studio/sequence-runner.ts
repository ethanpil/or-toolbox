/**
 * Runs a stored sequence (sequence.ts holds the rules, this the side effects): plans and claims slots under the
 * store's lock, then starts each claimed slot in the tab that claimed it.
 *
 * Starting a slot takes several awaits (the clip to continue may need downloading, its last frame capturing, the
 * images encoding, the run beginning). After each one the stored run is read again, and the slot goes back to
 * pending without anything sent when the sequence was paused or stopped meanwhile, when another tab took it over,
 * or when the spend cap no longer allows it (then the sequence stops with the cap's message). Pause and Stop also
 * abort a start in progress here (`abortStarts`), budget dialog included.
 *
 * A chained step whose clip to continue is gone (removed, an upload lost in a reload, expired on OpenRouter) is
 * never sent from its prompt alone: the sequence pauses with a `source-missing` blocker. A step that had images the
 * page no longer holds (pictures are memory-only) pauses with `images-lost`. Other failures to start follow the
 * failure rule (stop or skip), except those that need the user's action (no key, locked, free-only, budget), which
 * pause. A request that may have reached OpenRouter is never sent again by itself; its reservation counts as spent.
 *
 * `recover` settles slots left `starting` by a tab that is gone: it adopts their job if one was queued, else fails
 * them as maybe billed and pauses (sequence.ts `abandonStart`). A slot claimed by a live tab, or being started, is
 * left alone.
 */
import type { VideoRequest } from '../../core/api/types';
import {
  InvalidInputError,
  isAbortError,
  isOutcomeUnknown,
  OrError,
  userMessage,
} from '../../core/errors';
import { isFinalState } from '../../core/jobs';
import type { JobRecord, RunHandle } from '../../core/types';
import { abortError } from '../../core/util';
import type { ClipFormat } from './format';
import { parsePayload, type VideoJobPayload } from './job-payload';
import {
  buildVideoRequest,
  CONTINUE_PROMPT,
  LAST_FRAME_ONLY_MODELS,
  type VideoControls,
  VIDEO_REFERENCE_MAX,
} from './params';
import {
  abandonStart,
  applyStatus,
  type Billed,
  block,
  capProblem,
  chainSourceOf,
  claim,
  committedUsd,
  effectiveRole,
  markFailed,
  markRunning,
  plan,
  releaseClaim,
  returnClaim,
  type SequenceRun,
  type Slot,
  slotNumber,
  stepPrompt,
} from './sequence';
import type { StudioStore } from './store';
import type { TimelineClip } from './timeline';

/** Errors raised after OpenRouter accepted the request (queuing its job failed, say). */
const sentErrors = new WeakSet<object>();
/** Marks an error as raised after the request was accepted: it may have cost money. */
export function markSent(error: unknown): void {
  if (typeof error === 'object' && error !== null) sentErrors.add(error);
}

/**
 * Whether a failed request may have cost money: one the API client marks `outcomeUnknown`, one OpenRouter accepted
 * (`markSent`), and an abort or anything unexpected may have; other OrErrors are answers that billed nothing.
 */
export function billedBy(error: unknown): Billed {
  if (isOutcomeUnknown(error)) return 'maybe';
  if (typeof error === 'object' && error !== null && sentErrors.has(error)) return 'maybe';
  return error instanceof OrError ? 'no' : 'maybe';
}

/**
 * Images a slot's request carries (its first frame and its step's images), for estimates: a slot that continues a
 * clip sends its first frame, plus a last frame or references as its step's role and pictures allow.
 */
export function imagesForSlot(
  run: Pick<SequenceRun, 'spec' | 'slots' | 'sourceClipId'>,
  slot: Slot,
  lastFrameSupported: boolean,
  pictures: (stepId: string) => number,
): number {
  const fromFrame = chainSourceOf(run, slot.key).expected;
  const step = run.spec.steps.find((candidate) => candidate.id === slot.stepId);
  const role = step ? effectiveRole(step.imageRole, fromFrame, lastFrameSupported) : null;
  const count = step ? pictures(step.id) : 0;
  const extra =
    role === 'last-frame'
      ? Math.min(1, count)
      : role === 'references'
        ? Math.min(VIDEO_REFERENCE_MAX, count)
        : 0;
  return (fromFrame ? 1 : 0) + extra;
}

/** Errors the user fixes in a dialog (no key, locked, free-only, budget): the sequence pauses for them. */
const NEEDS_ACTION = new Set(['no-key', 'locked', 'free-only', 'budget-blocked', 'storage-full']);
const needsAction = (error: unknown): boolean =>
  error instanceof OrError && NEEDS_ACTION.has(error.code);

export interface RunnerDeps {
  store: StudioStore;
  /** This page's id; claims carry it. */
  tabId: string;
  now(): number;
  /** A timeline clip by id (this page's mirror). */
  clip(clipId: string): TimelineClip | undefined;
  /** Whether this page has the clip's video or can download it (not expired, not a lost upload). */
  usable(clip: TimelineClip): boolean;
  /** The clip's true last frame as a data URL; rejects when the video cannot be had. */
  lastFrame(clip: TimelineClip): Promise<string>;
  /** The model's controls (null when unknown). */
  controls(model: string): VideoControls | null;
  estimate(model: string, format: ClipFormat, images: number): Promise<number | null>;
  /** The images a step has in this page. */
  images: {
    count(stepId: string): number;
    problem(stepId: string): string | null;
    dataUrls(stepId: string): Promise<string[]>;
  };
  /** `ctx.beginRun` for a step; `preApproved`: the Start confirmation covered it (no dialog of its own). */
  beginRun(
    input: {
      run: SequenceRun;
      slot: Slot;
      number: number;
      estimateUsd: number | null;
      title: string;
      preApproved: boolean;
    },
    signal: AbortSignal,
  ): Promise<RunHandle>;
  /** Sends the request in the run and queues its job (the run is handed off to it). */
  submit(handle: RunHandle, body: VideoRequest, payload: VideoJobPayload): Promise<JobRecord>;
  /** Whether the tab that claimed this slot is still open (it holds its life lock). */
  claimAlive(slot: Slot): Promise<boolean>;
  /** Whether a slot is being started right now somewhere (its start lock is held). */
  starting(runId: string, key: string): Promise<boolean>;
  /** Runs `work` while holding the slot's start lock. */
  withStartLock(runId: string, key: string, work: () => Promise<void>): Promise<void>;
  /** An error the user should see (with what Retry does, if anything). */
  report(error: unknown, retry?: () => void): void;
  /** The stored run changed here. */
  changed(run: SequenceRun | null): void;
}

export interface SequenceRunner {
  /** Starts whatever the plan allows now (after any change that may let a step start). */
  advance(): Promise<void>;
  /** Pause or Stop: aborts this page's starts in progress (they go back to pending, nothing sent). */
  abortStarts(): void;
  /** Settles slots left `starting` by a tab that is gone (page load, other tabs' changes, visibility). */
  recover(jobs: readonly JobRecord[]): Promise<void>;
}

export function createSequenceRunner(deps: RunnerDeps): SequenceRunner {
  const { store } = deps;
  /** This page's starts in progress, by slot key, with their abort controllers. */
  const starts = new Map<string, AbortController>();

  const write = async (
    runId: string,
    fn: (run: SequenceRun) => SequenceRun,
  ): Promise<SequenceRun | null> => {
    const next = await store.updateSequence((current) =>
      current && current.id === runId ? fn(current) : current,
    );
    deps.changed(next);
    return next;
  };

  const slotImages = (run: SequenceRun, slot: Slot): number =>
    imagesForSlot(run, slot, deps.controls(run.model)?.lastFrame ?? true, (stepId) =>
      deps.images.count(stepId),
    );

  const estimatesFor = (run: SequenceRun): Promise<(number | null)[]> =>
    Promise.all(
      Array.from({ length: VIDEO_REFERENCE_MAX + 3 }, (_, images) =>
        deps.estimate(run.model, run.format, images),
      ),
    );

  // --- planning ---------------------------------------------------------------------------------------------
  let advancing: Promise<void> | null = null;
  let again = false;
  const advance = (): Promise<void> => {
    if (advancing) {
      again = true;
      return advancing;
    }
    advancing = (async () => {
      try {
        do {
          again = false;
          await advanceOnce();
        } while (again);
      } catch (error) {
        console.error(error);
      } finally {
        advancing = null;
      }
    })();
    return advancing;
  };

  const advanceOnce = async (): Promise<void> => {
    const stored = await store.sequence();
    if (!stored || stored.status === 'done') return;
    const byImages = await estimatesFor(stored);
    const claimed: string[] = [];
    let after: SequenceRun | null = null;
    await store.transaction(async (tx) => {
      const current = await tx.sequence();
      if (!current || current.id !== stored.id) return;
      const estimateOf = (slot: Slot): number | null => byImages[slotImages(current, slot)] ?? null;
      const next = plan(current, estimateOf);
      let updated = applyStatus(current, next, deps.now());
      for (const key of next.start) {
        const slot = updated.slots.find((candidate) => candidate.key === key);
        const taken = slot ? claim(updated, key, estimateOf(slot), deps.now(), deps.tabId) : null;
        if (taken) {
          updated = taken;
          claimed.push(key);
        }
      }
      if (updated !== current) await tx.setSequence(updated);
      after = updated;
    });
    if (after) deps.changed(after);
    for (const key of claimed) void startSlot(stored.id, key);
  };

  // --- starting one slot --------------------------------------------------------------------------------------
  /** Why the start must not go on now, or null; `stopWith`: the cap's message (the sequence stops). */
  type Verdict = { go: true; run: SequenceRun; slot: Slot } | { go: false; stopWith?: string };
  const verdict = async (runId: string, key: string, signal: AbortSignal): Promise<Verdict> => {
    if (signal.aborted) return { go: false };
    const run = await store.sequence();
    const slot = run?.slots.find((candidate) => candidate.key === key);
    if (!run || run.id !== runId || !slot) return { go: false };
    if (slot.status !== 'starting' || slot.claimedBy !== deps.tabId) return { go: false };
    if (run.status !== 'running' && !slot.forced) return { go: false };
    const others = committedUsd(run) - (slot.estimateUsd ?? 0);
    const cap = capProblem(run, key, others, slot.estimateUsd);
    if (cap) return { go: false, stopWith: cap };
    return { go: true, run, slot };
  };

  /** Hands the claim back without sending: Pause/Stop/another tab (quietly), or the cap (the sequence stops). */
  const giveBack = async (runId: string, key: string, stopWith?: string): Promise<void> => {
    await write(runId, (run) => {
      const slot = run.slots.find((candidate) => candidate.key === key);
      if (slot?.status !== 'starting' || slot.claimedBy !== deps.tabId) return run;
      const back = returnClaim(run, key, deps.now());
      return stopWith ? { ...back, status: 'stopped', message: stopWith } : back;
    });
  };

  /** A start that failed before anything was sent: the user's action (pause), or the failure rule. */
  const startFailed = async (runId: string, key: string, attempt: number, error: unknown) => {
    const number = (await store.sequence())?.slots.findIndex((slot) => slot.key === key) ?? -1;
    if (isAbortError(error) || (error instanceof OrError && error.code === 'cancelled')) {
      await write(runId, (run) =>
        error instanceof OrError
          ? releaseClaim(run, key, 'Paused: the budget confirmation was declined.', deps.now())
          : returnClaim(run, key, deps.now()),
      );
      return;
    }
    if (needsAction(error)) {
      const reason = `Paused before step ${number + 1}: ${userMessage(error).replace(/\.$/, '')}.`;
      await write(runId, (run) => releaseClaim(run, key, reason, deps.now()));
      deps.report(error);
      return;
    }
    await write(runId, (run) =>
      markFailed(
        run,
        key,
        { jobId: null, attempt, error: userMessage(error), billed: 'no' },
        deps.now(),
      ),
    );
  };

  const prepare = async (
    run: SequenceRun,
    slot: Slot,
    signal: AbortSignal,
  ): Promise<
    | { kind: 'ready'; body: VideoRequest; images: number; continues: boolean; text: string }
    | { kind: 'blocked'; blocker: 'source-missing' | 'images-lost'; message: string }
  > => {
    const number = slotNumber(run, slot.key);
    const step = run.spec.steps.find((candidate) => candidate.id === slot.stepId);
    if (!step) throw new InvalidInputError(`Step ${number} is no longer in the list.`);
    const controls = deps.controls(run.model);

    // The clip to continue: never silently dropped.
    const chain = chainSourceOf(run, slot.key);
    let firstFrame: string | null = null;
    if (chain.expected) {
      const source = chain.clipId ? deps.clip(chain.clipId) : undefined;
      const unavailable = (): { kind: 'blocked'; blocker: 'source-missing'; message: string } => ({
        kind: 'blocked',
        blocker: 'source-missing',
        message: source
          ? `Paused before step ${number}: ${source.name}, the clip it continues, is no longer available here.`
          : `Paused before step ${number}: there is no clip for it to continue.`,
      });
      if (!source || !deps.usable(source)) return unavailable();
      try {
        firstFrame = await deps.lastFrame(source);
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (!deps.usable(source)) return unavailable(); // it expired (404) while we asked
        throw error;
      }
    }

    // The step's images, as the user set them.
    const role = effectiveRole(step.imageRole, firstFrame !== null, controls?.lastFrame ?? true);
    const expected = run.stepImages[step.id] ?? 0;
    const have = deps.images.count(step.id);
    if (role && expected > have) {
      return {
        kind: 'blocked',
        blocker: 'images-lost',
        message: `Paused before step ${number}: its ${expected === 1 ? 'image was' : `${expected} images were`} not kept after the reload (pictures stay in memory only). Add ${expected === 1 ? 'it' : 'them'} again and Resume, or send it without.`,
      };
    }
    const issue = role ? deps.images.problem(step.id) : null;
    if (issue) throw new InvalidInputError(`Step ${number}: ${issue}`);
    const pictures = role && have > 0 ? await deps.images.dataUrls(step.id) : [];
    const lastFrame = role === 'last-frame' ? (pictures[0] ?? null) : null;
    if (lastFrame && !firstFrame && !LAST_FRAME_ONLY_MODELS.has(run.model)) {
      throw new InvalidInputError(
        `Step ${number} would end on a chosen frame without starting from one, which this model is not known to take. Use reference images, or chain it from a clip.`,
      );
    }
    const text = stepPrompt(run.spec, step.prompt) || (firstFrame ? CONTINUE_PROMPT : '');
    const built = buildVideoRequest({
      model: run.model,
      prompt: text,
      format: run.format,
      controls,
      firstFrame,
      lastFrame,
      references: role === 'references' ? pictures : [],
    });
    if (!built.body.prompt && !built.body.frame_images && !built.body.input_references) {
      throw new InvalidInputError(`Step ${number} needs a prompt.`);
    }
    return {
      kind: 'ready',
      body: built.body,
      images: built.images,
      continues: firstFrame !== null,
      text,
    };
  };

  const startSlot = async (runId: string, key: string): Promise<void> => {
    const controller = new AbortController();
    const signal = controller.signal;
    const work = async (): Promise<void> => {
      let check = await verdict(runId, key, signal);
      if (!check.go) return giveBack(runId, key, check.stopWith);
      const attempt = check.slot.attempt;
      let prepared: Awaited<ReturnType<typeof prepare>>;
      try {
        prepared = await prepare(check.run, check.slot, signal);
      } catch (error) {
        if (signal.aborted) return giveBack(runId, key);
        return startFailed(runId, key, attempt, error);
      }
      check = await verdict(runId, key, signal);
      if (!check.go) return giveBack(runId, key, check.stopWith);
      if (prepared.kind === 'blocked') {
        const { blocker, message } = prepared;
        await write(runId, (run) => block(run, key, { kind: blocker, message }, deps.now()));
        return;
      }
      const number = slotNumber(check.run, key);
      const stepId = check.slot.stepId;
      const step = check.run.spec.steps.find((candidate) => candidate.id === stepId);
      let handle: RunHandle;
      try {
        const estimateUsd = await deps.estimate(check.run.model, check.run.format, prepared.images);
        handle = await deps.beginRun(
          {
            run: check.run,
            slot: check.slot,
            number,
            estimateUsd,
            title: `Sequence step ${number}: ${(step?.prompt.trim() || prepared.text).slice(0, 60)}`,
            preApproved: !check.slot.forced,
          },
          signal,
        );
      } catch (error) {
        if (signal.aborted) return giveBack(runId, key);
        return startFailed(runId, key, attempt, error);
      }
      // The last look before anything is sent.
      check = await verdict(runId, key, signal);
      if (!check.go) {
        await handle.fail(
          abortError('The sequence was paused or stopped before this step was sent.'),
        );
        return giveBack(runId, key, check.stopWith);
      }
      const label = `Sequence step ${number}${step?.prompt.trim() ? `: ${step.prompt.trim().slice(0, 50)}` : ''}`;
      try {
        const job = await deps.submit(handle, prepared.body, {
          v: 1,
          model: check.run.model,
          prompt: prepared.body.prompt ?? '',
          label,
          after: null,
          continues: prepared.continues,
          sequenceId: runId,
          slotKey: key,
          attempt,
          delivered: false,
        });
        await write(runId, (run) =>
          markRunning(run, key, { jobId: job.id, runId: handle.id, attempt }, deps.now()),
        );
      } catch (error) {
        await write(runId, (run) =>
          markFailed(
            run,
            key,
            { jobId: null, attempt, error: userMessage(error), billed: billedBy(error) },
            deps.now(),
          ),
        );
        if (needsAction(error)) deps.report(error);
      }
    };
    starts.set(key, controller);
    try {
      await deps.withStartLock(runId, key, work);
    } catch (error) {
      console.error(error);
    } finally {
      if (starts.get(key) === controller) starts.delete(key);
    }
    void advance();
  };

  // --- recovery -----------------------------------------------------------------------------------------------
  const recover = async (jobs: readonly JobRecord[]): Promise<void> => {
    const stored = await store.sequence();
    if (!stored) return;
    for (const slot of stored.slots) {
      if (slot.status !== 'starting' || starts.has(slot.key)) continue;
      if (slot.claimedBy === deps.tabId || (await deps.claimAlive(slot))) continue;
      if (await deps.starting(stored.id, slot.key)) continue;
      const job = jobs.find((candidate) => {
        const payload = parsePayload(candidate.payload);
        return (
          payload?.sequenceId === stored.id &&
          payload.slotKey === slot.key &&
          payload.attempt === slot.attempt &&
          !isFinalState(candidate.state)
        );
      });
      await write(stored.id, (run) => {
        const current = run.slots.find((candidate) => candidate.key === slot.key);
        if (current?.status !== 'starting' || current.claimedBy !== slot.claimedBy) return run;
        return job?.runId
          ? markRunning(
              run,
              slot.key,
              { jobId: job.id, runId: job.runId, attempt: slot.attempt },
              deps.now(),
            )
          : abandonStart(run, slot.key, deps.now());
      });
    }
  };

  return {
    advance,
    abortStarts() {
      for (const controller of starts.values()) controller.abort(abortError('Paused.'));
    },
    recover,
  };
}
