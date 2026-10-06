/**
 * Video studio (docs/openrouter-api.md §7): video clips from a prompt, from frames or reference images, continued
 * or extended from any clip of the session (uploads included), auto-extend sequences, a frame grabber, and a
 * timeline joined into one MP4 in the browser.
 *
 * - **Jobs:** every clip is one run and one persisted job. The run is handed off (`run.handOff`) as soon as the
 *   job is queued, so Generate is free again at once and leaving the page is safe. The job polls
 *   `GET /videos/{id}` (quick at first, then every 30 s) and succeeds with the completed status's cost, which the
 *   core books on the run; the tab that sees it finish ends the run, places the clip and settles its sequence step
 *   in one locked update (delivery.ts), then downloads the video. A clip OpenRouter no longer has (404) is marked
 *   expired (its cost stays booked). `POST /videos` is never sent again by itself once it may have reached
 *   OpenRouter. "Stop waiting" ends the run as stopped (`run.cancel`).
 * - **Persisted state** (`ctx.state`, JSON only): the timeline and the sequence run, written under one Web Lock
 *   (store.ts). Form edits reach a stored run field by field (only what this tab's user changed), and every change
 *   of the stored run, here or in another tab, is read back into the form.
 * - **Sequences:** sequence.ts holds the rules, sequence-runner.ts runs them. Start approves the whole sequence
 *   once (`runs.approveGroup`: ONE budget question for its total estimate, with the cap); its steps then begin
 *   under that approval without a dialog of their own (each still reserves its estimate). A Re-run asks for itself.
 * - **Leave guard:** generated clips and joined videos are session results; running jobs and a running sequence
 *   are held work.
 */
import type { RawVideoModel, VideoRequest } from '../../core/api/types';
import {
  InvalidInputError,
  isOutcomeUnknown,
  OrError,
  RunCancelledError,
  userMessage,
} from '../../core/errors';
import { isFinalState, webLocks } from '../../core/jobs';
import { toDataUrl } from '../../core/media/image';
import { captureFrame, getVideoMetadata } from '../../core/media/video';
import type { JobRecord, RunHandle, Usage } from '../../core/types';
import { bindJobList, jobList } from '../../ui/components/job-list';
import type { ReferenceInput } from '../../ui/components/reference-picker';
import { switchField } from '../../ui/components/switch-field';
import { videoResultCard } from '../../ui/components/video-result-card';
import { mimeMatches } from '../../ui/components/file-types';
import { h } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { confirmDialog } from '../../ui/feedback/dialogs';
import { isStop, presentError } from '../../ui/feedback/errors';
import { formatBytes, formatUsd, plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import type { SendItem, ToolContext, ToolInstance } from '../../ui/tool/types';
import { clipPanel, VIDEO_TYPES } from './clip-panel';
import { type ClipMedia, createClipMedia } from './clip-media';
import { placeDelivery, repairSlots } from './delivery';
import type { ClipFormat } from './format';
import { formatFields } from './format-fields';
import { frameGrabber } from './frame-grabber';
import {
  parsePayload,
  parseResult,
  pollInterval,
  VIDEO_JOB,
  type VideoJobPayload,
  type VideoJobResult,
} from './job-payload';
import {
  buildVideoRequest,
  CONTINUE_PROMPT,
  controlsFor,
  type ClipMode,
  type ControlsResult,
  DEFAULT_SETTINGS,
  effectiveFormat,
  extendNote,
  extendPlan,
  LAST_FRAME_ONLY_MODELS,
  modeProblem,
  parseSettings,
  resolutionRank,
  settingsJson,
  type StudioSettings,
  VIDEO_REFERENCE_MAX,
  type VideoControls,
} from './params';
import {
  applySpecEdit,
  chooseSource,
  createRun,
  dropStepImages,
  effectiveRole,
  isActive,
  markFailed,
  pause,
  rerun,
  resume,
  type SequenceRun,
  type SequenceSpec,
  slotNumber,
  type SpecEdit,
  type StepSpec,
  stop,
} from './sequence';
import { sequencePanel } from './sequence-panel';
import { billedBy, createSequenceRunner, imagesForSlot, markSent } from './sequence-runner';
import { createStore, SEQUENCE_KEY, TIMELINE_KEY } from './store';
import {
  clampTrim,
  insertClip,
  joinPlan,
  moveClip,
  removeClip,
  type TimelineClip,
  updateClip,
} from './timeline';
import { timelinePanel } from './timeline-panel';
import { frameRateOf } from './video-fps';

/** Frames and references are scaled to this before upload (data URLs; PNG kept when it fits). */
const IMAGE_ENCODING = { maxSide: 2048, maxBytes: 4 * 1024 * 1024 };
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
/** Typing in a step prompt or the style reaches the stored run after this pause. */
const EDIT_DELAY_MS = 300;
/** Without Web Locks, a claim older than this belongs to a page that is gone. */
const CLAIM_STALE_MS = 2 * 60_000;

/** A short file stem from a prompt: `fishing-boat-leaves-a-quiet`. */
export function stemFrom(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  return words.join('-').slice(0, 48) || 'clip';
}

const shorten = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * A one-clip job's name in the Jobs list: "Continue clip 2: the camera rises", or "Extend the linked video" when
 * native extend has no clip of the timeline (the public link is the source).
 */
export function clipLabel(
  mode: ClipMode,
  sourceIndex: number,
  typed: string,
  sent: string,
): string {
  if (mode !== 'continue' && mode !== 'extend') return shorten(sent, 70);
  const verb = mode === 'continue' ? 'Continue' : 'Extend';
  const what = sourceIndex >= 0 ? `${verb} clip ${sourceIndex + 1}` : `${verb} the linked video`;
  return `${what}${typed.trim() ? `: ${shorten(typed.trim(), 50)}` : ''}`;
}

/** Usage for a request that reached OpenRouter without a known cost: the run books its reservation. */
const unknownUsage = (model: string): Usage => ({
  model,
  promptTokens: 0,
  completionTokens: 0,
  costUsd: 0,
  costEstimated: false,
  costUnknown: true,
  latencyMs: 0,
});

/** The resolution label an exact size bills at (its short side), when the model lists it. */
function sizeResolution(size: string, resolutions: readonly string[] | null): string | undefined {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match || !resolutions) return undefined;
  const side = Math.min(Number(match[1]), Number(match[2]));
  return resolutions.find((r) => resolutionRank(r) === side);
}

/** The PNG data URL of a video's true final frame (Continue, chained steps). */
async function lastFrameDataUrl(blob: Blob): Promise<string> {
  const png = await captureFrame(blob, 'last');
  return toDataUrl(png, {
    maxDimension: IMAGE_ENCODING.maxSide,
    maxBytes: IMAGE_ENCODING.maxBytes,
    type: 'image/png',
  });
}

/** Whether a Web Lock is free (nobody holds it); true where Web Locks are missing. */
async function lockIsFree(name: string): Promise<boolean> {
  const locks = webLocks();
  if (!locks) return true;
  try {
    return await locks.request(name, { ifAvailable: true }, (lock) => lock !== null);
  } catch {
    return true;
  }
}

const startLockName = (runId: string, key: string): string =>
  `ortoolbox:video-studio:start:${runId}:${key}`;
const tabLockName = (tabId: string): string => `ortoolbox:video-studio:tab:${tabId}`;

/** A failed job's reason as a user-safe error (never a bare Error: History would show "Something went wrong"). */
const jobFailure = (message: string): OrError => new OrError('api', message);

export function setup(ctx: ToolContext): ToolInstance {
  const { ui } = ctx;
  const tool = ctx.manifest.id;
  const store = createStore(ctx.state);
  /** Why a store write failed, for a message (a failure that is not one of ours is the browser's storage). */
  const storageReason = (cause: unknown): string =>
    cause instanceof OrError
      ? userMessage(cause).replace(/\.$/, '')
      : 'the browser could not save it';
  /**
   * Runs work nobody awaits (a button, a timer, a bus event): a failure is shown, never left as an unhandled
   * rejection with a page that went stale. `reload` reads the stored timeline again when the page had already
   * drawn the change.
   */
  const background = (work: Promise<unknown>, options: { reload?: 'timeline' } = {}): void => {
    work.catch((error: unknown) => {
      void presentError(
        error instanceof OrError
          ? error
          : new OrError(
              'storage-unavailable',
              `Could not save your change (${storageReason(error)}).`,
              { cause: error },
            ),
      );
      if (options.reload === 'timeline') void reloadTimeline().catch(() => undefined);
    });
  };
  /** This page, for sequence claims; its life lock tells other tabs it is open. */
  const tabId = uid('video-tab');
  const locks = webLocks();
  if (locks) {
    void locks
      .request(tabLockName(tabId), () => new Promise<void>(() => undefined))
      .catch(() => undefined);
  }

  // --- state --------------------------------------------------------------------------------------------------
  let settings: StudioSettings = structuredClone(DEFAULT_SETTINGS);
  let prompt = '';
  /** The clip the one-clip form continues or extends (a timeline clip id). */
  let clipSourceId: string | null = null;
  /** The clip a new sequence's first chained step continues. */
  let sequenceSourceId: string | null = null;
  /** Mirrors of the persisted timeline and sequence run. */
  let clips: TimelineClip[] = [];
  let run: SequenceRun | null = null;
  let runningJobs = 0;

  // --- models ---------------------------------------------------------------------------------------------
  /** `GET /videos/models`; null when it could not be read (requests then send the prompt and images only). */
  let videoList: RawVideoModel[] | null = null;
  const loadModels = async (refresh = false): Promise<void> => {
    try {
      videoList = await ctx.models.videoModels(refresh ? { refresh: true } : undefined);
    } catch {
      videoList = null;
    }
  };
  let modelsReady = loadModels();
  const statusFor = (model: string | null): ControlsResult | null =>
    model ? controlsFor(videoList, model) : null;
  const controlsOf = (model: string | null): VideoControls | null => {
    const result = statusFor(model);
    return result?.status === 'ready' ? result.controls : null;
  };
  const currentModel = (): string | null => ctx.model().model;
  /** Why `model` cannot run now (missing from the video models, free-only), or null. */
  const modelBlocked = (model: string | null): string | null => {
    if (model === null) return 'No model is available in free-only mode.';
    if (statusFor(model)?.status === 'missing') {
      return `${model} is not a video generator. Choose another model.`;
    }
    if (ctx.settings.get().freeOnly && !ctx.models.isFree(model)) {
      return `Free-only mode is on, and ${model} is not free.`;
    }
    return null;
  };

  // --- estimates ------------------------------------------------------------------------------------------
  /** One clip on `model` with `format`, sending `images` images; null when unknown. */
  const estimateClip = async (
    model: string,
    format: ClipFormat,
    images: number,
  ): Promise<number | null> => {
    await modelsReady;
    const controls = controlsOf(model);
    if (!controls) return null;
    const value = effectiveFormat(format, controls);
    if (value.duration === null) return null;
    const resolution =
      value.resolution ??
      (value.size ? sizeResolution(value.size, controls.resolutions) : undefined);
    return ctx.models.estimate({
      kind: 'video',
      model,
      seconds: value.duration,
      ...(resolution ? { resolution } : {}),
      ...(value.withAudio !== null ? { withAudio: value.withAudio } : {}),
      ...(images > 0 ? { images } : {}),
    });
  };

  // --- media ----------------------------------------------------------------------------------------------
  const media: ClipMedia = createClipMedia({
    download: (clip, signal) =>
      ctx.api.videos.content(clip.remoteId!, { keyId: clip.keyId!, signal }),
    addResult: (clip, blob) => ui.addResult({ kind: 'video', name: clip.name, blob }),
    lastFrame: lastFrameDataUrl,
    onChange: (clipId) => {
      void measure(clipId);
      scheduleRender();
    },
    // Expired on OpenRouter: recorded, so no tab offers it, joins it or downloads it again.
    onExpired: (clip) =>
      background(saveTimeline((list) => updateClip(list, clip.id, { expired: true }))),
  });
  /** Reads a clip's length once its video is here, and stores it. */
  const measuring = new Set<string>();
  const measure = async (clipId: string): Promise<void> => {
    const clip = clips.find((candidate) => candidate.id === clipId);
    const blob = media.blob(clipId);
    if (!clip || !blob || clip.duration !== null || measuring.has(clipId)) return;
    measuring.add(clipId);
    try {
      const { duration } = await getVideoMetadata(blob);
      if (duration > 0) await saveTimeline((list) => updateClip(list, clipId, { duration }));
    } catch {
      // Unreadable here: the join still reads it with ffmpeg.
    } finally {
      measuring.delete(clipId);
    }
  };
  const clipById = (id: string | null): TimelineClip | undefined =>
    id ? clips.find((clip) => clip.id === id) : undefined;
  /** A clip on the timeline whose video this page has or can download. */
  const usable = (clip: TimelineClip | undefined): clip is TimelineClip =>
    !!clip && clips.some((candidate) => candidate.id === clip.id) && media.usable(clip);
  const usableClips = (): TimelineClip[] => clips.filter((clip) => media.usable(clip));

  // --- persisted state ------------------------------------------------------------------------------------
  const saveTimeline = async (
    fn: (list: readonly TimelineClip[]) => readonly TimelineClip[],
  ): Promise<void> => {
    clips = await store.updateTimeline(fn);
    scheduleRender();
  };
  /** The stored run changed (here or elsewhere): mirror it, bring it into the form, say how it ended. */
  const runChanged = (next: SequenceRun | null): void => {
    const previous = run;
    run = next;
    syncFormFromRun(next);
    if (next) noteFinish(previous, next);
    if (next && next.status !== 'running') sequenceRunner.abortStarts();
    scheduleRender();
  };
  const saveSequence = async (
    fn: (current: SequenceRun | null) => SequenceRun | null,
  ): Promise<SequenceRun | null> => {
    const next = await store.updateSequence(fn);
    runChanged(next);
    return next;
  };
  const reloadTimeline = async (): Promise<void> => {
    const next = await store.timeline();
    for (const clip of clips) {
      if (!next.some((candidate) => candidate.id === clip.id)) {
        media.forget(clip.id);
        grabber.clipGone(clip.id);
      }
    }
    clips = next;
    media.prefetch(clips);
    for (const clip of clips) void measure(clip.id);
    scheduleRender();
  };
  const reloadSequence = async (): Promise<void> => {
    runChanged(await store.sequence());
  };
  const recoverStarts = async (): Promise<void> => {
    const all = await ctx.jobs.list({ tool }).catch(() => [] as JobRecord[]);
    await sequenceRunner.recover(all);
  };
  ctx.bus.on('tool-state-changed', (event) => {
    if (event.tool !== tool) return;
    if (event.key === TIMELINE_KEY) background(reloadTimeline());
    if (event.key === SEQUENCE_KEY) background(reloadSequence().then(() => recoverStarts()));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      background(recoverStarts().then(() => sequenceRunner.advance()));
    }
  });

  // --- form edits reach the stored run, field by field --------------------------------------------------------
  /** Edits not written yet (typing), merged; written after a pause, on blur-like moments and before actions. */
  let pending: SpecEdit = {};
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  const mergeEdit = (into: SpecEdit, edit: SpecEdit): SpecEdit => {
    const steps = [...(into.steps ?? [])];
    for (const step of edit.steps ?? []) {
      const at = steps.findIndex((candidate) => candidate.id === step.id);
      if (at >= 0) steps[at] = { ...steps[at]!, ...step };
      else steps.push(step);
    }
    return {
      ...into,
      ...edit,
      ...(steps.length ? { steps } : {}),
      ...(into.stepImages || edit.stepImages
        ? { stepImages: { ...into.stepImages, ...edit.stepImages } }
        : {}),
    };
  };
  const flushEdits = async (): Promise<void> => {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
    const edit = pending;
    pending = {};
    if (Object.keys(edit).length === 0 || !run) return;
    await saveSequence((current) => (current ? applyEditNow(current, edit) : current));
  };
  const applyEditNow = (current: SequenceRun, edit: SpecEdit): SequenceRun => {
    // The steps' prompts and images are read while a step is sent: never changed under a running sequence.
    const safe: SpecEdit =
      current.status === 'running'
        ? {
            ...(edit.capUsd !== undefined ? { capUsd: edit.capUsd } : {}),
            ...(edit.onFailure !== undefined ? { onFailure: edit.onFailure } : {}),
            ...(edit.stepImages ? { stepImages: edit.stepImages } : {}),
          }
        : edit;
    return applySpecEditTo(current, safe);
  };
  const applySpecEditTo = (current: SequenceRun, edit: SpecEdit): SequenceRun =>
    Object.keys(edit).length === 0 ? current : applySpecEdit(current, edit, Date.now());
  const queueEdit = (edit: SpecEdit, now = false): void => {
    if (!run) return;
    pending = mergeEdit(pending, edit);
    if (pendingTimer) clearTimeout(pendingTimer);
    if (now) {
      background(flushEdits().then(() => sequenceRunner.advance()));
      return;
    }
    pendingTimer = setTimeout(() => background(flushEdits()), EDIT_DELAY_MS);
  };
  /**
   * The stored run into the form: the run's values, with this tab's edits not written yet on top. An active run
   * fixes the list's shape too; a finished one only its steps' values (the form may grow for the next Start).
   */
  const syncFormFromRun = (stored: SequenceRun | null): void => {
    if (!stored) return;
    const mine = new Map((pending.steps ?? []).map((step) => [step.id, step]));
    const fromRun = new Map(stored.spec.steps.map((step) => [step.id, step]));
    const own = (step: StepSpec): StepSpec => {
      const edited = mine.get(step.id);
      return edited ? { ...step, ...edited } : step;
    };
    const steps = isActive(stored)
      ? stored.spec.steps.map(own)
      : settings.sequence.steps.map((step) => own(fromRun.get(step.id) ?? step));
    settings.sequence = {
      ...(isActive(stored) ? stored.spec : settings.sequence),
      style: pending.style ?? stored.spec.style,
      capUsd: pending.capUsd !== undefined ? pending.capUsd : stored.spec.capUsd,
      onFailure: pending.onFailure ?? stored.spec.onFailure,
      steps,
    };
  };

  // --- notifications --------------------------------------------------------------------------------------
  /** The drawer's switch: one-clip jobs opt in to the core's notification with it (`jobs.add` `notify`). */
  const notifyOn = (): boolean => ctx.options.get()['notify'] === true;
  const notifyAllowed = (): boolean =>
    notifyOn() && typeof Notification !== 'undefined' && Notification.permission === 'granted';
  /**
   * One browser notification when a sequence ends while the tab is in the background. Its step jobs do not notify:
   * a chained sequence has no open job between steps, so the core's per-group notification would fire after step 1.
   */
  const noteFinish = (before: SequenceRun | null, after: SequenceRun): void => {
    if (before?.id !== after.id) return;
    // Every change the user did not just make in front of the page is said: a pause or stop by the cap, the
    // failure rule, a missing key or a blocker, as well as the end.
    const newBlocker =
      after.blocker !== null &&
      (before.blocker?.slotKey !== after.blocker.slotKey ||
        before.blocker.kind !== after.blocker.kind);
    const changed =
      before.status !== after.status &&
      (after.status === 'paused' || after.status === 'stopped' || after.status === 'done');
    if (!changed && !newBlocker) return;
    announce(
      after.message ??
        (after.status === 'done' ? 'The sequence ended.' : `The sequence is ${after.status}.`),
    );
    const ended = after.status === 'done' || after.status === 'stopped';
    if (!ended || before.status === after.status) return;
    if (!notifyAllowed() || document.visibilityState !== 'hidden') return;
    try {
      new Notification(
        `${ctx.manifest.name}: sequence ${after.status === 'done' ? 'finished' : 'stopped'}`,
        { body: after.message ?? '', tag: `ortoolbox-sequence-${after.id}` },
      );
    } catch {
      // Some browsers only show notifications from a service worker; the page still says it.
    }
  };

  // --- held work (leave guard) ----------------------------------------------------------------------------
  let hold: { text: string; release: () => void } | null = null;
  const syncHold = (): void => {
    const parts: string[] = [];
    if (runningJobs > 0) parts.push(`${plural(runningJobs, 'video job')} still generating`);
    if (run?.status === 'running') parts.push('a video sequence in progress');
    const text = parts.join(' and ');
    if (text === (hold?.text ?? '')) return;
    hold?.release();
    hold = text ? { text, release: ui.holdWork(text) } : null;
  };
  const countJobs = async (): Promise<void> => {
    const open = await ctx.jobs.list({ tool, states: ['queued', 'running'] }).catch(() => []);
    runningJobs = open.length;
    syncHold();
  };

  // --- input zone -----------------------------------------------------------------------------------------
  const tabName = uid('video-tab');
  const tabChoice = (value: StudioSettings['tab'], label: string, glyph: string) => {
    const id = uid('video-tab-option');
    const input = h('input', {
      id,
      type: 'radio',
      class: 'btn-check',
      name: tabName,
      value,
      autocomplete: 'off',
      'data-testid': `video-tab-${value}`,
      onchange: () => input.checked && setTab(value),
    });
    return {
      input,
      element: h(
        'span',
        null,
        input,
        h(
          'label',
          {
            class: 'btn btn-outline-secondary d-inline-flex align-items-center gap-2',
            htmlFor: id,
          },
          icon(glyph),
          label,
        ),
      ),
    };
  };
  const clipTab = tabChoice('clip', 'One clip', 'camera-reels');
  const sequenceTab = tabChoice('sequence', 'Sequence', 'collection-play');
  const tabs = h(
    'fieldset',
    { 'data-testid': 'video-tabs' },
    h('legend', { class: 'form-label fw-semibold fs-6 mb-1' }, 'Make'),
    h('div', { class: 'd-flex flex-wrap gap-2' }, clipTab.element, sequenceTab.element),
  );

  const clipForm = clipPanel({
    ui,
    onMode: (mode) => {
      settings.mode = mode;
      formChanged();
    },
    onPrompt: (text) => {
      prompt = text;
      formChanged();
    },
    onSource: (clipId) => {
      clipSourceId = clipId;
      formChanged();
    },
    onExtendUrl: (text) => {
      settings.extendUrl = text;
      formChanged();
    },
    onUploads: (files) => background(addUploads(files)),
    onImages: () => formChanged(),
  });

  const format = formatFields({
    onChange: (patch) => {
      settings.format = { ...settings.format, ...patch };
      formChanged();
    },
  });

  let stepCounter = 0;
  const stepEdit = (stepId: string): SpecEdit['steps'] => {
    const step = settings.sequence.steps.find((candidate) => candidate.id === stepId);
    return step ? [{ id: step.id, prompt: step.prompt, imageRole: step.imageRole }] : [];
  };
  const sequenceForm = sequencePanel({
    ui,
    onSpec: (patch) => {
      settings.sequence = { ...settings.sequence, ...patch };
      if (patch.capUsd !== undefined) queueEdit({ capUsd: patch.capUsd }, true);
      if (patch.onFailure !== undefined) queueEdit({ onFailure: patch.onFailure }, true);
      if (patch.style !== undefined) queueEdit({ style: patch.style });
      formChanged();
    },
    onSteps: (steps: StepSpec[]) => {
      settings.sequence = { ...settings.sequence, steps };
      formChanged();
    },
    onStepEdit: (stepId) => queueEdit({ steps: stepEdit(stepId) }),
    onSource: (clipId) => {
      sequenceSourceId = clipId;
      formChanged();
    },
    onImages: (stepId) => {
      // The stored count follows what the user set (removing images on purpose is allowed).
      const count = sequenceForm.images(stepId)?.references().length ?? 0;
      queueEdit({ stepImages: { [stepId]: count } }, true);
      if (run && count === 0 && (run.stepImages[stepId] ?? 0) > 0) {
        ui.status('That step will be sent without images.');
      }
      formChanged();
    },
    newStepId: () => {
      const taken = new Set(settings.sequence.steps.map((step) => step.id));
      let id: string;
      do id = `step-${Date.now().toString(36)}-${++stepCounter}`;
      while (taken.has(id));
      return id;
    },
    start: () => void startSequencePressed(),
    pause: () =>
      background(saveSequence((current) => (current ? pause(current, Date.now()) : current))),
    resume: () => background(resumeSequence()),
    stop: () =>
      background(saveSequence((current) => (current ? stop(current, Date.now()) : current))),
    clear: () => background(clearSequence()),
    rerun: (key) => background(rerunSlot(key)),
    chooseSource: (key, clipId) =>
      background(answerBlocker((current) => chooseSource(current, key, clipId, Date.now()))),
    dropImages: (stepId) =>
      background(answerBlocker((current) => dropStepImages(current, stepId, Date.now()))),
    rerunPrevious: (key) => {
      const index = run?.slots.findIndex((slot) => slot.key === key) ?? -1;
      const previous = index > 0 ? run?.slots[index - 1] : undefined;
      if (!previous) return;
      background(
        answerBlocker((current) => {
          const again = rerun(current, previous.key, Date.now());
          return again ? { ...again, blocker: null, status: 'running', message: null } : current;
        }),
      );
    },
  });

  const clipPane = h('div', { 'data-testid': 'video-pane-clip' }, clipForm.element);
  const sequencePane = h('div', { 'data-testid': 'video-pane-sequence' }, sequenceForm.element);
  ui.input.append(h('div', { class: 'd-flex flex-column gap-3' }, tabs, clipPane, sequencePane));
  ui.drawer.append(format.drawer);
  const notify = switchField({
    label: 'Notify me when videos are ready',
    help: 'A browser notification when a clip or a sequence finishes while this tab is in the background.',
    checked: notifyAllowed(),
    testId: 'video-notify',
    onChange: (checked, input) => void toggleNotify(checked, input),
  });
  ui.drawer.append(notify.element);
  const toggleNotify = async (checked: boolean, input: HTMLInputElement): Promise<void> => {
    if (!checked) {
      ctx.options.set({ notify: false });
      return;
    }
    if (typeof Notification === 'undefined') {
      input.checked = false;
      ui.status('This browser cannot show notifications.');
      return;
    }
    const permission =
      Notification.permission === 'default'
        ? await Notification.requestPermission()
        : Notification.permission;
    if (permission !== 'granted') {
      input.checked = false;
      ctx.options.set({ notify: false });
      ui.status('Notifications are blocked for this site. Allow them in the browser to use this.');
      return;
    }
    ctx.options.set({ notify: true });
    announce('Notifications on.');
  };

  const setTab = (tab: StudioSettings['tab']): void => {
    settings.tab = tab;
    formChanged();
  };

  // --- output zone ----------------------------------------------------------------------------------------
  const jobsHeading = uid('video-jobs');
  const jobs = jobList({
    label: (job) => parsePayload(job.payload)?.label ?? 'Video clip',
    onCancel: (job) => void stopWaiting(job),
    emptyText:
      'Clips being made appear here. If you leave, OpenRouter keeps going and the clip joins the timeline when you open Video studio again.',
    testId: 'video-jobs',
  });
  bindJobList(ctx.jobs, jobs, { tool });
  const clearJobs = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-outline-secondary',
      'data-testid': 'video-jobs-clear',
      onclick: () => background(clearFinishedJobs()),
    },
    'Clear finished',
  );
  const jobsSection = h(
    'section',
    { class: 'd-flex flex-column gap-2', 'aria-labelledby': jobsHeading },
    h(
      'div',
      { class: 'd-flex align-items-center gap-2' },
      h('h3', { id: jobsHeading, class: 'h6 mb-0 me-auto' }, 'Jobs'),
      clearJobs,
    ),
    jobs.element,
  );

  let joining: AbortController | null = null;
  const timeline = timelinePanel({
    state: (clip) => media.state(clip),
    downloadButton: (clip) => media.result(clip.id)?.button() ?? null,
    describe: (clip) => describeClip(clip),
    move: (clipId, delta) => background(moveTimelineClip(clipId, delta), { reload: 'timeline' }),
    trim: (clipId, trimStart, trimEnd) => {
      const clip = clipById(clipId);
      const value = clampTrim(clip?.duration ?? null, trimStart, trimEnd);
      if (!clip) return value;
      clips = updateClip(clips, clipId, value);
      scheduleRender();
      background(
        saveTimeline((list) => updateClip(list, clipId, value)),
        {
          reload: 'timeline',
        },
      );
      return value;
    },
    setIncluded: (clipId, included) => {
      clips = updateClip(clips, clipId, { included });
      scheduleRender();
      background(
        saveTimeline((list) => updateClip(list, clipId, { included })),
        {
          reload: 'timeline',
        },
      );
    },
    setDropFirstFrame: (clipId, dropFirstFrame) => {
      clips = updateClip(clips, clipId, { dropFirstFrame });
      scheduleRender();
      background(
        saveTimeline((list) => updateClip(list, clipId, { dropFirstFrame })),
        {
          reload: 'timeline',
        },
      );
    },
    continueFrom: (clipId) => useSource(clipId, 'continue'),
    extend: (clipId) => useSource(clipId, 'extend'),
    frames: (clipId) => {
      const clip = clipById(clipId);
      const blob = clip && media.blob(clip.id);
      if (clip && blob) {
        void grabber.open(clip, blob, () => void timeline.focusClip(clipId, 'video-clip-frames'));
      }
    },
    remove: (clipId) => background(removeTimelineClip(clipId), { reload: 'timeline' }),
    retry: (clipId) => {
      const clip = clipById(clipId);
      if (!clip) return;
      media.retry(clipId);
      void media.ensure(clip).catch(() => undefined); // shown on the clip, with Try again
    },
    join: () => void joinClips(),
    stopJoin: () => joining?.abort(),
  });

  const grabber = frameGrabber({
    ui,
    frameRate: (blob) => frameRateOf(blob),
    capture: (blob, time, fps) => captureFrame(blob, time, { fps }),
    useAsFirst: (blob, name) => useImage('first', blob, name),
    useAsLast: (blob, name) => useImage('last', blob, name),
    useAsReference: (blob, name) => useImage('references', blob, name),
  });
  const framesHeading = uid('video-frames-heading');
  const framesSection = h(
    'section',
    { class: 'd-flex flex-column gap-2', 'aria-labelledby': framesHeading, hidden: true },
    h('h3', { id: framesHeading, class: 'h6 mb-0' }, 'Saved frames'),
    grabber.gallery,
  );
  new MutationObserver(() => {
    framesSection.hidden = grabber.gallery.childElementCount === 0;
  }).observe(grabber.gallery, { childList: true });

  ui.output.append(
    h(
      'div',
      { class: 'd-flex flex-column gap-4' },
      jobsSection,
      timeline.element,
      grabber.element,
      framesSection,
    ),
  );

  const describeClip = (clip: TimelineClip): string[] => {
    const parts: string[] = [];
    if (clip.source === 'upload') parts.push('Uploaded');
    if (clip.slotKey && run && clip.sequenceId === run.id) {
      const number = slotNumber(run, clip.slotKey);
      if (number > 0)
        parts.push(`Sequence step ${number}${clip.attempt > 1 ? `, take ${clip.attempt}` : ''}`);
    } else if (clip.slotKey) parts.push('Sequence');
    if (clip.staleSource) parts.push('Continued an earlier take of the clip before');
    else if (clip.continues) parts.push('Continues the clip before');
    if (clip.expired) parts.push('Expired on OpenRouter');
    if (!clip.included) parts.push('Left out of the join');
    return parts;
  };

  // --- rendering ------------------------------------------------------------------------------------------
  let renderQueued = false;
  function scheduleRender(): void {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      render();
    });
  }

  /** What the clip form's mode needs from the inputs, and the source clip. */
  const modeInputs = () => {
    const source = clipById(clipSourceId);
    return {
      prompt,
      firstFrame: clipForm.first.references().length > 0,
      lastFrame: clipForm.last.references().length > 0,
      references: clipForm.references.references().length,
      source: usable(source),
      sourceJob: source ? { remoteId: source.remoteId, model: source.model } : null,
      extendUrl: settings.extendUrl,
    };
  };

  /** Images the one-clip request will carry (for the estimate). */
  const clipImages = (controls: VideoControls | null): number => {
    switch (settings.mode) {
      case 'text':
        return 0;
      case 'first':
        return 1;
      case 'first-last':
        return 2;
      case 'references':
        return Math.min(VIDEO_REFERENCE_MAX, clipForm.references.references().length);
      case 'continue':
        return 1;
      case 'extend':
        return extendPlan(controls, settings.extendUrl, modeInputs().sourceJob) === 'continue'
          ? 1
          : 0;
    }
  };

  let sequenceEstimate: { total: number | null; perStep: number | null } = {
    total: null,
    perStep: null,
  };

  function render(): void {
    const model = currentModel();
    const status = statusFor(model);
    const controls = status?.status === 'ready' ? status.controls : null;
    clipTab.input.checked = settings.tab === 'clip';
    sequenceTab.input.checked = settings.tab === 'sequence';
    clipPane.hidden = settings.tab !== 'clip';
    sequencePane.hidden = settings.tab !== 'sequence';
    const slot = settings.tab === 'clip' ? clipForm.formatSlot : sequenceForm.formatSlot;
    if (format.main.parentElement !== slot) slot.append(format.main);
    const formatSignature = JSON.stringify([settings.format, model, status?.status]);
    if (formatSignature !== rendered.format) {
      rendered.format = formatSignature;
      format.render(settings.format, controls);
    }

    // The one-clip form.
    const notes: string[] = [];
    if (status?.status === 'unknown') {
      notes.push(
        "The model's options could not be loaded, so only the prompt and images are sent.",
      );
    }
    notes.push(...effectiveFormat(settings.format, controls).notes);
    const inputs = modeInputs();
    if (settings.mode === 'extend') {
      notes.push(
        extendNote(
          extendPlan(controls, settings.extendUrl, inputs.sourceJob),
          controls,
          settings.extendUrl,
        ),
      );
    }
    // Only problems with the model show up front; missing inputs are said when Generate is pressed.
    const problem = modeProblem(settings.mode, controls, {
      ...inputs,
      prompt: 'x',
      firstFrame: true,
      lastFrame: true,
      references: 1,
      source: true,
    });
    const sources = usableClips();
    clipForm.render({
      mode: settings.mode,
      prompt,
      extendUrl: settings.extendUrl,
      sourceId: clipSourceId,
      clips: sources,
      notes,
      problem,
    });

    // The sequence form: the run's own model decides what its steps take and whether it can resume.
    const runModel = isActive(run) ? run.model : model;
    const runControls = runModel ? controlsOf(runModel) : null;
    sequenceForm.render({
      spec: settings.sequence,
      run,
      clips: sources,
      sourceId: sequenceSourceId,
      lastFrame: runControls ? runControls.lastFrame : true,
      perStep: sequenceEstimate.perStep,
      total: sequenceEstimate.total,
      blocked: modelBlocked(model),
      resumeBlocked: run ? modelBlocked(run.model) : null,
    });

    // The timeline is rebuilt only when it changed (a rebuild moves the players, which pauses them).
    const join = {
      busy: joining !== null,
      blocked: clips.length === 0 ? 'Add or generate clips first.' : null,
    };
    const timelineSignature = JSON.stringify([
      clips,
      clips.map((clip) => {
        const state = media.state(clip);
        return state.kind === 'error' ? state.message : state.kind;
      }),
      clips.map((clip) => media.result(clip.id)?.result.id ?? null),
      join,
      run?.id ?? null,
      run?.slots.map((candidate) => candidate.key) ?? null,
    ]);
    if (timelineSignature !== rendered.timeline) {
      rendered.timeline = timelineSignature;
      timeline.render(clips, join);
    }
    syncHold();
  }
  const rendered = { format: '', timeline: '' };

  /** Something in the form changed: redraw, and estimate again. */
  function formChanged(): void {
    scheduleRender();
    void ui.refreshEstimate();
    void refreshSequenceEstimate();
  }

  /** The sequence's total estimate (and per clip), for the panel. */
  let estimateGeneration = 0;
  const refreshSequenceEstimate = async (): Promise<void> => {
    const mine = ++estimateGeneration;
    const model = currentModel();
    const total = model ? await sequenceTotal(model, settings.sequence) : null;
    if (mine !== estimateGeneration) return;
    const count = settings.sequence.steps.length * settings.sequence.repeat;
    sequenceEstimate = { total, perStep: total === null ? null : total / Math.max(1, count) };
    scheduleRender();
  };

  /** The whole sequence on `model`: every slot at its own estimate (null when one is unknown). */
  const sequenceTotal = async (model: string, spec: SequenceSpec): Promise<number | null> => {
    const preview = createRun({
      id: 'preview',
      spec,
      model,
      format: settings.format,
      sourceClipId: spec.mode === 'chained' ? sequenceSourceId : null,
      now: 0,
    });
    const byImages = await Promise.all(
      Array.from({ length: VIDEO_REFERENCE_MAX + 3 }, (_, images) =>
        estimateClip(model, settings.format, images),
      ),
    );
    const lastFrame = controlsOf(model)?.lastFrame ?? true;
    const pictures = (stepId: string): number =>
      sequenceForm.images(stepId)?.references().length ?? 0;
    let total = 0;
    for (const slot of preview.slots) {
      const estimate = byImages[imagesForSlot(preview, slot, lastFrame, pictures)] ?? null;
      if (estimate === null) return null;
      total += estimate;
    }
    return total;
  };

  // --- clips: uploads, sources, images ---------------------------------------------------------------------
  const isVideoFile = (file: { type: string; name: string }): boolean =>
    mimeMatches(file.type, VIDEO_TYPES) || /\.(mp4|mov|webm|m4v)$/i.test(file.name);
  const isImageFile = (file: { type: string; name: string }): boolean =>
    mimeMatches(file.type, IMAGE_TYPES) || /\.(png|jpe?g|webp)$/i.test(file.name);

  /** Adds uploaded videos to the timeline and makes the last one the clip to continue. */
  const addUploads = async (
    files: readonly (File | { blob: Blob; name: string })[],
  ): Promise<void> => {
    for (const file of files) {
      const blob = file instanceof File ? file : file.blob;
      const name = file.name;
      let duration: number | null;
      try {
        duration = (await getVideoMetadata(blob)).duration || null;
      } catch {
        void presentError(
          new InvalidInputError(
            `${name} cannot be played in this browser, so its frames cannot be read. Convert it to MP4 (H.264) and try again.`,
          ),
        );
        continue;
      }
      const clip: TimelineClip = {
        id: uid('clip'),
        name,
        source: 'upload',
        jobId: null,
        remoteId: null,
        keyId: null,
        model: null,
        prompt: '',
        duration,
        trimStart: 0,
        trimEnd: 0,
        continues: false,
        dropFirstFrame: false,
        included: true,
        sequenceId: null,
        slotKey: null,
        attempt: 1,
        expired: false,
        staleSource: false,
        createdAt: Date.now(),
      };
      media.put(clip, blob);
      await saveTimeline((list) => insertClip(list, clip, 'end'));
      if (settings.tab === 'sequence') {
        // On the Sequence tab the One clip form is out of sight: leave its mode alone. The video is the clip a new
        // chained sequence continues, unless one is under way or the steps are independent.
        const takes = settings.sequence.mode === 'chained' && !isActive(run);
        if (takes) sequenceSourceId = clip.id;
        ui.status(
          takes
            ? `Added ${name} to the timeline: the sequence starts from it.`
            : `Added ${name} to the timeline.`,
        );
      } else {
        clipSourceId = clip.id;
        if (settings.mode !== 'continue' && settings.mode !== 'extend') settings.mode = 'continue';
        ui.status(`Added ${name} to the timeline: it is the clip to continue.`);
      }
    }
    formChanged();
  };

  /** A timeline clip as the one-clip form's source (Continue or Extend). */
  const useSource = (clipId: string, mode: 'continue' | 'extend'): void => {
    const index = clips.findIndex((clip) => clip.id === clipId);
    if (index < 0) return;
    settings.tab = 'clip';
    settings.mode = mode;
    clipSourceId = clipId;
    formChanged();
    queueMicrotask(() => clipForm.prompt.focus());
    ui.status(
      `${mode === 'continue' ? 'Continue' : 'Extend'} clip ${index + 1}: describe what happens next, then Generate.`,
    );
  };

  /** A picture (a saved frame, a received or dropped image) for the one-clip form. */
  const useImage = (role: 'first' | 'last' | 'references', blob: Blob, name: string): void => {
    settings.tab = 'clip';
    const item: ReferenceInput = { blob, name };
    if (role === 'first') {
      if (settings.mode !== 'first' && settings.mode !== 'first-last') settings.mode = 'first';
      clipForm.first.clear();
      clipForm.first.add([item]);
    } else if (role === 'last') {
      settings.mode = 'first-last';
      clipForm.last.clear();
      clipForm.last.add([item]);
    } else {
      settings.mode = 'references';
      clipForm.references.add([item]);
    }
    formChanged();
    ui.status(
      role === 'references'
        ? `${name} is now a reference image.`
        : `${name} is now the ${role} frame.`,
    );
  };

  /** Dropped, pasted or received files: videos join the timeline, images go where the form needs them. */
  const takeFiles = (items: readonly (File | { blob: Blob; name: string })[]): void => {
    const described = items.map((item) => ({
      item,
      type: item instanceof File ? item.type : item.blob.type,
      name: item.name,
    }));
    const videos = described.filter((entry) => isVideoFile(entry)).map((entry) => entry.item);
    const images = described.filter((entry) => isImageFile(entry)).map((entry) => entry.item);
    if (videos.length > 0) void addUploads(videos);
    if (images.length === 0) return;
    void modelsReady.then(() => {
      const named = images.map((image) => ({
        blob: image instanceof File ? image : image.blob,
        name: image.name,
      }));
      if (settings.tab === 'sequence') {
        const last = settings.sequence.steps.at(-1);
        const picker = last ? sequenceForm.images(last.id) : undefined;
        picker?.add(named);
        return;
      }
      if (settings.mode === 'references') clipForm.references.add(named);
      else if (settings.mode === 'first-last') {
        for (const image of named) {
          if (clipForm.first.references().length === 0) clipForm.first.add([image]);
          else clipForm.last.add([image]);
        }
      } else if (named[0]) {
        // The form changes to "First frame" for it, and says so.
        useImage('first', named[0].blob, named[0].name);
      }
      formChanged();
    });
  };

  const moveTimelineClip = async (clipId: string, delta: number): Promise<void> => {
    const moved = moveClip(clips, clipId, delta);
    if (moved === clips) return;
    clips = [...moved];
    scheduleRender();
    const index = clips.findIndex((clip) => clip.id === clipId);
    const name = clips[index]?.name ?? 'The clip';
    announce(`Moved ${name} to position ${index + 1} of ${clips.length}.`);
    await saveTimeline((list) => moveClip(list, clipId, delta));
  };

  const removeTimelineClip = async (clipId: string): Promise<void> => {
    const clip = clipById(clipId);
    if (!clip) return;
    const result = media.result(clipId);
    if (result && !result.result.downloaded) {
      const sure = await confirmDialog({
        title: 'Remove this clip?',
        message: `${clip.name} was not downloaded. Once removed it is gone from this page (OpenRouter may keep it for a short while).`,
        confirmLabel: 'Remove',
        tone: 'danger',
        testId: 'video-remove-confirm',
      });
      if (!sure) return;
    }
    const index = clips.findIndex((candidate) => candidate.id === clipId);
    media.forget(clipId);
    grabber.clipGone(clipId);
    if (clipSourceId === clipId) clipSourceId = null;
    if (sequenceSourceId === clipId) sequenceSourceId = null;
    clips = removeClip(clips, clipId);
    render();
    announce(`Removed ${clip.name}.`);
    const next = clips[index] ?? clips[index - 1];
    if (!next || !timeline.focusClip(next.id, 'clip-remove')) timeline.focusList();
    await saveTimeline((list) => removeClip(list, clipId));
  };

  // --- jobs -----------------------------------------------------------------------------------------------
  // Polling only reads the status; the video is downloaded when the clip is delivered (and again after a reload).
  // The completed status's cost goes back as `usage`: the core books it on the run before the job turns final, so
  // it counts whatever happens to the download.
  ctx.jobs.register<VideoJobPayload, VideoJobResult>(VIDEO_JOB, {
    intervalMs: (job) => pollInterval(Date.now() - job.createdAt),
    poll: async (job, signal) => {
      if (!job.remoteId) return { state: 'failed', error: 'The job has no OpenRouter id.' };
      const status = await ctx.api.videos.status(job.remoteId, { keyId: job.keyId, signal });
      if (!status.done) return { state: 'running', progress: null, remoteStatus: 'Generating' };
      if (status.status === 'completed') {
        return {
          state: 'succeeded',
          result: { costUsd: status.costUsd, outputs: status.outputs },
          usage: { costUsd: status.costUsd },
        };
      }
      return {
        state: 'failed',
        error: status.error ?? `The video job ended as ${status.status}.`,
      };
    },
  });

  /**
   * Ends a job's run (the core already booked its cost: the completed status's, or the reservation when it gave
   * up). "Stop waiting" ends it as stopped, booking the reservation (the job may still finish and bill).
   */
  const settleRun = async (job: JobRecord, payload: VideoJobPayload): Promise<void> => {
    if (!job.runId) return;
    const handle = await ctx.runs.reattach(job.runId);
    if (!handle) {
      // Already final (another tab, or the page-start sweep) is normal. A run record that is gone is not: the
      // clip's cost is booked on the job, but nothing in History shows the clip.
      const record = await ctx.history.get(job.runId).catch(() => undefined);
      if (!record) {
        console.warn(`Video studio: the run ${job.runId} of job ${job.id} has no History entry.`);
        announce('A video finished, but its History entry is gone, so it is not listed there.');
      }
      return;
    }
    if (job.state === 'succeeded') {
      await handle.finish({
        output: `Video clip ready: ${payload.label}.`,
        meta: { videoJobIds: [job.remoteId] },
      });
    } else if (job.state === 'cancelled') {
      await handle.cancel('Stopped waiting for the video job.');
    } else await handle.fail(jobFailure(job.error ?? 'The video job failed.'));
  };

  /** Puts a finished job's clip on the timeline (or records its failure), once. */
  const delivering = new Set<string>();
  const deliver = async (job: JobRecord): Promise<void> => {
    const payload = parsePayload(job.payload);
    if (!payload || payload.delivered || delivering.has(job.id)) return;
    delivering.add(job.id);
    try {
      await settleRun(job, payload).catch((error: unknown) => console.error(error));
      if (job.state === 'succeeded') await placeClip(job, payload);
      else {
        const error =
          job.state === 'cancelled'
            ? 'Stopped waiting for this clip.'
            : (job.error ?? 'The video job failed.');
        if (payload.sequenceId && payload.slotKey) {
          const key = payload.slotKey;
          // As its run books it: a job the provider failed cost nothing; one abandoned ("Stop waiting") or given up
          // on may still bill, so its reservation counts against the cap.
          const billed = job.state === 'failed' && job.failureKind === 'remote' ? 'no' : 'maybe';
          await saveSequence((current) =>
            current?.id === payload.sequenceId
              ? markFailed(
                  current,
                  key,
                  { jobId: job.id, attempt: payload.attempt, error, billed },
                  Date.now(),
                )
              : current,
          );
        } else if (job.state === 'failed') {
          ui.status(`A clip failed: ${error}`);
        }
      }
      await ctx.jobs
        .update(job.id, {
          payload: { ...payload, delivered: true },
          remoteStatus: job.state === 'succeeded' ? 'On the timeline' : null,
        })
        .catch(() => undefined);
    } catch (error) {
      // Not marked delivered, so opening this page again places it; Retry does it now.
      void presentError(
        new OrError(
          'storage-unavailable',
          job.state === 'succeeded'
            ? `A video was made and paid for, but this page could not put it on the timeline (${storageReason(error)}). Try again; it is also added when you reopen this page.`
            : `This page could not record that a video job did not finish (${storageReason(error)}).`,
          { cause: error },
        ),
        { retry: () => void deliver(job) },
      );
    } finally {
      delivering.delete(job.id);
      void sequenceRunner.advance();
    }
  };

  const placeClip = async (job: JobRecord, payload: VideoJobPayload): Promise<void> => {
    const { costUsd } = parseResult(job.result);
    const draft: TimelineClip = {
      id: uid('clip'),
      name: `${stemFrom(payload.prompt)}-${(job.remoteId ?? job.id).slice(-6)}.mp4`,
      source: 'generated',
      jobId: job.id,
      remoteId: job.remoteId,
      keyId: job.keyId,
      model: payload.model,
      prompt: payload.prompt,
      duration: null,
      trimStart: 0,
      trimEnd: 0,
      continues: payload.continues,
      dropFirstFrame: payload.continues,
      included: true,
      sequenceId: payload.sequenceId,
      slotKey: payload.slotKey,
      attempt: payload.attempt,
      expired: false,
      staleSource: false,
      createdAt: Date.now(),
    };
    // Clip and step in one locked step (idempotent: a repeat finds the clip and settles the step again).
    const placed = await store.transaction(async (tx) => {
      const stored = await tx.sequence();
      const result = placeDelivery(
        await tx.timeline(),
        stored,
        { jobId: job.id, costUsd, payload },
        draft,
        Date.now(),
      );
      await tx.setTimeline(result.clips);
      if (result.run && result.run !== stored) await tx.setSequence(result.run);
      return result;
    });
    clips = placed.clips;
    runChanged(placed.run ?? (await store.sequence()));
    if (!media.blob(placed.clip.id)) void media.ensure(placed.clip).catch(() => undefined); // shown on the clip
    if (!payload.sequenceId) ui.status(`Clip ready: ${placed.clip.name}.`);
    scheduleRender();
  };

  ctx.jobs.subscribe((record) => {
    if (record.tool !== tool || record.type !== VIDEO_JOB) return;
    void countJobs();
    if (record.removed || !isFinalState(record.state)) return;
    void deliver(record);
  });

  const stopWaiting = async (job: JobRecord): Promise<void> => {
    const sure = await confirmDialog({
      title: 'Stop waiting for this clip?',
      message:
        'OpenRouter cannot cancel a video job: it still finishes and may be billed, but this page will not download it.',
      confirmLabel: 'Stop waiting',
      tone: 'warning',
      testId: 'video-cancel-confirm',
    });
    if (sure) await ctx.jobs.cancel(job.id).catch((error: unknown) => void presentError(error));
  };

  const clearFinishedJobs = async (): Promise<void> => {
    const all = await ctx.jobs.list({ tool });
    let removed = 0;
    for (const job of all) {
      if (!isFinalState(job.state) || !parsePayload(job.payload)?.delivered) continue;
      await ctx.jobs.remove(job.id).catch(() => undefined);
      removed++;
    }
    announce(
      removed ? `Cleared ${plural(removed, 'finished job')}.` : 'No finished jobs to clear.',
    );
  };

  /**
   * Sends one request in `handle`'s run and queues its job; the run is handed off to the job. A request that may
   * have reached a provider without an answer is the API client's (it books the unknown cost and marks the error
   * `outcomeUnknown`). One OpenRouter accepted that this page then cannot follow (no job id, the job not stored) is
   * this function's: the run books its reservation and the error says so, marked as sent (sequence-runner.ts
   * `billedBy`). Neither is ever sent again by itself.
   */
  const submitJob = async (
    handle: RunHandle,
    body: VideoRequest,
    payload: VideoJobPayload,
  ): Promise<JobRecord> => {
    const status = await ctx.api.videos
      .submit(body, { run: handle })
      .catch(async (error: unknown) => {
        await handle.fail(error);
        throw error;
      });
    try {
      if (!status.id) throw new InvalidInputError('OpenRouter did not return a job id.');
      const job = await ctx.jobs.add<VideoJobPayload, VideoJobResult>({
        tool,
        type: VIDEO_JOB,
        payload,
        keyId: handle.keyId,
        remoteId: status.id,
        runId: handle.id,
        groupId: payload.sequenceId,
        state: 'running',
        // A sequence notifies once when it ends (noteFinish), not per step.
        notify: payload.sequenceId === null && notifyOn(),
      });
      handle.handOff(job.id);
      return job;
    } catch (cause) {
      handle.addUsage(unknownUsage(handle.model));
      await handle.fail(cause);
      const error = new OrError(
        'api',
        `OpenRouter accepted the video request, but this page could not keep track of it (${userMessage(cause).replace(/\.$/, '')}). It is probably being made and billed: check your OpenRouter activity before sending it again.`,
        { cause },
      );
      markSent(error);
      throw error;
    }
  };

  // --- one clip -------------------------------------------------------------------------------------------
  const focusProblem = (problem: string): void => {
    ui.status(problem);
    if (/first frame/i.test(problem)) {
      if (!clipForm.first.focus()) clipForm.prompt.focus();
    } else if (/last frame/i.test(problem)) {
      if (!clipForm.last.focus()) clipForm.prompt.focus();
    } else if (/reference/i.test(problem)) {
      if (!clipForm.references.focus()) clipForm.prompt.focus();
    } else if (/clip to/i.test(problem)) {
      clipForm.focusSource();
    } else clipForm.prompt.focus();
  };

  const generateClip = async (signal: AbortSignal): Promise<void> => {
    // The form as it is now: what History records and what is sent, whatever changes during the awaits below.
    const snapshot = { prompt, settings: settingsJson(settings) };
    const model = currentModel();
    if (!model) return;
    await modelsReady;
    const status = statusFor(model);
    if (status?.status === 'missing') {
      ui.status(`${model} is not a video generator. Choose another model.`);
      return;
    }
    const controls = status?.status === 'ready' ? status.controls : null;
    const form = parseSettings(snapshot.settings);
    const text0 = snapshot.prompt;
    const mode = form.mode;
    const inputs = { ...modeInputs(), prompt: text0, extendUrl: form.extendUrl };
    const problem = modeProblem(mode, controls, inputs);
    if (problem) return focusProblem(problem);
    const pickers =
      mode === 'first'
        ? [clipForm.first]
        : mode === 'first-last'
          ? [clipForm.first, clipForm.last]
          : mode === 'references'
            ? [clipForm.references]
            : [];
    for (const picker of pickers) {
      const issue = picker.problem();
      if (issue) {
        ui.status(issue);
        picker.focus();
        return;
      }
    }

    const source = clipById(clipSourceId);
    const extend =
      mode === 'extend' ? extendPlan(controls, form.extendUrl, inputs.sourceJob) : null;
    const continuing = mode === 'continue' || extend === 'continue';
    let firstFrame: string | null = null;
    let lastFrame: string | null = null;
    let references: string[] = [];
    if (mode === 'first' || mode === 'first-last') {
      firstFrame = (await clipForm.first.dataUrls(IMAGE_ENCODING))[0] ?? null;
    }
    if (mode === 'first-last')
      lastFrame = (await clipForm.last.dataUrls(IMAGE_ENCODING))[0] ?? null;
    if (mode === 'references') references = await clipForm.references.dataUrls(IMAGE_ENCODING);
    if (continuing && source) {
      ui.status('Reading the last frame of the clip…');
      firstFrame = await media.lastFrame(source);
    }
    const text = text0.trim() || (mode === 'continue' || mode === 'extend' ? CONTINUE_PROMPT : '');
    const built = buildVideoRequest({
      model,
      prompt: text,
      format: form.format,
      controls,
      firstFrame,
      lastFrame,
      references,
      videoUrl: extend === 'native' ? form.extendUrl.trim() : null,
      previousJobId: extend === 'previous-job' ? (source?.remoteId ?? null) : null,
    });
    const estimateUsd = await estimateClip(model, form.format, built.images);

    // Refused before anything was sent (no key, locked, free-only, budget, Cancel): nothing changes.
    const handle = await ctx.beginRun(
      {
        model,
        prompt: snapshot.prompt,
        settings: snapshot.settings,
        title: shorten(text || 'Video clip', 80),
        estimateUsd,
      },
      signal,
    );
    ui.status('Sending the request…');
    const label = clipLabel(
      mode,
      source ? clips.findIndex((clip) => clip.id === source.id) : -1,
      text0,
      text,
    );
    try {
      await submitJob(handle, built.body, {
        v: 1,
        model,
        prompt: text,
        label,
        after: (mode === 'continue' || mode === 'extend') && source ? source.id : null,
        continues: continuing && firstFrame !== null,
        sequenceId: null,
        slotKey: null,
        attempt: 1,
        delivered: false,
      });
    } catch (error) {
      // Accepted by OpenRouter but not followed here: shown without the runner's Retry, which would pay twice.
      // (A request without an answer is `outcomeUnknown`: the runner itself offers no Retry for it.)
      if (!isStop(error) && !isOutcomeUnknown(error) && billedBy(error) === 'maybe') {
        void presentError(error);
      }
      throw error;
    }
    ui.status(
      extend === 'continue'
        ? 'Sent: continuing from the last frame. The clip joins the timeline when it is ready.'
        : 'Sent. The clip joins the timeline when it is ready; you can leave the page meanwhile.',
    );
  };

  // --- sequences ------------------------------------------------------------------------------------------
  const sequenceRunner = createSequenceRunner({
    store,
    tabId,
    now: () => Date.now(),
    clip: (clipId) => clipById(clipId),
    usable: (clip) => usable(clip),
    lastFrame: (clip) => media.lastFrame(clip),
    controls: (model) => controlsOf(model),
    estimate: estimateClip,
    images: {
      count: (stepId) => sequenceForm.images(stepId)?.references().length ?? 0,
      problem: (stepId) => sequenceForm.images(stepId)?.problem() ?? null,
      dataUrls: (stepId) =>
        sequenceForm.images(stepId)?.dataUrls(IMAGE_ENCODING) ?? Promise.resolve([]),
    },
    // A step begins under the sequence's approval (no dialog of its own); a Re-run asks for itself.
    beginRun: (input, signal) =>
      ctx.beginRun(
        {
          model: input.run.model,
          title: input.title,
          prompt: '',
          // History reopens the sequence as it was started.
          settings: settingsJson({
            ...DEFAULT_SETTINGS,
            tab: 'sequence',
            format: input.run.format,
            sequence: input.run.spec,
          }),
          estimateUsd: input.estimateUsd,
          groupId: input.run.id,
          useGroupApproval: input.preApproved,
        },
        signal,
      ),
    submit: submitJob,
    claimAlive: async (slot) => {
      if (!slot.claimedBy) return false;
      if (!locks) return Date.now() - (slot.claimedAt ?? 0) < CLAIM_STALE_MS;
      return !(await lockIsFree(tabLockName(slot.claimedBy)));
    },
    starting: async (runId, key) => !(await lockIsFree(startLockName(runId, key))),
    withStartLock: async (runId, key, work) => {
      if (locks) await locks.request(startLockName(runId, key), work);
      else await work();
    },
    report: (error) => void presentError(error, { retry: () => void resumeSequence() }),
    changed: (next) => runChanged(next),
  });

  let starting = false;
  const startSequencePressed = async (): Promise<void> => {
    if (starting) return;
    starting = true;
    try {
      await startSequence();
    } catch (error) {
      if (!isStop(error)) void presentError(error, { retry: () => void startSequencePressed() });
    } finally {
      starting = false;
    }
  };

  /** Checks the step list, asks once for the whole sequence's budget, stores the run and starts its first steps. */
  const startSequence = async (): Promise<void> => {
    const model = currentModel();
    if (!model) return;
    await modelsReady;
    const blocked = modelBlocked(model);
    if (blocked) {
      ui.status(blocked);
      return;
    }
    await flushEdits();
    const stored = await store.sequence();
    /** A finished sequence this one replaces. */
    const previousId = stored?.id ?? null;
    if (isActive(stored)) {
      runChanged(stored);
      ui.status(
        'A sequence is under way (here or in another tab): resume it, or start over with New sequence.',
      );
      return;
    }
    const spec: SequenceSpec = structuredClone(settings.sequence);
    const controls = controlsOf(model);
    for (const [index, step] of spec.steps.entries()) {
      const picker = sequenceForm.images(step.id);
      const issue = picker?.problem();
      if (issue) {
        ui.status(`Step ${index + 1}: ${issue}`);
        picker?.focus();
        return;
      }
      const pictures = picker?.references().length ?? 0;
      const continues = spec.mode === 'chained' && (index > 0 || sequenceSourceId !== null);
      if (!step.prompt.trim() && !spec.style.trim() && pictures === 0 && !continues) {
        ui.status(`Step ${index + 1} needs a prompt.`);
        sequenceForm.focusStep(step.id);
        return;
      }
      const role = effectiveRole(step.imageRole, continues, controls?.lastFrame ?? true);
      if (
        role === 'last-frame' &&
        !continues &&
        pictures > 0 &&
        !LAST_FRAME_ONLY_MODELS.has(model)
      ) {
        ui.status(
          `Step ${index + 1} would end on a chosen frame without starting from one, which this model is not known to take. Use reference images, or chain it from a clip.`,
        );
        sequenceForm.focusStep(step.id);
        return;
      }
    }
    const source = spec.mode === 'chained' ? clipById(sequenceSourceId) : undefined;
    const created = createRun({
      id: crypto.randomUUID(),
      spec,
      model,
      format: settings.format,
      sourceClipId: usable(source) ? source.id : null,
      stepImages: Object.fromEntries(
        spec.steps.map((step) => [step.id, sequenceForm.images(step.id)?.references().length ?? 0]),
      ),
      now: Date.now(),
    });

    // One budget question for the whole sequence; its steps then begin under the approval, without dialogs.
    try {
      await ctx.runs.approveGroup({
        tool,
        groupId: created.id,
        label: `Video sequence: ${plural(created.slots.length, 'clip')}`,
        models: [model],
        runs: created.slots.length,
        estimateUsd: await sequenceTotal(model, spec),
        note:
          spec.capUsd === null
            ? 'No spend cap: it runs every step.'
            : `Spend cap ${formatUsd(spec.capUsd)}: it stops before a step would pass it.`,
      });
    } catch (error) {
      if (!(error instanceof RunCancelledError)) throw error;
      ui.status('Not started: nothing was sent.');
      return;
    }

    // Stored only if no other tab started one meanwhile.
    const saved = await store.transaction(async (tx) => {
      if (isActive(await tx.sequence())) return null;
      await tx.setSequence(created);
      return created;
    });
    if (!saved) {
      await ctx.runs.releaseGroup(created.id);
      runChanged(await store.sequence());
      ui.status('Another tab started a sequence meanwhile; nothing was started here.');
      return;
    }
    // The finished sequence this one replaces no longer needs its approval.
    if (previousId) void ctx.runs.releaseGroup(previousId).catch(() => undefined);
    pending = {};
    runChanged(saved);
    ui.status(`Sequence started: ${plural(saved.slots.length, 'step')}.`);
    await sequenceRunner.advance();
  };

  /** Writes this tab's edits first, so Resume and Re-run send what the user sees. */
  const resumeSequence = async (): Promise<void> => {
    await flushEdits();
    await saveSequence((current) => (current ? resume(current, Date.now()) : current));
    await sequenceRunner.advance();
  };

  const rerunSlot = async (key: string): Promise<void> => {
    await flushEdits();
    await saveSequence((current) =>
      current ? (rerun(current, key, Date.now()) ?? current) : current,
    );
    await sequenceRunner.advance();
  };

  const answerBlocker = async (fn: (current: SequenceRun) => SequenceRun): Promise<void> => {
    await flushEdits();
    await saveSequence((current) => (current?.blocker ? fn(current) : current));
    await sequenceRunner.advance();
  };

  const clearSequence = async (): Promise<void> => {
    const inFlight =
      run?.slots.filter((slot) => slot.status === 'starting' || slot.status === 'running').length ??
      0;
    const waiting = run?.slots.filter((slot) => slot.status === 'pending').length ?? 0;
    if (inFlight > 0 || waiting > 0) {
      const sure = await confirmDialog({
        title: 'Start a new sequence?',
        message: [
          inFlight > 0
            ? `${plural(inFlight, 'step')} ${inFlight === 1 ? 'is' : 'are'} still being made: ${inFlight === 1 ? 'it finishes' : 'they finish'}, ${inFlight === 1 ? 'is' : 'are'} paid for and land${inFlight === 1 ? 's' : ''} on the timeline. `
            : '',
          waiting > 0
            ? `${plural(waiting, 'step')} not sent yet ${waiting === 1 ? 'is' : 'are'} dropped. `
            : '',
          'Clips already made stay on the timeline.',
        ].join(''),
        confirmLabel: 'New sequence',
        tone: 'warning',
        testId: 'seq-clear-confirm',
      });
      if (!sure) return;
    }
    pending = {};
    const cleared = run?.id;
    await saveSequence(() => null);
    // Steps not sent yet are dropped: nothing more begins under the old approval.
    if (cleared) void ctx.runs.releaseGroup(cleared).catch(() => undefined);
    ui.status('Ready for a new sequence.');
  };

  // --- joining --------------------------------------------------------------------------------------------
  const joinClips = async (): Promise<void> => {
    if (joining) return;
    const parts = joinPlan(clips);
    if (parts.length === 0) {
      ui.status('Put at least one clip in the join.');
      return;
    }
    const missing = parts.filter((part) => !media.blob(part.id));
    if (missing.length > 0) {
      ui.status(
        `Wait until ${plural(missing.length, 'clip')} of the join ${missing.length === 1 ? 'has' : 'have'} downloaded, or leave ${missing.length === 1 ? 'it' : 'them'} out.`,
      );
      return;
    }
    const controller = new AbortController();
    joining = controller;
    render();
    timeline.focusJoin('stop');
    ui.status(`Joining ${plural(parts.length, 'clip')}…`);
    const progress = (ratio: number, label: string): void => {
      // The core download goes on after a Stop (the next join uses it): it must not write over "Join stopped."
      if (controller.signal.aborted) return;
      timeline.progress(ratio, label);
      ui.progress(label);
    };
    progress(0, 'Starting the video joiner…');
    try {
      const { concatVideos } = await import('../../core/media/ffmpeg-ops');
      const joined = await concatVideos(
        parts.map((part) => ({
          blob: media.blob(part.id)!,
          ...(part.trimStart ? { trimStart: part.trimStart } : {}),
          ...(part.trimEnd ? { trimEnd: part.trimEnd } : {}),
          ...(part.dropFirstFrame ? { dropFirstFrame: true } : {}),
        })),
        {
          signal: controller.signal,
          onLoadProgress: ({ loaded, total }) =>
            progress(
              0,
              `Loading the video joiner… ${total > 0 ? Math.round((loaded / total) * 100) : 0}%`,
            ),
          onProgress: (ratio) => progress(ratio, `Joining… ${Math.round(ratio * 100)}%`),
        },
      );
      addExport(
        joined,
        parts.map((part) => part.id),
      );
      ui.status(`Joined ${plural(parts.length, 'clip')} into one MP4.`);
    } catch (error) {
      if (isStop(error) || controller.signal.aborted) ui.status('Join stopped.');
      else void presentError(error, { retry: () => void joinClips() });
    } finally {
      const hadFocus =
        document.activeElement === document.body ||
        timeline.element.contains(document.activeElement);
      joining = null;
      render();
      if (hadFocus) timeline.focusJoin('join');
    }
  };

  let exportCount = 0;
  const addExport = (blob: Blob, clipIds: readonly string[]): void => {
    exportCount++;
    const first = clipById(clipIds[0] ?? null);
    const name = `${stemFrom(first?.prompt || first?.name || 'video')}-joined-${exportCount}.mp4`;
    // Downloading the joined video also counts its generated clips as saved.
    const clipResults = clipIds.flatMap((id) => {
      const result = media.result(id);
      return result ? [result.result.id] : [];
    });
    const card = videoResultCard({
      ui,
      blob,
      name,
      meta: [plural(clipIds.length, 'clip'), formatBytes(blob.size)],
      covers: () => clipResults,
      onRemove: () => undefined,
      // No joined video left: back to Join (it focuses the clip list when Join is unavailable).
      focusFallback: () => {
        timeline.focusJoin('join');
        return null;
      },
      headingLevel: 4,
      testId: 'video-export',
    });
    timeline.exports.prepend(card.element);
  };

  // --- runner ---------------------------------------------------------------------------------------------
  // Generate makes one clip. Ctrl/Cmd+Enter on the Sequence tab starts the sequence instead; the error toast's
  // Retry always repeats what failed (a clip), whatever tab is showing by then.
  type RunArg = 'clip';
  const runner = ui.runner<RunArg>({
    label: 'Generate',
    icon: 'camera-reels',
    container: clipForm.runnerSlot,
    replayArg: (arg) => arg ?? 'clip',
    run: async (signal, arg) => {
      if (arg === undefined && settings.tab === 'sequence') {
        await startSequencePressed();
        return;
      }
      await generateClip(signal);
    },
  });

  // --- model changes ----------------------------------------------------------------------------------------
  const syncModel = (): void => {
    const model = currentModel();
    const status = statusFor(model);
    runner.setDisabled(
      status?.status === 'missing'
        ? `${model} is not a video generator. Choose another model.`
        : null,
    );
    formChanged();
  };
  ctx.settings.subscribe(() => syncModel());
  ctx.bus.on('models-refreshed', () => {
    modelsReady = loadModels();
    void modelsReady.then(syncModel);
  });
  void modelsReady.then(syncModel);

  // --- start: the stored timeline and sequence, then jobs ---------------------------------------------------
  render();
  void (async () => {
    clips = await store.timeline();
    const stored = await store.sequence();
    if (stored && isActive(stored)) settings.sequence = structuredClone(stored.spec);
    runChanged(stored);
    media.prefetch(clips);
    for (const clip of clips) void measure(clip.id);
    formChanged();
    const all = await ctx.jobs.list({ tool });
    void countJobs();
    // Steps whose clip is already placed (the page closed between the two writes) are settled.
    if (stored) {
      const costOf = (jobId: string): number | null =>
        parseResult(all.find((job) => job.id === jobId)?.result).costUsd;
      await saveSequence((current) => (current ? repairSlots(current, clips, costOf) : current));
    }
    for (const job of all) {
      if (job.type === VIDEO_JOB && isFinalState(job.state)) void deliver(job);
    }
    await sequenceRunner.recover(all);
    await sequenceRunner.advance();
  })().catch((error: unknown) => void presentError(error));

  // --- instance -------------------------------------------------------------------------------------------
  const applySettings = (next: StudioSettings, text: string): void => {
    settings = next;
    prompt = text;
    formChanged();
  };

  return {
    getState: () => ({ prompt, settings: settingsJson(settings) }),
    applyState: ({ prompt: text, settings: saved }) => applySettings(parseSettings(saved), text),
    estimate: async (model) => {
      await modelsReady;
      if (settings.tab === 'sequence') return sequenceTotal(model, settings.sequence);
      return estimateClip(model, settings.format, clipImages(controlsOf(model)));
    },
    onFiles: (files) => takeFiles(files),
    onReceive: (items: SendItem[]) =>
      takeFiles(
        items.flatMap((item) =>
          item.kind === 'file' ? [{ blob: item.blob, name: item.name }] : [],
        ),
      ),
    sample: () => {
      applySettings(
        { ...settings, tab: 'clip', mode: 'text', format: { ...settings.format, duration: 5 } },
        'A fishing boat leaves a quiet harbor at dawn, gulls circling overhead, gentle waves catching the first light',
      );
    },
  };
}
