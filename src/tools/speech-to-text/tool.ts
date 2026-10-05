/**
 * Speech-to-text: a recording made here, or an audio or video file, to an editable, timed transcript.
 *
 * - Input: microphone recording (recorder.ts) or a file by drop, paste, "Choose a file" or Send to (source.ts
 *   inspects it: kind, duration, size; the header estimates the cost from the duration).
 * - A run: short audio goes as it is in one request; anything longer is decoded to 16 kHz mono and cut at pauses
 *   into parts of at most the chosen length (Advanced), sent two at a time through `runItems`. Each part's
 *   timestamps are moved by its offset and merged into one timeline as parts arrive (transcript.ts); a part that
 *   fails shows on its own and can be retried alone (a new run, booking only that part); Stop ends the rest.
 * - Speaker labels only for models with a known provider-option route (model-support.ts); labels restart per
 *   part, and the editor says so. Vocabulary goes out as `keyterms` only to models known to take it.
 * - Output: the editor (editor.ts) with Copy, TXT/SRT/VTT/JSON/Word downloads and Send to. One run per press;
 *   History keeps the transcript text (checkpointed as parts finish). Recordings stay in memory as session
 *   results (the leave guard asks before they are lost).
 */
import type { TranscriptionResult } from '../../core/api/types';
import { NetworkError, userMessage } from '../../core/errors';
import { toSrt, toVtt } from '../../core/export/subtitles';
import { toJsonBlob } from '../../core/export/table';
import { formatBytes, formatDuration } from '../../core/files';
import { copyWithToast } from '../../ui/clipboard';
import { type AudioPlayer, audioPlayer } from '../../ui/components/audio-player';
import { dropZone } from '../../ui/components/drop-zone';
import { type ExportFormat, exportMenu } from '../../ui/components/export-menu';
import { progressBar } from '../../ui/components/progress-bar';
import { focusedKey, focusKey, h, replace, replaceWith } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { confirmDialog } from '../../ui/feedback/dialogs';
import { isStop, presentError } from '../../ui/feedback/errors';
import { plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import { motionReduced } from '../../ui/shell/appearance';
import { batchSummary, type ItemStatus, runItems } from '../../ui/tool/batch';
import { type RetryGate, retryGate } from '../../ui/tool/retry-gate';
import type {
  ResultHandle,
  RunnerState,
  SendItem,
  ToolContext,
  ToolInstance,
  ToolSnapshot,
} from '../../ui/tool/index';
import { transcriptEditor } from './editor';
import { parseKeyterms, partSeconds, partsUnfitFor, sttSupport } from './model-support';
import { recorder } from './recorder';
import sampleUrl from './sample-speech.mp3';
import {
  type AudioPart,
  type AudioSource,
  expectedParts,
  inspectSource,
  prepareParts,
  sentAsIs,
} from './source';
import {
  EMPTY_TRANSCRIPT,
  mergeParts,
  mixedModelsNote,
  modelsUsed,
  type PartMeta,
  subtitleSegments,
  transcriptJson,
  transcriptMarkdown,
} from './transcript';

interface PartState extends AudioPart {
  status: ItemStatus;
  error: string | null;
  result: TranscriptionResult | null;
  /** How it was transcribed (set when done): a retry may use another model or other options. */
  meta: PartMeta | null;
}

export const PART_MINUTES = [1, 2, 5, 8] as const;
const DEFAULT_PART_MINUTES = 5;
/** Parts in flight at once: each carries megabytes of audio. */
const CONCURRENCY = 2;
/** The longest recording the recorder keeps going for. */
const MAX_RECORDING_SECONDS = 2 * 60 * 60;
/** Languages offered besides auto-detection (ISO-639-1, as the API takes them). */
const LANGUAGES = [
  'ar', 'bg', 'bn', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fa', 'fi', 'fr', 'he', 'hi', 'hr', 'hu',
  'id', 'it', 'ja', 'ko', 'lt', 'lv', 'ms', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sr', 'sv', 'sw',
  'ta', 'th', 'tl', 'tr', 'uk', 'ur', 'vi', 'zh',
]; // prettier-ignore

const STATUS_TEXT: Record<ItemStatus, string> = {
  queued: 'Waiting',
  running: 'Transcribing…',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Not transcribed',
};
const STATUS_BADGE: Record<ItemStatus, string> = {
  queued: 'text-bg-secondary',
  running: 'text-bg-info',
  done: 'text-bg-success',
  failed: 'text-bg-danger',
  stopped: 'text-bg-secondary',
};

const isPartMinutes = (value: unknown): value is (typeof PART_MINUTES)[number] =>
  PART_MINUTES.includes(value as (typeof PART_MINUTES)[number]);

function languageLabel(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** `recording-2026-10-03-1530` in local time. */
function recordingName(extension: string, now = new Date()): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return `recording-${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}.${extension}`;
}

export function setup(ctx: ToolContext): ToolInstance {
  const { ui } = ctx;
  const saved = ctx.options.get();
  const ids = {
    vocabulary: uid('stt-vocabulary'),
    vocabularyNote: uid('stt-vocabulary-note'),
    language: uid('stt-language'),
    partMinutes: uid('stt-part-minutes'),
    partNote: uid('stt-part-note'),
  };

  let source: AudioSource | null = null;
  let recording: ResultHandle | null = null;
  let player: AudioPlayer | null = null;
  /** The cut parts of the current source, kept for a retry and for a second run with the same cut. */
  let prepared: {
    sourceId: string;
    seconds: number;
    pcmWavOnly: boolean;
    parts: AudioPart[];
  } | null = null;
  let parts: PartState[] = [];
  /** Which source the transcript on screen belongs to (the models are per part). */
  let transcriptOf: {
    sourceId: string;
    name: string;
    duration: number | null;
  } | null = null;
  /** True while a run transcribes (the runner's own flag is still set while its `run` returns). */
  let transcribing = false;
  let runnerState: RunnerState = { busy: false, disabledReason: null };

  // --- drawer -----------------------------------------------------------------------------------------------
  const language = h(
    'select',
    {
      id: ids.language,
      class: 'form-select',
      'data-testid': 'stt-language',
      onchange: () => ctx.options.set({ language: language.value }),
    },
    h('option', { value: '' }, 'Detect automatically'),
    LANGUAGES.map((code) => ({ code, label: languageLabel(code) }))
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(({ code, label }) => h('option', { value: code }, label)),
  );
  language.value =
    typeof saved['language'] === 'string' && LANGUAGES.includes(saved['language'])
      ? saved['language']
      : '';

  /**
   * A switch whose choice is kept even while the model cannot honour it: it then shows off and disabled, with
   * the reason, and comes back on with a model that can (`wanted` is what the state and options keep).
   */
  interface Choice {
    element: HTMLElement;
    input: HTMLInputElement;
    note: HTMLElement;
    wanted: boolean;
    show(supported: boolean): void;
  }
  const choice = (testId: string, label: string, wanted: boolean, key: string): Choice => {
    const id = uid('stt-switch');
    const noteId = uid('stt-switch-note');
    const input = h('input', {
      id,
      type: 'checkbox',
      role: 'switch',
      class: 'form-check-input',
      checked: wanted,
      'aria-describedby': noteId,
      'data-testid': testId,
      onchange: () => {
        result.wanted = input.checked;
        ctx.options.set({ [key]: input.checked });
      },
    });
    const note = h('div', { id: noteId, class: 'form-text mt-1', 'data-testid': `${testId}-note` });
    const result: Choice = {
      element: h(
        'div',
        { class: 'form-check form-switch' },
        input,
        h('label', { class: 'form-check-label fw-semibold', htmlFor: id }, label),
        note,
      ),
      input,
      note,
      wanted,
      show(supported) {
        input.disabled = !supported;
        input.checked = supported && result.wanted;
      },
    };
    return result;
  };
  const timestamps = choice(
    'stt-timestamps',
    'Timestamps',
    saved['timestamps'] !== false,
    'timestamps',
  );
  const diarize = choice('stt-diarize', 'Speaker labels', saved['diarize'] === true, 'diarize');

  ui.drawer.append(
    h(
      'div',
      null,
      h('label', { class: 'form-label', htmlFor: ids.language }, 'Language'),
      language,
      h(
        'div',
        { class: 'form-text' },
        'The language spoken, if you know it; it helps with short or noisy recordings.',
      ),
    ),
    timestamps.element,
    diarize.element,
  );

  const partMinutes = h(
    'select',
    {
      id: ids.partMinutes,
      class: 'form-select',
      'aria-describedby': ids.partNote,
      'data-testid': 'stt-part-minutes',
      onchange: () => {
        ctx.options.set({ partMinutes: Number(partMinutes.value) });
        renderSource();
        void ui.refreshEstimate();
      },
    },
    PART_MINUTES.map((minutes) =>
      h('option', { value: String(minutes) }, plural(minutes, 'minute')),
    ),
  );
  partMinutes.value = String(
    isPartMinutes(saved['partMinutes']) ? saved['partMinutes'] : DEFAULT_PART_MINUTES,
  );
  const partNote = h('div', {
    id: ids.partNote,
    class: 'form-text',
    'data-testid': 'stt-part-note',
  });
  ui.advanced('Long recordings').append(
    h(
      'div',
      null,
      h('label', { class: 'form-label', htmlFor: ids.partMinutes }, 'Longest part'),
      partMinutes,
      partNote,
    ),
  );

  // --- input zone -------------------------------------------------------------------------------------------
  const sourceArea = h('div', { class: 'vstack gap-2', 'data-testid': 'stt-source' });
  const rec = recorder({
    maxSeconds: MAX_RECORDING_SECONDS,
    reducedMotion: () => motionReduced(ctx.settings.get()),
    holdWork: (description) => ui.holdWork(description),
    beforeStart: async () => {
      if (runnerState.busy) {
        announce('Wait until the transcription ends, or press Stop.');
        return false;
      }
      return confirmReplace();
    },
    onBusyChange: (busy) => runner.setDisabled(busy ? 'Stop the recording first.' : null),
    onRecorded: ({ blob, seconds, extension }) => {
      const name = recordingName(extension);
      void useSource(blob, name, 'recording', { confirmed: true, seconds }).catch(
        (error: unknown) => void presentError(error),
      );
    },
  });

  const vocabulary = h('textarea', {
    id: ids.vocabulary,
    class: 'form-control',
    rows: 2,
    placeholder: 'Names, places and terms to spell right, separated by commas',
    'aria-describedby': ids.vocabularyNote,
    'data-testid': 'tool-prompt',
  });
  const vocabularyNote = h('div', {
    id: ids.vocabularyNote,
    class: 'form-text',
    'data-testid': 'stt-vocabulary-note',
  });

  ui.input.append(
    sourceArea,
    h(
      'section',
      { class: 'border rounded p-3', 'aria-label': 'Record' },
      h('h3', { class: 'h6 mb-2' }, 'Record'),
      rec.element,
    ),
    h(
      'div',
      null,
      h(
        'label',
        { class: 'form-label fw-semibold', htmlFor: ids.vocabulary },
        'Vocabulary (optional)',
      ),
      vocabulary,
      vocabularyNote,
    ),
  );

  // --- output zone ------------------------------------------------------------------------------------------
  const editor = transcriptEditor({
    onSeek: (seconds) => {
      if (!player || !source || transcriptOf?.sourceId !== source.id) {
        announce('This transcript belongs to a recording that is no longer loaded.');
        return;
      }
      // Through the player: a recording's length probe would otherwise rewind a seek made while it runs.
      const { audio } = player;
      void player
        .seek(seconds)
        .then(() => audio.play())
        .catch(() => undefined);
    },
    onChange: () => updateActions(),
  });

  const stem = (): string =>
    `${(transcriptOf?.name ?? 'recording').replace(/\.[^.]+$/, '')}-transcript`;
  const current = () => editor.transcript();
  const partMetas = (): PartMeta[] => parts.flatMap((part) => (part.meta ? [part.meta] : []));
  const jsonMeta = () => ({
    source: transcriptOf?.name ?? '',
    duration: transcriptOf?.duration ?? null,
    parts: partMetas(),
  });
  const formats = (): ExportFormat[] => [
    {
      label: 'Text',
      extension: 'txt',
      icon: 'file-earmark-text',
      build: () => new Blob([editor.text()], { type: 'text/plain' }),
    },
    ...(current().timed
      ? [
          {
            label: 'Subtitles (SRT)',
            extension: 'srt',
            icon: 'badge-cc',
            build: () =>
              new Blob([toSrt(subtitleSegments(current(), editor.names))], {
                type: 'application/x-subrip',
              }),
          },
          {
            label: 'Subtitles (WebVTT)',
            extension: 'vtt',
            icon: 'badge-cc',
            build: () =>
              new Blob([toVtt(subtitleSegments(current(), editor.names))], { type: 'text/vtt' }),
          },
        ]
      : []),
    {
      label: 'JSON (segments and words)',
      extension: 'json',
      icon: 'filetype-json',
      build: () => toJsonBlob(transcriptJson(current(), editor.names, jsonMeta())),
    },
    {
      label: 'Word document',
      extension: 'docx',
      icon: 'file-earmark-word',
      build: async () =>
        (await import('../../core/export/docx')).toDocx(
          transcriptMarkdown(current(), editor.names),
        ),
    },
  ];
  const downloads = exportMenu({
    formats: formats(),
    filename: stem,
    disabled: true,
    testId: 'stt-download',
  });
  const copyButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
      disabled: true,
      'data-testid': 'stt-copy',
      onclick: () => void copyWithToast(editor.text(), 'Copied to the clipboard.'),
    },
    icon('clipboard'),
    'Copy',
  );
  const sendButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
      disabled: true,
      'data-testid': 'stt-send',
      onclick: () =>
        ui.sendTo([
          { kind: 'text', text: editor.text(), type: 'text/plain', name: `${stem()}.txt` },
        ]),
    },
    icon('send'),
    'Send to…',
  );
  let lastTimed = true;
  function updateActions(): void {
    const has = current().segments.length > 0;
    copyButton.disabled = !has;
    sendButton.disabled = !has;
    if (current().timed !== lastTimed) {
      lastTimed = current().timed;
      downloads.update({ formats: formats(), disabled: !has });
    } else downloads.update({ disabled: !has });
  }

  const progress = progressBar({
    label: 'Parts transcribed',
    hidden: true,
    class: 'flex-grow-1',
    testId: 'stt-progress',
  });
  const partsList = h('ol', {
    class: 'list-unstyled d-flex flex-wrap gap-2 mb-0',
    'aria-label': 'Parts',
    hidden: true,
    'data-testid': 'stt-parts',
  });
  const failedNotice = h('div', { hidden: true, 'data-testid': 'stt-failed' });
  const mixedNotice = h('div', {
    class: 'alert alert-info small py-2 mb-0',
    hidden: true,
    'data-testid': 'stt-mixed-models',
  });

  ui.output.append(
    h(
      'div',
      { class: 'vstack gap-3' },
      h(
        'div',
        { class: 'd-flex flex-wrap align-items-center gap-2' },
        progress.element,
        h('div', { class: 'd-flex flex-wrap gap-2 ms-auto' }, copyButton, downloads, sendButton),
      ),
      partsList,
      failedNotice,
      mixedNotice,
      editor.element,
    ),
  );

  // --- parts --------------------------------------------------------------------------------------------------
  const partItems = new Map<number, HTMLElement>();

  /**
   * Why the parts on screen cannot be retried as they are, or null: the recording was replaced, or the model now
   * chosen cannot take the parts as they were cut (too long, or a format it does not read).
   */
  const retryProblem = (): string | null => {
    if (!transcriptOf) return null;
    if (source?.id !== transcriptOf.sourceId) {
      return 'This transcript belongs to a recording that is no longer loaded, so its parts cannot be retried.';
    }
    const model = ctx.model().model;
    const open = parts.filter((part) => part.status !== 'done');
    return model ? partsUnfitFor(model, open, Number(partMinutes.value)) : null;
  };
  /** Keeps the Retry buttons in step with Run (set once the runner exists, below). */
  let gate: RetryGate<number[]> | null = null;
  /** On top of the gate's state: a button whose parts cannot be retried shows why. */
  const paintProblem = (button: HTMLElement): void => {
    const problem = retryProblem();
    if (!problem) return;
    button.setAttribute('aria-disabled', 'true');
    button.classList.add('disabled');
    button.title = problem;
  };
  const retry = (indexes: number[]): void => {
    if (indexes.length === 0) return;
    const problem = retryProblem();
    if (problem) {
      announce(problem);
      return;
    }
    gate?.retry(indexes, 'This cannot start now.');
  };
  const retryButton = (
    attributes: Record<string, string>,
    indexes: () => number[],
    ...children: (HTMLElement | string)[]
  ): HTMLButtonElement => {
    const button = h(
      'button',
      { type: 'button', ...attributes, 'data-retry': '', onclick: () => retry(indexes()) },
      ...children,
    );
    gate?.bind(button);
    paintProblem(button);
    return button;
  };

  const partLabel = (part: PartState): string =>
    `Part ${part.index + 1} · ${formatDuration(part.start)}–${formatDuration(part.start + part.duration)}`;

  const partItem = (part: PartState): HTMLElement => {
    const item = h(
      'li',
      {
        class: 'border rounded px-2 py-1 small d-flex flex-wrap align-items-center gap-2',
        tabIndex: -1,
        'data-focus-key': `part:${part.index}`,
        'data-testid': 'stt-part',
        dataset: { status: part.status, index: String(part.index) },
      },
      h('span', null, partLabel(part)),
      h('span', { class: `badge ${STATUS_BADGE[part.status]}` }, STATUS_TEXT[part.status]),
      part.status === 'failed' || part.status === 'stopped'
        ? retryButton(
            {
              class: 'btn btn-sm btn-outline-primary py-0 d-inline-flex align-items-center gap-1',
              'aria-label': `Retry part ${part.index + 1}`,
              'data-focus-key': `retry:${part.index}`,
              'data-testid': 'stt-part-retry',
            },
            () => [part.index],
            icon('arrow-clockwise'),
            'Retry',
          )
        : null,
      part.error ? h('span', { class: 'w-100 text-danger-emphasis' }, part.error) : null,
    );
    partItems.set(part.index, item);
    return item;
  };

  const showParts = (): boolean =>
    parts.length > 1 || parts.some((part) => part.status === 'failed' || part.status === 'stopped');

  const renderFailed = (): void => {
    const failed = parts.filter((part) => part.status === 'failed' || part.status === 'stopped');
    failedNotice.hidden = failed.length === 0 || transcribing;
    const problem = retryProblem();
    replaceWith(
      failedNotice,
      failed.length === 0
        ? null
        : h(
            'div',
            { class: 'alert alert-warning d-flex flex-wrap align-items-center gap-2 mb-0' },
            icon('exclamation-triangle'),
            h(
              'span',
              { class: 'me-auto' },
              parts.length === 1
                ? 'The recording was not transcribed.'
                : `${plural(failed.length, 'part')} not transcribed.`,
            ),
            retryButton(
              {
                class: 'btn btn-sm btn-warning',
                'data-focus-key': 'retry-failed',
                'data-testid': 'stt-retry-failed',
              },
              () => failed.map((part) => part.index),
              failed.length === 1 ? 'Retry' : 'Retry them',
            ),
            problem
              ? h('div', { class: 'w-100 small', 'data-testid': 'stt-retry-note' }, problem)
              : null,
          ),
      { fallback: () => copyButton },
    );
    const mixed = mixedModelsNote(partMetas());
    mixedNotice.hidden = mixed === null;
    mixedNotice.textContent = mixed
      ? `Parts were transcribed with different models: ${mixed}.`
      : '';
  };

  const renderParts = (): void => {
    partItems.clear();
    partsList.hidden = !showParts();
    replaceWith(partsList, partsList.hidden ? null : parts.map(partItem), {
      fallback: (lost) =>
        lost.startsWith('retry:') ? partItems.get(Number(lost.slice('retry:'.length))) : undefined,
    });
    renderFailed();
  };

  const updatePart = (part: PartState): void => {
    const old = partItems.get(part.index);
    if (!old?.isConnected || partsList.hidden !== !showParts()) {
      renderParts();
      return;
    }
    const key = focusedKey(old);
    const fresh = partItem(part);
    old.replaceWith(fresh);
    if (key && !focusKey(fresh, key)) fresh.focus();
  };

  const updateProgress = (): void => {
    const total = parts.length;
    const done = parts.filter((part) => part.status === 'done').length;
    progress.element.hidden = total < 2;
    progress.update(done, total, `${done} of ${plural(total, 'part')}`);
    if (transcribing && total > 1) ui.progress(`Transcribed ${done} of ${plural(total, 'part')}`);
  };

  // --- merging --------------------------------------------------------------------------------------------
  let mergeTimer: ReturnType<typeof setTimeout> | null = null;
  const mergeNow = (): void => {
    if (mergeTimer) clearTimeout(mergeTimer);
    mergeTimer = null;
    const done = parts.flatMap((part) =>
      part.status === 'done' && part.result
        ? [{ index: part.index, offset: part.start, duration: part.duration, result: part.result }]
        : [],
    );
    editor.set(mergeParts(done, { partCount: parts.length, edits: editor.edits }));
    updateActions();
    if (player) editor.setTime(player.audio.currentTime);
  };
  const scheduleMerge = (): void => {
    mergeTimer ??= setTimeout(mergeNow, 300);
  };

  // --- source -----------------------------------------------------------------------------------------------
  const settings = () => ({
    language: language.value,
    timestamps: timestamps.wanted,
    diarize: diarize.wanted,
    partMinutes: Number(partMinutes.value),
  });

  /** The model's limits shown next to the options; called whenever the model may have changed. */
  let modelShown: string | null | undefined;
  const applyModel = (model: string | null): void => {
    if (model === modelShown) return;
    modelShown = model;
    const support = sttSupport(model);
    timestamps.show(support.timestamps);
    timestamps.note.textContent = support.timestamps
      ? 'Segment times (and word times where the model gives them) for the editor and subtitles.'
      : 'This model returns text without timestamps, so there are no subtitle files.';
    diarize.show(support.diarization);
    diarize.note.textContent = support.diarization
      ? 'Names who speaks when. The model numbers speakers per request, so a long recording is labeled per part.'
      : 'Speaker labels can be requested from Deepgram and MAI-Transcribe models only. Choose one of those to turn them on.';
    vocabularyNote.textContent = support.keyterms
      ? 'Sent to the model as key terms, so they are spelled as you write them here.'
      : 'This model does not take a vocabulary list, so it is not sent. Deepgram and AssemblyAI models do.';
    renderSource();
    // The parts on screen may not fit the new model: Retry says so.
    renderParts();
  };

  const confirmReplace = async (): Promise<boolean> => {
    if (!recording || recording.result.downloaded) return true;
    return confirmDialog({
      title: 'Replace the recording?',
      message: 'Your recording has not been downloaded. Once replaced it is gone.',
      confirmLabel: 'Replace',
      tone: 'warning',
      testId: 'stt-replace-dialog',
    });
  };

  const dropTarget = (compact: boolean): HTMLElement =>
    dropZone({
      accept: ctx.manifest.accepts,
      compact,
      label: compact ? 'Drop another file to replace it' : 'Drop a recording or a video here',
      hint: 'Audio or video: MP3, WAV, M4A, OGG, WebM, FLAC, MP4…',
      onFiles: (files) => takeFiles(files),
      testId: 'stt-drop-zone',
    });

  function renderSource(): void {
    const model = ctx.model().model;
    const seconds = partSeconds(Number(partMinutes.value), model);
    const { maxPartSeconds: limit, pcmWavOnly } = sttSupport(model);
    partNote.textContent = `Long recordings are cut at pauses into parts of at most this length; each part is one request.${
      limit
        ? ` This model takes at most ${formatDuration(limit)} per request, so parts are shorter.`
        : ''
    }`;
    if (!source) {
      replace(sourceArea, dropTarget(false));
      return;
    }
    const meta = [
      source.duration === null
        ? 'Length unknown until it is decoded'
        : formatDuration(source.duration),
      formatBytes(source.blob.size),
      source.kind === 'video' ? 'video (its sound is transcribed)' : null,
    ]
      .filter(Boolean)
      .join(' · ');
    const plan = sentAsIs(source, seconds, pcmWavOnly)
      ? 'Sent as it is, in one request.'
      : source.duration === null
        ? `Decoded and cut at pauses into parts of up to ${formatDuration(seconds)}.`
        : `Decoded and cut at pauses into about ${plural(expectedParts(source, seconds, pcmWavOnly), 'part')} of up to ${formatDuration(seconds)}.`;
    const glyph =
      source.origin === 'recording'
        ? 'mic-fill'
        : source.kind === 'video'
          ? 'film'
          : 'file-earmark-music';
    replace(
      sourceArea,
      h(
        'div',
        { class: 'card', 'data-testid': 'stt-source-card' },
        h(
          'div',
          { class: 'card-body vstack gap-2' },
          h(
            'div',
            { class: 'd-flex align-items-start gap-2' },
            icon(glyph, 'fs-4 lh-1 text-body-secondary'),
            h(
              'div',
              { class: 'flex-grow-1 min-w-0' },
              h(
                'div',
                { class: 'fw-semibold text-break', 'data-testid': 'stt-source-name' },
                source.name,
              ),
              h(
                'div',
                { class: 'small text-body-secondary', 'data-testid': 'stt-source-meta' },
                meta,
              ),
              h(
                'div',
                { class: 'small text-body-secondary', 'data-testid': 'stt-source-plan' },
                plan,
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
                'aria-label': `Remove ${source.name}`,
                'data-focus-key': 'source-remove',
                'data-testid': 'stt-source-remove',
                onclick: () => void removeSource(),
              },
              icon('x-lg'),
              'Remove',
            ),
          ),
          player?.element ?? null,
          recording
            ? h(
                'div',
                { class: 'd-flex flex-wrap align-items-center gap-2' },
                recording.button('Download recording'),
                h(
                  'span',
                  { class: 'small text-body-secondary' },
                  'The recording is kept in this tab only.',
                ),
              )
            : null,
        ),
      ),
      dropTarget(true),
    );
  }

  const setSource = (next: AudioSource | null): void => {
    player?.dispose();
    player = null;
    if (recording && recording.result.blob !== next?.blob) {
      recording.remove();
      recording = null;
    }
    source = next;
    prepared = null;
    if (next) {
      // The length is known (measured once, or the recorder's): the player does not measure again.
      player = audioPlayer({
        blob: next.blob,
        label: next.name,
        ...(next.duration === null ? {} : { seconds: next.duration }),
        testId: 'stt-player',
      });
      const follow = (): void => {
        if (transcriptOf?.sourceId === next.id && player) editor.setTime(player.audio.currentTime);
      };
      player.audio.addEventListener('timeupdate', follow);
      player.audio.addEventListener('seeked', follow);
    }
    renderSource();
    // Retry buttons of a transcript for another recording now say why they are off.
    renderParts();
    void ui.refreshEstimate();
  };

  async function useSource(
    blob: Blob,
    name: string,
    origin: AudioSource['origin'],
    options: { confirmed?: boolean; seconds?: number } = {},
  ): Promise<void> {
    if (origin === 'recording') {
      // A result at once, before anything is awaited: the recorder's hold on the page has just been released.
      // It replaces any earlier recording (the user agreed before recording).
      recording?.remove();
      recording = ui.addResult({ kind: 'audio', name, blob });
    } else if (runnerState.busy) {
      announce('Wait until the transcription ends, or press Stop.');
      return;
    }
    if (!options.confirmed && !(await confirmReplace())) return;
    ui.status('Reading the file…');
    const inspected = await inspectSource(blob, name, origin);
    if (inspected.duration === null && options.seconds) inspected.duration = options.seconds;
    setSource(inspected);
    ui.status(
      `${origin === 'recording' ? 'Recorded' : 'Added'} ${name}${
        inspected.duration === null ? '' : ` (${formatDuration(inspected.duration)})`
      }.`,
    );
  }

  function takeFiles(files: readonly File[]): void {
    const file = files[0];
    if (!file) return;
    if (files.length > 1) announce('One recording at a time: the first file is used.');
    void useSource(file, file.name, 'file').catch((error: unknown) => void presentError(error));
  }

  async function removeSource(): Promise<void> {
    if (runnerState.busy) {
      announce('Wait until the transcription ends, or press Stop.');
      return;
    }
    if (!(await confirmReplace())) return;
    setSource(null);
    ui.status('Removed.');
    // The card (and its Remove button) is gone: the drop zone's button takes focus.
    sourceArea.querySelector<HTMLElement>('button')?.focus();
  }

  // --- running ------------------------------------------------------------------------------------------------
  const estimateSeconds = (model: string, seconds: number, count: number) =>
    ctx.models.estimate({ kind: 'transcription', model, seconds: Math.ceil(seconds) + count });

  const run = async (signal: AbortSignal, retryIndexes?: number[]): Promise<void> => {
    const input = source;
    if (!input) {
      ui.status('Record or add a recording first.');
      return;
    }
    const model = ctx.model().model;
    if (!model) return; // the framework shows why and keeps Run disabled
    const seconds = partSeconds(Number(partMinutes.value), model);
    const support = sttSupport(model);
    const retryParts = retryIndexes
      ? parts.filter((part) => retryIndexes.includes(part.index) && part.status !== 'done')
      : null;
    if (retryParts) {
      if (retryParts.length === 0) return;
      // Also for the error toast's Retry: say why instead of doing nothing.
      const problem = retryProblem();
      if (problem) {
        ui.status(problem);
        announce(problem);
        return;
      }
    }

    // Refused here (no key, locked, free-only, budget, Cancel): nothing on the page changes.
    const runHandle = await ctx.beginRun(
      {
        title: retryParts ? `Retry: ${input.name}` : input.name,
        ...(retryParts
          ? {
              estimateUsd: await estimateSeconds(
                model,
                retryParts.reduce((sum, part) => sum + part.duration, 0),
                retryParts.length,
              ),
            }
          : {}),
      },
      signal,
    );
    transcribing = true;
    const request = {
      language: language.value,
      timestamps: timestamps.wanted && support.timestamps,
      diarize: diarize.wanted && support.diarization,
      keyterms: support.keyterms ? parseKeyterms(vocabulary.value) : [],
    };
    try {
      let work: PartState[];
      if (retryParts) {
        for (const part of retryParts) {
          part.status = 'queued';
          part.error = null;
          part.result = null;
          part.meta = null;
          for (const id of [...editor.edits.keys()]) {
            if (id.startsWith(`${part.index}:`)) editor.edits.delete(id);
          }
        }
        work = retryParts;
        renderParts();
      } else {
        // A new transcript: the last one goes only now that the run is on.
        editor.reset();
        parts = [];
        transcriptOf = { sourceId: input.id, name: input.name, duration: input.duration };
        editor.set(EMPTY_TRANSCRIPT);
        updateActions();
        renderParts();
        updateProgress();
        if (
          !prepared ||
          prepared.sourceId !== input.id ||
          prepared.seconds !== seconds ||
          prepared.pcmWavOnly !== support.pcmWavOnly
        ) {
          prepared = null;
          const cut = await prepareParts(input, {
            partSeconds: seconds,
            pcmWavOnly: support.pcmWavOnly,
            signal: runHandle.signal,
            onStatus: (text) => ui.status(text),
            onProgress: (text) => ui.progress(text),
          });
          prepared = { sourceId: input.id, seconds, pcmWavOnly: support.pcmWavOnly, parts: cut };
        }
        const last = prepared.parts.at(-1);
        if (last && transcriptOf) transcriptOf.duration = last.start + last.duration;
        parts = prepared.parts.map((part) => ({
          ...part,
          status: 'queued',
          error: null,
          result: null,
          meta: null,
        }));
        work = parts;
        renderParts();
      }
      updateProgress();
      ui.status(
        parts.length > 1 ? `Transcribing ${plural(parts.length, 'part')}…` : 'Transcribing…',
      );

      await runItems({
        items: work,
        concurrency: CONCURRENCY,
        signal: runHandle.signal,
        work: async (part, itemSignal) => {
          const result = await ctx.api.transcribe(
            {
              model,
              audio: part.blob,
              format: part.format,
              filename: part.format === 'wav' ? `part-${part.index + 1}.wav` : input.name,
              ...(request.language ? { language: request.language } : {}),
              timestamps: request.timestamps,
              diarize: request.diarize,
              ...(request.keyterms.length ? { keyterms: request.keyterms } : {}),
            },
            { run: runHandle, signal: itemSignal },
          );
          part.result = result;
          part.meta = {
            index: part.index,
            start: part.start,
            duration: part.duration,
            model,
            language: request.language || null,
            timestamps: request.timestamps,
            diarize: request.diarize,
            keyterms: request.keyterms.length,
          };
          return result;
        },
        onItem: (outcome) => {
          const part = outcome.item;
          part.status = outcome.status;
          if (outcome.status === 'running') part.error = null;
          if (outcome.status === 'failed') part.error = userMessage(outcome.error);
          updatePart(part);
          updateProgress();
          if (outcome.status !== 'done') return;
          scheduleMerge();
          void runHandle.checkpoint({ output: () => editor.text() }).catch(() => undefined);
        },
      });
      mergeNow();
      const done = parts.filter((part) => part.status === 'done').length;
      const summary =
        parts.length === 1
          ? `Done · ${plural(current().segments.length, 'segment')}`
          : batchSummary({ done, failed: parts.length - done, stopped: 0 }, 'part');
      ui.status(summary);
      announce(summary);
      await runHandle.finish({
        output: editor.text(),
        meta: {
          duration: transcriptOf?.duration ?? null,
          models: modelsUsed(partMetas()),
          parts: parts.length,
          failedParts: parts.filter((part) => part.status !== 'done').map((part) => part.index + 1),
          language: current().language,
          speakers: current().speakers.length,
        },
      });
    } catch (error) {
      mergeNow();
      ui.status(isStop(error) ? 'Stopped' : 'Failed');
      await runHandle.fail(error);
      throw error;
    } finally {
      transcribing = false;
      renderParts();
      updateProgress();
    }
  };

  const runner = ui.runner<number[]>({ label: 'Transcribe', icon: 'mic', run });
  gate = retryGate(runner);
  // After the gate's own subscription: a part that cannot be retried keeps saying why.
  runner.subscribe((state) => {
    runnerState = state;
    for (const button of ui.output.querySelectorAll<HTMLElement>('[data-retry]'))
      paintProblem(button);
  });
  renderSource();
  applyModel(ctx.model().model);

  // --- instance ---------------------------------------------------------------------------------------------
  const applyState = ({ prompt, settings: state }: ToolSnapshot): void => {
    vocabulary.value = prompt;
    const lang = state['language'];
    if (typeof lang === 'string' && (lang === '' || LANGUAGES.includes(lang)))
      language.value = lang;
    if (typeof state['timestamps'] === 'boolean') timestamps.wanted = state['timestamps'];
    if (typeof state['diarize'] === 'boolean') diarize.wanted = state['diarize'];
    if (isPartMinutes(state['partMinutes'])) partMinutes.value = String(state['partMinutes']);
    const support = sttSupport(ctx.model().model);
    timestamps.show(support.timestamps);
    diarize.show(support.diarization);
    renderSource();
    void ui.refreshEstimate();
  };

  const receive = (items: readonly SendItem[]): void => {
    const item = items.find((candidate) => candidate.kind === 'file');
    if (item?.kind !== 'file') return;
    void useSource(item.blob, item.name, 'file').catch(
      (error: unknown) => void presentError(error),
    );
  };

  return {
    getState: () => ({ prompt: vocabulary.value, settings: settings() }),
    applyState,
    estimate: (model) => {
      applyModel(model);
      if (!source || source.duration === null) return Promise.resolve(null);
      const seconds = partSeconds(Number(partMinutes.value), model);
      return estimateSeconds(
        model,
        source.duration,
        expectedParts(source, seconds, sttSupport(model).pcmWavOnly),
      );
    },
    onFiles: (files) => takeFiles(files),
    onReceive: receive,
    sample: async () => {
      vocabulary.value = 'quick brown fox, lazy dog';
      const response = await fetch(sampleUrl).catch((error: unknown) => {
        throw new NetworkError('The sample recording could not be loaded.', { cause: error });
      });
      if (!response.ok) throw new NetworkError('The sample recording could not be loaded.');
      await useSource(await response.blob(), 'sample-speech.mp3', 'sample');
    },
  };
}
