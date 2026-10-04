/**
 * Video studio (docs/openrouter-api.md §7): video clips from a prompt, from frames or reference images, continued
 * or extended from any clip of the session (uploads included), auto-extend sequences, a frame grabber, and a
 * timeline joined into one MP4 in the browser.
 *
 * - **Jobs:** every clip is one run and one persisted job. The run is handed off (`run.handOff`) as soon as the
 *   job is queued, so Generate is free again at once and leaving the page is safe; the job polls
 *   `GET /videos/{id}` (quick at first, then every 30 s), downloads the clip when it is done, and the tab that
 *   sees it finish re-attaches the run and books the cost from the completed status. `POST /videos` is never
 *   retried once it may have reached OpenRouter (core client rules).
 * - **Persisted state** (`ctx.state`, JSON only): the timeline and the sequence run, written under one Web Lock
 *   (store.ts), so a reload resumes polling and the sequence where it was, and two tabs never send one step twice.
 *   Videos stay in memory: after a reload, generated clips are downloaded again while OpenRouter keeps them;
 *   uploads must be added again.
 * - **Continue** captures a clip's true last frame (`captureFrame('last')`) as a PNG first frame; the new clip
 *   joins the timeline right after its source, with its repeated first frame left out of the join by default.
 *   **Extend** sends a public HTTPS link as a video reference on models that take one (uploads cannot be sent as
 *   video), else falls back to Continue.
 * - **Sequences** (sequence.ts): chained steps one at a time, each from the previous clip's last frame;
 *   independent steps up to three at once; a spend cap checked against actual costs before every step.
 * - **Leave guard:** generated clips and joined videos are session results; running jobs and a running sequence
 *   are held work.
 */
import type { RawVideoModel, VideoRequest } from '../../core/api/types';
import { InvalidInputError, userMessage } from '../../core/errors';
import { isFinalState, webLocks } from '../../core/jobs';
import { toDataUrl } from '../../core/media/image';
import { captureFrame, getVideoMetadata } from '../../core/media/video';
import type { JobRecord, RunHandle, Usage } from '../../core/types';
import { bindJobList, jobList } from '../../ui/components/job-list';
import type { ReferenceInput } from '../../ui/components/reference-picker';
import { switchField } from '../../ui/components/switch-field';
import { exportMenu } from '../../ui/components/export-menu';
import { videoPlayer } from '../../ui/components/video-player';
import { mimeMatches } from '../../ui/components/file-types';
import { h } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { confirmDialog } from '../../ui/feedback/dialogs';
import { isStop, presentError } from '../../ui/feedback/errors';
import { formatBytes, formatDuration, plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import type { SendItem, ToolContext, ToolInstance } from '../../ui/tool/types';
import { clipPanel, VIDEO_TYPES } from './clip-panel';
import { type ClipMedia, createClipMedia } from './clip-media';
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
  type ControlsResult,
  DEFAULT_SETTINGS,
  effectiveFormat,
  extendNote,
  extendPlan,
  modeProblem,
  parseSettings,
  resolutionRank,
  settingsJson,
  type StudioSettings,
  VIDEO_REFERENCE_MAX,
  type VideoControls,
} from './params';
import {
  abandonStart,
  applyStatus,
  chainSource,
  claim,
  createRun,
  isActive,
  markDone,
  markFailed,
  markRunning,
  pause,
  plan,
  releaseClaim,
  rerun,
  resume,
  type SequenceRun,
  type SequenceSpec,
  type Slot,
  slotNumber,
  startsFromFrame,
  stepPrompt,
  type StepSpec,
  stop,
} from './sequence';
import { effectiveRole, sequencePanel } from './sequence-panel';
import { createStore, SEQUENCE_KEY, TIMELINE_KEY } from './store';
import {
  clampTrim,
  insertClip,
  joinPlan,
  moveClip,
  type Placement,
  removeClip,
  slotPlacement,
  type TimelineClip,
  updateClip,
} from './timeline';
import { timelinePanel } from './timeline-panel';

/** Frames and references are scaled to this before upload (data URLs; PNG kept when it fits). */
const IMAGE_ENCODING = { maxSide: 2048, maxBytes: 4 * 1024 * 1024 };
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

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

/** Usage for a request that reached OpenRouter without a known cost: the run books its reservation. */
const unknownUsage = (model: string, latencyMs = 0): Usage => ({
  model,
  promptTokens: 0,
  completionTokens: 0,
  costUsd: 0,
  costEstimated: false,
  costUnknown: true,
  latencyMs,
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

export function setup(ctx: ToolContext): ToolInstance {
  const { ui } = ctx;
  const tool = ctx.manifest.id;
  const store = createStore(ctx.state);

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
  /** Videos a poll downloaded, until the job is delivered to the timeline. */
  const jobBlobs = new Map<string, Blob>();
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
  /** Estimates by number of images (0 to references + 2), for the sequence planner (which is synchronous). */
  const estimatesByImages = async (model: string, format: ClipFormat): Promise<(number | null)[]> =>
    Promise.all(
      Array.from({ length: VIDEO_REFERENCE_MAX + 3 }, (_, images) =>
        estimateClip(model, format, images),
      ),
    );

  // --- media ----------------------------------------------------------------------------------------------
  const media: ClipMedia = createClipMedia({
    download: (clip) => ctx.api.videos.content(clip.remoteId!, { keyId: clip.keyId! }),
    addResult: (clip, blob) => ui.addResult({ kind: 'video', name: clip.name, blob }),
    lastFrame: lastFrameDataUrl,
    onChange: (clipId) => {
      void measure(clipId);
      scheduleRender();
    },
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
  /** This page has the clip's video or can download it. */
  const obtainable = (clip: TimelineClip | undefined): boolean =>
    !!clip &&
    (media.blob(clip.id) !== undefined || (clip.source === 'generated' && !!clip.remoteId));

  // --- persisted state ------------------------------------------------------------------------------------
  const saveTimeline = async (
    fn: (list: readonly TimelineClip[]) => readonly TimelineClip[],
  ): Promise<void> => {
    clips = await store.updateTimeline(fn);
    scheduleRender();
  };
  const saveSequence = async (
    fn: (current: SequenceRun | null) => SequenceRun | null,
  ): Promise<SequenceRun | null> => {
    run = await store.updateSequence(fn);
    scheduleRender();
    return run;
  };
  /** A clip whose job this tab polled already has its video: use it instead of downloading it again. */
  const adoptJobBlobs = (): void => {
    for (const clip of clips) {
      const blob = clip.jobId ? jobBlobs.get(clip.jobId) : undefined;
      if (!blob || !clip.jobId) continue;
      jobBlobs.delete(clip.jobId);
      media.put(clip, blob);
    }
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
    adoptJobBlobs();
    media.prefetch(clips);
    for (const clip of clips) void measure(clip.id);
    scheduleRender();
  };
  const reloadSequence = async (): Promise<void> => {
    const previous = run;
    run = await store.sequence();
    if (run && run !== previous) noteFinish(previous, run);
    scheduleRender();
  };
  ctx.bus.on('tool-state-changed', (event) => {
    if (event.tool !== tool) return;
    if (event.key === TIMELINE_KEY) void reloadTimeline();
    if (event.key === SEQUENCE_KEY) void reloadSequence();
  });

  // --- notifications --------------------------------------------------------------------------------------
  const notifyAllowed = (): boolean =>
    ctx.options.get()['notify'] === true &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted';
  /** A browser notification when a sequence ends while the tab is in the background. */
  const noteFinish = (before: SequenceRun | null, after: SequenceRun): void => {
    const ended = after.status === 'done' || after.status === 'stopped';
    if (!ended || before?.id !== after.id || before.status === after.status) return;
    announce(after.message ?? 'The sequence ended.');
    if (!notifyAllowed() || document.visibilityState !== 'hidden') return;
    try {
      new Notification(
        `${ctx.manifest.name}: sequence ${after.status === 'done' ? 'finished' : 'stopped'}`,
        {
          body: after.message ?? '',
          tag: `ortoolbox-sequence-${after.id}`,
        },
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
    onUploads: (files) => void addUploads(files),
    onImages: () => formChanged(),
  });

  const format = formatFields({
    onChange: (patch) => {
      settings.format = { ...settings.format, ...patch };
      formChanged();
    },
  });

  // Edits of an active run's prompts, style, cap and failure rule reach the stored run (debounced for typing).
  let specWrite: ReturnType<typeof setTimeout> | null = null;
  const forwardSpec = (): void => {
    if (!isActive(run)) return;
    if (specWrite) clearTimeout(specWrite);
    specWrite = setTimeout(() => {
      specWrite = null;
      const edited = settings.sequence;
      void saveSequence((current) => {
        if (!isActive(current)) return current;
        const steps = current.spec.steps.map((step) => {
          const live = edited.steps.find((candidate) => candidate.id === step.id);
          return live ? { ...step, prompt: live.prompt, imageRole: live.imageRole } : step;
        });
        return {
          ...current,
          spec: {
            ...current.spec,
            style: edited.style,
            capUsd: edited.capUsd,
            onFailure: edited.onFailure,
            steps,
          },
          updatedAt: Date.now(),
        };
      }).then(() => advance());
    }, 400);
  };

  let stepCounter = 0;
  const sequenceForm = sequencePanel({
    ui,
    onSpec: (patch) => {
      settings.sequence = { ...settings.sequence, ...patch };
      forwardSpec();
      formChanged();
    },
    onSteps: (steps: StepSpec[]) => {
      settings.sequence = { ...settings.sequence, steps };
      forwardSpec();
      formChanged();
    },
    onSource: (clipId) => {
      sequenceSourceId = clipId;
      formChanged();
    },
    onImages: () => formChanged(),
    newStepId: () => {
      const taken = new Set(settings.sequence.steps.map((step) => step.id));
      let id: string;
      do id = `step-${Date.now().toString(36)}-${++stepCounter}`;
      while (taken.has(id));
      return id;
    },
    start: () => void startSequencePressed(),
    pause: () => void saveSequence((current) => (current ? pause(current, Date.now()) : current)),
    resume: () => void resumeSequence(),
    stop: () => void saveSequence((current) => (current ? stop(current, Date.now()) : current)),
    clear: () => void clearSequence(),
    rerun: (key) => void rerunSlot(key),
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
    emptyText: 'Clips being generated appear here; they keep going if you leave the page.',
    testId: 'video-jobs',
  });
  bindJobList(ctx.jobs, jobs, { tool });
  const clearJobs = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-outline-secondary',
      'data-testid': 'video-jobs-clear',
      onclick: () => void clearFinishedJobs(),
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
    move: (clipId, delta) => void moveTimelineClip(clipId, delta),
    trim: (clipId, trimStart, trimEnd) => {
      const clip = clipById(clipId);
      if (!clip) return;
      const value = clampTrim(clip.duration, trimStart, trimEnd);
      clips = updateClip(clips, clipId, value);
      scheduleRender();
      void saveTimeline((list) => updateClip(list, clipId, value));
    },
    setIncluded: (clipId, included) => {
      clips = updateClip(clips, clipId, { included });
      scheduleRender();
      void saveTimeline((list) => updateClip(list, clipId, { included }));
    },
    setDropFirstFrame: (clipId, dropFirstFrame) => {
      clips = updateClip(clips, clipId, { dropFirstFrame });
      scheduleRender();
      void saveTimeline((list) => updateClip(list, clipId, { dropFirstFrame }));
    },
    continueFrom: (clipId) => useSource(clipId, 'continue'),
    extend: (clipId) => useSource(clipId, 'extend'),
    frames: (clipId) => {
      const clip = clipById(clipId);
      const blob = clip && media.blob(clip.id);
      if (clip && blob) grabber.open(clip, blob);
    },
    remove: (clipId) => void removeTimelineClip(clipId),
    retry: (clipId) => {
      const clip = clipById(clipId);
      if (!clip) return;
      media.retry(clipId);
      void media.ensure(clip).catch((error: unknown) => {
        void presentError(error, { retry: () => timeline.focusList() });
      });
    },
    join: () => void joinClips(),
    stopJoin: () => joining?.abort(),
  });

  const grabber = frameGrabber({
    ui,
    capture: (blob, time) => captureFrame(blob, time),
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
      if (number > 0) parts.push(`Sequence step ${number}`);
    } else if (clip.slotKey) parts.push('Sequence');
    if (clip.continues) parts.push('Continues the clip before');
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
      source: obtainable(source),
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
    clipForm.render({
      mode: settings.mode,
      prompt,
      extendUrl: settings.extendUrl,
      sourceId: clipSourceId,
      clips,
      notes,
      problem,
    });

    // The sequence form.
    const runModelControls = isActive(run) ? controlsOf(run.model) : controls;
    sequenceForm.render({
      spec: settings.sequence,
      run,
      clips,
      sourceId: sequenceSourceId,
      lastFrame: runModelControls ? runModelControls.lastFrame : true,
      perStep: sequenceEstimate.perStep,
      total: sequenceEstimate.total,
      blocked:
        model === null
          ? 'No model is available in free-only mode.'
          : status?.status === 'missing'
            ? `${model} is not a video generator. Choose another model.`
            : null,
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
    const total = model ? await sequenceTotal(model) : null;
    if (mine !== estimateGeneration) return;
    const count = settings.sequence.steps.length * settings.sequence.repeat;
    sequenceEstimate = { total, perStep: total === null ? null : total / Math.max(1, count) };
    scheduleRender();
  };

  /** Images a slot's request carries (its first frame and its step's images). */
  const slotImages = (
    sequence: Pick<SequenceRun, 'spec' | 'sourceClipId' | 'slots'>,
    slot: Slot,
    lastFrame: boolean,
  ): number => {
    const index = sequence.slots.findIndex((candidate) => candidate.key === slot.key);
    const fromFrame = startsFromFrame(sequence, index);
    const step = sequence.spec.steps.find((candidate) => candidate.id === slot.stepId);
    const role = step ? effectiveRole(step.imageRole, fromFrame, lastFrame) : null;
    const pictures = (step && sequenceForm.images(step.id)?.references().length) ?? 0;
    const extra =
      role === 'last-frame'
        ? Math.min(1, pictures)
        : role === 'references'
          ? Math.min(VIDEO_REFERENCE_MAX, pictures)
          : 0;
    return (fromFrame ? 1 : 0) + extra;
  };

  /** The whole sequence as the form stands, on `model`. */
  const sequenceTotal = async (model: string): Promise<number | null> => {
    const preview = createRun({
      id: 'preview',
      spec: settings.sequence,
      model,
      format: settings.format,
      sourceClipId: settings.sequence.mode === 'chained' ? sequenceSourceId : null,
      now: 0,
    });
    const byImages = await estimatesByImages(model, settings.format);
    const lastFrame = controlsOf(model)?.lastFrame ?? true;
    let total = 0;
    for (const slot of preview.slots) {
      const estimate = byImages[slotImages(preview, slot, lastFrame)] ?? null;
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
        createdAt: Date.now(),
      };
      media.put(clip, blob);
      await saveTimeline((list) => insertClip(list, clip, 'end'));
      clipSourceId = clip.id;
      if (settings.mode !== 'continue' && settings.mode !== 'extend') settings.mode = 'continue';
      ui.status(`Added ${name} to the timeline: it is the clip to continue.`);
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
      } else {
        settings.mode = 'first';
        clipForm.first.add(named.slice(0, 1));
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
    announce(`Moved to position ${index + 1} of ${clips.length}.`);
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
    const target = next
      ? timeline.element.querySelector<HTMLElement>(
          `[data-clip-id="${CSS.escape(next.id)}"] [data-testid="video-clip-remove"]`,
        )
      : null;
    if (target) target.focus();
    else timeline.focusList();
    await saveTimeline((list) => removeClip(list, clipId));
  };

  // --- jobs -----------------------------------------------------------------------------------------------
  ctx.jobs.register<VideoJobPayload, VideoJobResult>(VIDEO_JOB, {
    intervalMs: (job) => pollInterval(Date.now() - job.createdAt),
    poll: async (job, signal) => {
      if (!job.remoteId) return { state: 'failed', error: 'The job has no OpenRouter id.' };
      const status = await ctx.api.videos.status(job.remoteId, { keyId: job.keyId, signal });
      if (!status.done) return { state: 'running', progress: null, remoteStatus: 'Generating' };
      if (status.status === 'completed') {
        // The clip is fetched with the result, so a completed job always has its video in this tab.
        const blob = await ctx.api.videos.content(job.remoteId, { keyId: job.keyId, signal });
        jobBlobs.set(job.id, blob);
        return { state: 'succeeded', result: { costUsd: status.costUsd, outputs: status.outputs } };
      }
      return {
        state: 'failed',
        error: status.error ?? `The video job ended as ${status.status}.`,
      };
    },
  });

  /** Ends a job's run: books the completed status's cost, or fails it with the job's reason. */
  const settleRun = async (job: JobRecord, payload: VideoJobPayload): Promise<void> => {
    if (!job.runId) return;
    const handle = await ctx.runs.reattach(job.runId).catch(() => null);
    if (!handle) return; // already final (another tab, or the page-start sweep)
    const latencyMs = Math.max(0, job.updatedAt - job.createdAt);
    if (job.state === 'succeeded') {
      const { costUsd } = parseResult(job.result);
      handle.addUsage({
        ...unknownUsage(handle.model, latencyMs),
        costUsd: costUsd ?? 0,
        costUnknown: costUsd === null,
      });
      await handle.finish({
        output: `Video clip ready: ${payload.label}.`,
        meta: { videoJobIds: [job.remoteId] },
      });
      return;
    }
    if (job.state === 'cancelled') handle.addUsage(unknownUsage(handle.model, latencyMs));
    await handle.fail(
      new Error(
        job.state === 'cancelled'
          ? 'Stopped waiting for the video job (OpenRouter may still finish and bill it).'
          : (job.error ?? 'The video job failed.'),
      ),
    );
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
          await saveSequence((current) =>
            current?.id === payload.sequenceId
              ? markFailed(current, key, { jobId: job.id, error }, Date.now())
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
    } finally {
      delivering.delete(job.id);
      void advance();
    }
  };

  const placeClip = async (job: JobRecord, payload: VideoJobPayload): Promise<void> => {
    const { costUsd } = parseResult(job.result);
    const stem = stemFrom(payload.prompt);
    const draft: TimelineClip = {
      id: uid('clip'),
      name: `${stem}-${(job.remoteId ?? job.id).slice(-6)}.mp4`,
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
      createdAt: Date.now(),
    };
    const placed = await store.transaction(async (tx) => {
      let list = await tx.timeline();
      const existing = list.find((clip) => clip.jobId === job.id);
      if (existing) return existing;
      const sequence = await tx.sequence();
      let placement: Placement = 'end';
      let replaced: string | null = null;
      const inSequence =
        sequence !== null && payload.sequenceId === sequence.id && payload.slotKey !== null;
      if (inSequence && payload.slotKey) {
        const slot = sequence.slots.find((candidate) => candidate.key === payload.slotKey);
        if (slot?.clipId && list.some((clip) => clip.id === slot.clipId)) {
          // A re-run: the new take goes where the old one was, which stays on the timeline left out.
          placement = { before: slot.clipId };
          replaced = slot.clipId;
        } else {
          placement = slotPlacement(
            list,
            sequence.slots.map((candidate) => candidate.key),
            sequence.id,
            payload.slotKey,
          );
        }
      } else if (payload.after && list.some((clip) => clip.id === payload.after)) {
        placement = { after: payload.after };
      }
      list = insertClip(list, draft, placement);
      if (replaced) list = updateClip(list, replaced, { included: false });
      await tx.setTimeline(list);
      if (inSequence && payload.slotKey) {
        const next = markDone(
          sequence,
          payload.slotKey,
          { jobId: job.id, clipId: draft.id, costUsd },
          Date.now(),
        );
        if (next !== sequence) await tx.setSequence(next);
      }
      return draft;
    });
    clips = await store.timeline();
    const previous = run;
    run = await store.sequence();
    if (run && run !== previous) noteFinish(previous, run);
    adoptJobBlobs();
    const stored = clipById(placed.id) ?? placed;
    if (!media.blob(stored.id)) void media.ensure(stored).catch(() => undefined); // shown on the clip, with Try again
    if (!payload.sequenceId) ui.status(`Clip ready: ${placed.name}.`);
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
   * have reached OpenRouter is never sent again: if anything after it fails, the run books its reservation.
   */
  const submitJob = async (
    handle: RunHandle,
    body: VideoRequest,
    payload: VideoJobPayload,
  ): Promise<JobRecord> => {
    let submitted = false;
    try {
      const status = await ctx.api.videos.submit(body, { run: handle });
      submitted = true;
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
      });
      handle.handOff(job.id);
      return job;
    } catch (error) {
      if (submitted) handle.addUsage(unknownUsage(handle.model));
      await handle.fail(error);
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
      clipForm.element.querySelector<HTMLElement>('[data-testid="video-source"]')?.focus();
    } else clipForm.prompt.focus();
  };

  const generateClip = async (signal: AbortSignal): Promise<void> => {
    const model = currentModel();
    if (!model) return;
    await modelsReady;
    const status = statusFor(model);
    if (status?.status === 'missing') {
      ui.status(`${model} is not a video generator. Choose another model.`);
      return;
    }
    const controls = status?.status === 'ready' ? status.controls : null;
    const mode = settings.mode;
    const inputs = modeInputs();
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
      mode === 'extend' ? extendPlan(controls, settings.extendUrl, inputs.sourceJob) : null;
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
    const text = prompt.trim() || (mode === 'continue' || mode === 'extend' ? CONTINUE_PROMPT : '');
    const built = buildVideoRequest({
      model,
      prompt: text,
      format: settings.format,
      controls,
      firstFrame,
      lastFrame,
      references,
      videoUrl: extend === 'native' ? settings.extendUrl.trim() : null,
      previousJobId: extend === 'previous-job' ? (source?.remoteId ?? null) : null,
    });
    const estimateUsd = await estimateClip(model, settings.format, built.images);

    // Refused before anything was sent (no key, locked, free-only, budget, Cancel): nothing changes.
    const handle = await ctx.beginRun(
      { title: shorten(text || 'Video clip', 80), estimateUsd },
      signal,
    );
    ui.status('Sending the request…');
    const sourceIndex = source ? clips.findIndex((clip) => clip.id === source.id) : -1;
    const label =
      mode === 'continue' || mode === 'extend'
        ? `${mode === 'continue' ? 'Continue' : 'Extend'} clip ${sourceIndex + 1}${prompt.trim() ? `: ${shorten(prompt.trim(), 50)}` : ''}`
        : shorten(text, 70);
    await submitJob(handle, built.body, {
      v: 1,
      model,
      prompt: text,
      label,
      after: (mode === 'continue' || mode === 'extend') && source ? source.id : null,
      continues: continuing && firstFrame !== null,
      sequenceId: null,
      slotKey: null,
      delivered: false,
    });
    ui.status(
      extend === 'continue'
        ? 'Sent: continuing from the last frame. The clip joins the timeline when it is ready.'
        : 'Sent. The clip joins the timeline when it is ready; you can leave the page meanwhile.',
    );
  };

  // --- sequences ------------------------------------------------------------------------------------------
  type RunArg = 'sequence';

  const startSequencePressed = async (): Promise<void> => {
    const started = runner.trigger('sequence');
    if (!started.started) {
      ui.status(
        runner.disabledReason ??
          'Wait until the clip being sent is on its way, then start the sequence.',
      );
    }
    await started;
  };

  /** Checks the step list, stores a new run and starts its first steps. */
  const startSequence = async (signal: AbortSignal): Promise<void> => {
    const model = currentModel();
    if (!model) return;
    await modelsReady;
    const status = statusFor(model);
    if (status?.status === 'missing') {
      ui.status(`${model} is not a video generator. Choose another model.`);
      return;
    }
    if (isActive(run) && run.status !== 'done') {
      ui.status(
        'A sequence is already under way: resume it, or start a new one with New sequence.',
      );
      return;
    }
    const spec: SequenceSpec = structuredClone(settings.sequence);
    for (const [index, step] of spec.steps.entries()) {
      const picker = sequenceForm.images(step.id);
      const issue = picker?.problem();
      if (issue) {
        ui.status(`Step ${index + 1}: ${issue}`);
        picker?.focus();
        return;
      }
      const hasImages = (picker?.references().length ?? 0) > 0;
      const continues = startsFromFrame({ spec, sourceClipId: sequenceSourceId }, index);
      if (!step.prompt.trim() && !spec.style.trim() && !hasImages && !continues) {
        ui.status(`Step ${index + 1} needs a prompt.`);
        sequenceForm.element
          .querySelectorAll<HTMLElement>('[data-testid="seq-step-prompt"]')
          [index]?.focus();
        return;
      }
    }
    if (signal.aborted) return;
    const source = spec.mode === 'chained' ? clipById(sequenceSourceId) : undefined;
    const created = createRun({
      id: crypto.randomUUID(),
      spec,
      model,
      format: settings.format,
      sourceClipId: source && obtainable(source) ? source.id : null,
      stepImages: Object.fromEntries(
        spec.steps.map((step) => [step.id, sequenceForm.images(step.id)?.references().length ?? 0]),
      ),
      now: Date.now(),
    });
    await saveSequence(() => created);
    ui.status(`Sequence started: ${plural(created.slots.length, 'step')}.`);
    await advance();
  };

  /**
   * Starts whatever the plan allows (sequence.ts `plan`): claims the slots under the store's lock, then starts
   * each. Called after every change that may let a step start (a step finished, Resume, Re-run, page load).
   */
  let advancing: Promise<void> | null = null;
  let advanceAgain = false;
  function advance(): Promise<void> {
    if (advancing) {
      advanceAgain = true;
      return advancing;
    }
    advancing = (async () => {
      try {
        do {
          advanceAgain = false;
          await advanceOnce();
        } while (advanceAgain);
      } catch (error) {
        console.error(error);
      } finally {
        advancing = null;
      }
    })();
    return advancing;
  }

  const advanceOnce = async (): Promise<void> => {
    const stored = await store.sequence();
    if (!stored || stored.status === 'done') return;
    const byImages = await estimatesByImages(stored.model, stored.format);
    await modelsReady;
    const lastFrame = controlsOf(stored.model)?.lastFrame ?? true;
    const before = run;
    const claimed: string[] = [];
    let after: SequenceRun | null = null;
    await store.transaction(async (tx) => {
      const current = await tx.sequence();
      if (!current || current.id !== stored.id) return;
      const estimateOf = (slot: Slot): number | null =>
        byImages[slotImages(current, slot, lastFrame)] ?? null;
      const next = plan(current, estimateOf);
      let updated = applyStatus(current, next, Date.now());
      for (const key of next.start) {
        const slot = updated.slots.find((candidate) => candidate.key === key);
        const claimedRun = slot ? claim(updated, key, estimateOf(slot), Date.now()) : null;
        if (claimedRun) {
          updated = claimedRun;
          claimed.push(key);
        }
      }
      if (updated !== current) await tx.setSequence(updated);
      after = updated;
    });
    if (after) {
      run = after;
      noteFinish(before, after);
      scheduleRender();
    }
    for (const key of claimed) void startSlot(stored.id, key);
  };

  /** Starts one claimed slot: its first frame, its images, its run, its request and its job. */
  const startSlot = async (runId: string, key: string): Promise<void> => {
    const work = async (): Promise<void> => {
      const current = await store.sequence();
      const slot = current?.slots.find((candidate) => candidate.key === key);
      if (!current || current.id !== runId || slot?.status !== 'starting') return;
      const number = slotNumber(current, key);
      const index = number - 1;
      const step = current.spec.steps.find((candidate) => candidate.id === slot.stepId);
      let handle: RunHandle;
      let body: VideoRequest;
      let continues: boolean;
      try {
        if (!step) throw new InvalidInputError(`Step ${number} is no longer in the list.`);
        await modelsReady;
        const controls = controlsOf(current.model);
        const fromFrame = startsFromFrame(current, index);
        const sourceId = fromFrame
          ? chainSource(current, key, (id) => obtainable(clipById(id)))
          : null;
        const sourceClip = clipById(sourceId);
        const firstFrame = sourceClip ? await media.lastFrame(sourceClip) : null;
        continues = firstFrame !== null;
        const role = effectiveRole(
          step.imageRole,
          firstFrame !== null,
          controls?.lastFrame ?? true,
        );
        const picker = sequenceForm.images(step.id);
        const issue = role ? picker?.problem() : null;
        if (issue) throw new InvalidInputError(`Step ${number}: ${issue}`);
        if (
          role &&
          (current.stepImages[step.id] ?? 0) > 0 &&
          (picker?.references().length ?? 0) === 0
        ) {
          throw new InvalidInputError(
            `Step ${number}'s images were not kept after the reload (pictures stay in memory only). Add them again, then Resume`,
          );
        }
        const pictures = role && picker ? await picker.dataUrls(IMAGE_ENCODING) : [];
        const text = stepPrompt(current.spec, step.prompt) || (firstFrame ? CONTINUE_PROMPT : '');
        const built = buildVideoRequest({
          model: current.model,
          prompt: text,
          format: current.format,
          controls,
          firstFrame,
          lastFrame: role === 'last-frame' ? (pictures[0] ?? null) : null,
          references: role === 'references' ? pictures : [],
        });
        if (!built.body.prompt && !built.body.frame_images && !built.body.input_references) {
          throw new InvalidInputError(`Step ${number} needs a prompt.`);
        }
        body = built.body;
        const estimateUsd = await estimateClip(current.model, current.format, built.images);
        handle = await ctx.beginRun({
          model: current.model,
          title: `Sequence step ${number}: ${shorten(step.prompt.trim() || text, 60)}`,
          prompt: '',
          // History reopens the sequence as it was started.
          settings: settingsJson({
            ...DEFAULT_SETTINGS,
            tab: 'sequence',
            format: current.format,
            sequence: current.spec,
          }),
          estimateUsd,
          groupId: current.id,
        });
      } catch (error) {
        // Nothing was sent: the step waits, and the sequence pauses with the reason.
        const reason = isStop(error)
          ? 'Paused: the budget confirmation was declined.'
          : `Paused before step ${number}: ${userMessage(error).replace(/\.$/, '')}.`;
        await saveSequence((latest) =>
          latest?.id === runId ? releaseClaim(latest, key, reason, Date.now()) : latest,
        );
        if (!isStop(error)) void presentError(error, { retry: () => void resumeSequence() });
        return;
      }
      try {
        const job = await submitJob(handle, body, {
          v: 1,
          model: current.model,
          prompt: body.prompt ?? '',
          label: `Sequence step ${number}${step.prompt.trim() ? `: ${shorten(step.prompt.trim(), 50)}` : ''}`,
          after: null,
          continues,
          sequenceId: runId,
          slotKey: key,
          delivered: false,
        });
        await saveSequence((latest) =>
          latest?.id === runId
            ? markRunning(latest, key, { jobId: job.id, runId: handle.id }, Date.now())
            : latest,
        );
      } catch (error) {
        await saveSequence((latest) =>
          latest?.id === runId
            ? markFailed(latest, key, { jobId: null, error: userMessage(error) }, Date.now())
            : latest,
        );
        void presentError(error);
      }
    };
    const locks = webLocks();
    try {
      if (locks) await locks.request(startLockName(runId, key), work);
      else await work();
    } catch (error) {
      console.error(error);
    }
    void advance();
  };

  const resumeSequence = async (): Promise<void> => {
    await saveSequence((current) => (current ? resume(current, Date.now()) : current));
    await advance();
  };

  const rerunSlot = async (key: string): Promise<void> => {
    await saveSequence((current) =>
      current ? (rerun(current, key, Date.now()) ?? current) : current,
    );
    await advance();
  };

  const clearSequence = async (): Promise<void> => {
    if (run && run.slots.some((slot) => slot.status === 'pending')) {
      const sure = await confirmDialog({
        title: 'Start a new sequence?',
        message: 'The steps not sent yet are dropped. Clips already made stay on the timeline.',
        confirmLabel: 'New sequence',
        tone: 'warning',
        testId: 'seq-clear-confirm',
      });
      if (!sure) return;
    }
    await saveSequence(() => null);
    ui.status('Ready for a new sequence.');
  };

  /** After a reload: slots left `starting` by a closed page adopt their job, or fail and pause the sequence. */
  const recoverStarts = async (all: readonly JobRecord[]): Promise<void> => {
    const stored = await store.sequence();
    if (!stored) return;
    for (const slot of stored.slots) {
      if (slot.status !== 'starting' || !(await lockIsFree(startLockName(stored.id, slot.key))))
        continue;
      const job = all.find((candidate) => {
        const payload = parsePayload(candidate.payload);
        return (
          payload?.sequenceId === stored.id &&
          payload.slotKey === slot.key &&
          !payload.delivered &&
          !isFinalState(candidate.state)
        );
      });
      await saveSequence((current) => {
        if (current?.id !== stored.id) return current;
        return job?.runId
          ? markRunning(current, slot.key, { jobId: job.id, runId: job.runId }, Date.now())
          : abandonStart(current, slot.key, Date.now());
      });
    }
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
      joining = null;
      render();
    }
  };

  let exportCount = 0;
  const addExport = (blob: Blob, clipIds: readonly string[]): void => {
    exportCount++;
    const first = clipById(clipIds[0] ?? null);
    const name = `${stemFrom(first?.prompt || first?.name || 'video')}-joined-${exportCount}.mp4`;
    const handle = ui.addResult({ kind: 'video', name, blob });
    const player = videoPlayer({ blob, label: name, testId: 'video-export-player' });
    // Downloading the joined video also counts its generated clips as saved.
    const clipResults = clipIds.flatMap((id) => {
      const result = media.result(id);
      return result ? [result.result.id] : [];
    });
    const menu = exportMenu({
      filename: name.replace(/\.mp4$/, ''),
      formats: [{ label: 'MP4', extension: 'mp4', icon: 'file-earmark-play', build: () => blob }],
      resultIds: () => [handle.result.id, ...clipResults],
      testId: 'video-export-download',
    });
    const card = h(
      'article',
      { class: 'card', 'data-testid': 'video-export' },
      h(
        'div',
        { class: 'card-body d-flex flex-column gap-2' },
        h(
          'div',
          { class: 'd-flex flex-wrap align-items-baseline gap-2' },
          h('h4', { class: 'h6 mb-0 me-auto text-break' }, name),
          h(
            'span',
            { class: 'small text-body-secondary', 'data-testid': 'video-export-meta' },
            `${plural(clipIds.length, 'clip')} · ${formatBytes(blob.size)}`,
          ),
        ),
        player.element,
        h(
          'div',
          { class: 'd-flex flex-wrap gap-2' },
          menu,
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
              'data-testid': 'video-export-send',
              onclick: () => ui.sendTo([{ kind: 'file', blob, name }]),
            },
            icon('send'),
            'Send to…',
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-sm btn-outline-danger d-inline-flex align-items-center gap-1 ms-auto',
              'aria-label': `Remove ${name}`,
              'data-testid': 'video-export-remove',
              onclick: async () => {
                if (!handle.result.downloaded) {
                  const sure = await confirmDialog({
                    title: 'Remove the joined video?',
                    message: `${name} was not downloaded. You can join the clips again.`,
                    confirmLabel: 'Remove',
                    tone: 'danger',
                  });
                  if (!sure) return;
                }
                player.dispose();
                handle.remove();
                card.remove();
                announce(`Removed ${name}.`);
                timeline.focusList();
              },
            },
            icon('trash'),
            'Remove',
          ),
        ),
      ),
    );
    timeline.exports.prepend(card);
    void getVideoMetadata(blob)
      .then(({ duration }) => {
        const meta = card.querySelector('[data-testid="video-export-meta"]');
        if (meta && duration > 0) {
          meta.textContent = `${plural(clipIds.length, 'clip')} · ${formatDuration(duration)} · ${formatBytes(blob.size)}`;
        }
      })
      .catch(() => undefined);
  };

  // --- runner ---------------------------------------------------------------------------------------------
  const runner = ui.runner<RunArg>({
    label: 'Generate',
    icon: 'camera-reels',
    container: clipForm.runnerSlot,
    run: (signal, arg) =>
      arg === 'sequence' || settings.tab === 'sequence'
        ? startSequence(signal)
        : generateClip(signal),
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
    run = await store.sequence();
    if (isActive(run)) settings.sequence = structuredClone(run.spec);
    media.prefetch(clips);
    for (const clip of clips) void measure(clip.id);
    formChanged();
    const all = await ctx.jobs.list({ tool });
    void countJobs();
    for (const job of all) {
      if (job.type === VIDEO_JOB && isFinalState(job.state)) void deliver(job);
    }
    await recoverStarts(all);
    await advance();
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
      if (settings.tab === 'sequence') return sequenceTotal(model);
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
        'A fishing boat leaves a quiet harbour at dawn, gulls circling overhead, gentle waves catching the first light',
      );
    },
  };
}
