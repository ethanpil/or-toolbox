/**
 * Text-to-speech: text (typed, pasted, a TXT/MD file or sent from another tool) read aloud in a chosen voice.
 *
 * One run per Run press. Long text is split into parts of about a minute of speech (text.ts, voices.ts), the
 * parts are synthesised a few at a time with `runItems`, and the pieces are joined gaplessly with `stitchAudio`
 * into one MP3 or WAV (PCM-only models are wrapped as WAV first).
 *
 * Paid parts are never thrown away or paid for twice: the plan (the parts and the settings they were made with)
 * stays in memory until the joined audio exists. A part that fails, comes back without audio, or that Stop left
 * unmade can be retried on its own; Read aloud (or the error toast's Retry) with the same text, model, voice and
 * speed continues the plan instead of starting again; a join that fails or is stopped is offered again without
 * making any part twice. Voice previews read a short sentence in the voice's language, once per model, voice
 * and speed, and stay in memory for the session.
 */
import { defaultSpeechFormat } from '../../core/api/client';
import type { SpeechResult } from '../../core/api/types';
import { InvalidInputError, isAbortError, isOutcomeUnknown, userMessage } from '../../core/errors';
import { readAsText, sanitizeFilename, sniffMime } from '../../core/files';
import { decodeAudio, getAudioDuration } from '../../core/media/audio';
import { pcmToWav } from '../../core/media/wav';
import type { ModelInfo, RunHandle } from '../../core/types';
import { debounce } from '../../core/util';
import { audioResultCard } from '../../ui/components/audio-result-card';
import { dropZone } from '../../ui/components/drop-zone';
import { emptyState } from '../../ui/components/empty-state';
import { failureLine } from '../../ui/components/failure-line';
import { progressBar } from '../../ui/components/progress-bar';
import { h, replaceWith } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { type FailureText, isStop, presentError } from '../../ui/feedback/errors';
import { formatBytes, formatDuration, formatInt, formatUsd, plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import { type ItemStatus, runItems } from '../../ui/tool/batch';
import type { ToolContext, ToolInstance } from '../../ui/tool/index';
import { retryGate } from '../../ui/tool/retry-gate';
import { countWords, fileStem, normalizeText, splitText, stripMarkdown } from './text';
import { chunkLimit, previewText, speedSupported, voiceLabel } from './voices';

type Format = 'mp3' | 'wav';

const FORMATS: readonly { id: Format; label: string }[] = [
  { id: 'mp3', label: 'MP3 (smaller)' },
  { id: 'wav', label: 'WAV (uncompressed)' },
];
const isFormat = (value: unknown): value is Format => value === 'mp3' || value === 'wav';

/** Chunks synthesised at the same time: enough to keep a long text moving, few enough for rate limits. */
const CONCURRENCY = 3;
/** Raw PCM without a rate in its Content-Type: what Kokoro and Gemini TTS send (§4.1). */
const DEFAULT_PCM_RATE = 24000;
const SPEED_MIN = 0.5;
const SPEED_MAX = 2;
/** Sample rate used only to check that a part decodes (cheap; the join decodes at the real rate). */
const PROBE_RATE = 8000;

interface Chunk {
  key: string;
  index: number;
  text: string;
  status: ItemStatus;
  blob: Blob | null;
  /** Why it failed, worded for its line (a request that may have been billed says so). */
  failure: FailureText | null;
  /** The error behind `failure`: the Retry asks first when the request may have been billed. */
  cause: unknown;
}

/**
 * What one Read aloud press asked for; a retry, a continued Read aloud and Join again finish it with exactly
 * these settings, and the parts stay here until the joined audio exists.
 */
interface Plan {
  model: string;
  voice: string | null;
  speed: number | null;
  /** The format the parts are joined into (the only setting that may change without remaking a part). */
  format: Format;
  /** File name stem, from the first words of the text. */
  stem: string;
  /** The normalised text the parts were made from. */
  source: string;
  chunks: Chunk[];
  /** Set when every part was made but the join did not finish: what happened, for the notice. */
  joinNote: string | null;
}

/** The runner's argument: retry these parts, or join the parts already made. */
type RunArg = { parts: string[] } | { join: true };

/** What a take's card shows: plain values, so nothing in it keeps a plan (and its part audio) alive. */
interface TakeInfo {
  stem: string;
  format: Format;
  voice: string | null;
  seconds: number | null;
}

const isTextFile = (type: string, name: string): boolean =>
  type.startsWith('text/') || /\.(txt|md|markdown)$/i.test(name);
const isText = (file: File): boolean => isTextFile(file.type, file.name);
const isMarkdown = (type: string | undefined, name = ''): boolean =>
  type === 'text/markdown' || /\.(md|markdown)$/i.test(name);

/** A chunk's audio as something `stitchAudio` decodes: MP3 as it came, raw PCM wrapped as WAV. */
async function toSegment(result: SpeechResult): Promise<Blob> {
  if (result.mimeType !== 'audio/pcm') return result.blob;
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  return pcmToWav(bytes, result.sampleRate ?? DEFAULT_PCM_RATE, result.channels ?? 1);
}

/**
 * Throws when a speech response is not audio: empty, or (for anything but raw PCM, which has no header) bytes
 * that are not a known audio format, such as an error page or JSON sent with a 200.
 */
async function checkAudio(result: SpeechResult): Promise<void> {
  if (result.blob.size === 0) throw new InvalidInputError('The part came back empty.');
  const head = new Uint8Array(await result.blob.slice(0, 64).arrayBuffer());
  if (result.mimeType === 'audio/pcm') {
    const start = String.fromCharCode(...head.slice(0, 16)).trimStart();
    if (/^[{<]/.test(start)) throw new InvalidInputError('The part came back as text, not audio.');
    return;
  }
  if (!/^(audio|video)\//.test(sniffMime(head) ?? '')) {
    throw new InvalidInputError('The part came back without audio.');
  }
}

export function setup(ctx: ToolContext): ToolInstance {
  const { ui } = ctx;
  const saved = ctx.options.get();
  const ids = {
    text: uid('tts-text'),
    counts: uid('tts-counts'),
    voice: uid('tts-voice'),
    previewNote: uid('tts-preview-note'),
    format: uid('tts-format'),
    speed: uid('tts-speed'),
    speedValue: uid('tts-speed-value'),
  };

  // --- input zone -----------------------------------------------------------------------------------------
  const text = h('textarea', {
    id: ids.text,
    class: 'form-control',
    rows: 12,
    placeholder: 'Type or paste the text to read aloud, or drop a .txt or .md file',
    'aria-describedby': ids.counts,
    'data-testid': 'tool-prompt',
  });
  const counts = h('div', { id: ids.counts, class: 'form-text', 'data-testid': 'tts-counts' });

  const voice = h('select', {
    id: ids.voice,
    class: 'form-select',
    'data-testid': 'tts-voice',
    onchange: () => {
      voiceValue = voice.value;
      if (modelId) ctx.options.set({ voices: { ...savedVoices(), [modelId]: voiceValue } });
      updatePreviewNote();
    },
  });
  const previewButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline-secondary d-inline-flex align-items-center gap-2 text-nowrap',
      'aria-describedby': ids.previewNote,
      'aria-disabled': 'false',
      'data-testid': 'tts-preview',
      onclick: () => void preview(),
    },
    icon('play-circle'),
    'Preview',
  );
  const previewNote = h('div', {
    id: ids.previewNote,
    class: 'form-text',
    'data-testid': 'tts-preview-note',
  });
  const previewAudio = h('audio', {
    controls: true,
    class: 'w-100 mt-2',
    hidden: true,
    'aria-label': 'Voice preview',
    'data-testid': 'tts-preview-audio',
  });

  ui.input.append(
    h(
      'div',
      null,
      h('label', { class: 'form-label fw-semibold', htmlFor: ids.text }, 'Text'),
      text,
      counts,
    ),
    dropZone({
      accept: ctx.manifest.accepts,
      multiple: true,
      compact: true,
      label: 'Drop a .txt or .md file',
      hint: 'Markdown is turned into plain text',
      testId: 'tts-drop-zone',
      onFiles: (files) => void addFiles(files),
    }),
    h(
      'div',
      null,
      h('label', { class: 'form-label fw-semibold', htmlFor: ids.voice }, 'Voice'),
      h('div', { class: 'd-flex gap-2' }, voice, previewButton),
      previewNote,
      previewAudio,
    ),
  );

  // --- drawer ---------------------------------------------------------------------------------------------
  const format = h(
    'select',
    {
      id: ids.format,
      class: 'form-select',
      'data-testid': 'tts-format',
      onchange: () => ctx.options.set({ format: format.value }),
    },
    FORMATS.map((entry) => h('option', { value: entry.id }, entry.label)),
  );
  format.value = isFormat(saved['format']) ? saved['format'] : 'mp3';
  const currentFormat = (): Format => (isFormat(format.value) ? format.value : 'mp3');

  const speedValue = h('output', { id: ids.speedValue, class: 'small text-body-secondary' });
  const speed = h('input', {
    id: ids.speed,
    type: 'range',
    class: 'form-range',
    min: String(SPEED_MIN),
    max: String(SPEED_MAX),
    step: '0.05',
    value: '1',
    'data-testid': 'tts-speed',
    oninput: () => {
      showSpeed();
      updatePreviewNote();
      updateCounts();
    },
    onchange: () => ctx.options.set({ speed: Number(speed.value) }),
  });
  const savedSpeed = saved['speed'];
  if (typeof savedSpeed === 'number' && savedSpeed >= SPEED_MIN && savedSpeed <= SPEED_MAX) {
    speed.value = String(savedSpeed);
  }
  const showSpeed = (): void => {
    const label = `${Number(speed.value).toFixed(2)}×`;
    speedValue.textContent = label;
    speed.setAttribute('aria-valuetext', label);
  };
  showSpeed();
  const speedField = h(
    'div',
    { 'data-testid': 'tts-speed-field' },
    h(
      'div',
      { class: 'd-flex justify-content-between align-items-baseline' },
      h('label', { class: 'form-label', htmlFor: ids.speed }, 'Speed'),
      speedValue,
    ),
    speed,
  );
  const noSpeed = h(
    'p',
    { class: 'form-text mt-0', hidden: true, 'data-testid': 'tts-no-speed' },
    'This model has no speed setting.',
  );

  ui.drawer.append(
    h(
      'div',
      null,
      h('label', { class: 'form-label', htmlFor: ids.format }, 'Audio format'),
      format,
      h(
        'div',
        { class: 'form-text' },
        'Both formats can be downloaded afterwards; this is the one the parts are joined into.',
      ),
    ),
    speedField,
    noSpeed,
    h(
      'p',
      { class: 'form-text mt-0' },
      'Voice cloning from a recording is not offered: few speech models support it and none of them the same way.',
    ),
  );

  // --- model and voices -----------------------------------------------------------------------------------
  let modelId: string | null = null;
  let modelInfo: ModelInfo | undefined;
  /** False while the catalog has not answered for `modelId` yet. */
  let modelKnown = false;
  /** The chosen voice id ('' when the model lists none). */
  let voiceValue = '';
  let modelGeneration = 0;
  let modelLoad: Promise<void> = Promise.resolve();

  const savedVoices = (): Record<string, string> => {
    const value = ctx.options.get()['voices'];
    return value && typeof value === 'object' ? (value as Record<string, string>) : {};
  };
  const voices = (): readonly string[] => modelInfo?.supportedVoices ?? [];
  const canSpeed = (): boolean => (modelInfo ? speedSupported(modelInfo) : false);

  /**
   * The voice a request for a model with `info` sends: the chosen one when the model lists it, else the one
   * remembered for that model, else its first (a model that lists voices needs one); none when it lists none.
   */
  const voiceFor = (info: ModelInfo | undefined): string | null => {
    const list = info?.supportedVoices ?? [];
    if (!info || list.length === 0) return null;
    if (list.includes(voiceValue)) return voiceValue;
    const remembered = savedVoices()[info.id];
    return remembered && list.includes(remembered) ? remembered : list[0]!;
  };
  const speedFor = (info: ModelInfo | undefined): number | null => {
    const value = Number(speed.value);
    return info && speedSupported(info) && value !== 1 ? value : null;
  };
  const currentVoice = (): string | null => voiceFor(modelInfo);
  const currentSpeed = (): number | null => speedFor(modelInfo);

  const renderVoices = (): void => {
    const list = voices();
    if (!modelKnown) {
      voice.replaceChildren(h('option', { value: '' }, 'Loading voices…'));
      voice.disabled = true;
    } else if (list.length > 0) {
      voiceValue = voiceFor(modelInfo) ?? list[0]!;
      voice.replaceChildren(...list.map((id) => h('option', { value: id }, voiceLabel(id))));
      voice.value = voiceValue;
      voice.disabled = false;
    } else {
      voice.replaceChildren(h('option', { value: '' }, "The model's own voice"));
      voice.disabled = modelInfo === undefined;
    }
    speedField.hidden = !canSpeed();
    noSpeed.hidden = canSpeed() || modelInfo === undefined;
    updatePreviewNote();
  };

  /** Reloads the voices when the model changed (header chip, settings, free-only, a catalog refresh). */
  const syncModel = (force = false): Promise<void> => {
    const next = ctx.model().model;
    if (next === modelId && !force) return modelLoad;
    const mine = ++modelGeneration;
    if (next !== modelId) {
      modelId = next;
      modelInfo = undefined;
      modelKnown = false;
      renderVoices();
    }
    modelLoad = (async () => {
      const info = next ? await ctx.models.get(next).catch(() => undefined) : undefined;
      if (mine !== modelGeneration) return;
      modelInfo = info;
      modelKnown = true;
      renderVoices();
      updateCounts();
    })();
    return modelLoad;
  };
  ctx.settings.subscribe(() => void syncModel());
  ctx.bus.on('models-refreshed', () => void syncModel(true));

  /** The catalog's entry for `model`, once it has answered: requests never go out before the voices are known. */
  const infoFor = async (model: string): Promise<ModelInfo | undefined> => {
    if (model === ctx.model().model) {
      await syncModel();
      if (model === modelId) return modelInfo;
    }
    return ctx.models.get(model).catch(() => undefined);
  };

  // --- counts and estimate --------------------------------------------------------------------------------
  const limitFor = (value: string, info: ModelInfo | undefined, chosenSpeed: number | null) =>
    chunkLimit(info, { text: value, speed: chosenSpeed });

  const updateCounts = (): void => {
    const value = normalizeText(text.value);
    if (!value) {
      counts.textContent = 'No text yet.';
      return;
    }
    const requests = splitText(value, limitFor(value, modelInfo, currentSpeed())).length;
    counts.textContent = `${formatInt(value.length)} characters · ${formatInt(countWords(value))} words · ${plural(requests, 'request')}`;
  };
  const onTextChange = debounce(() => {
    updateCounts();
    void ui.refreshEstimate();
  }, 200);
  text.addEventListener('input', () => onTextChange());
  updateCounts();

  const estimateText = (value: string, model: string): Promise<number | null> =>
    value
      ? ctx.models.estimate({
          kind: 'speech',
          model,
          characters: value.length,
          bytes: new TextEncoder().encode(value).length,
        })
      : Promise.resolve(null);

  // --- previews -------------------------------------------------------------------------------------------
  /** Preview audio per model, voice and speed, as object URLs (small, kept for the session). */
  const previews = new Map<string, string>();
  const previewKey = (): string | null =>
    modelId && modelKnown ? `${modelId}|${currentVoice() ?? ''}|${currentSpeed() ?? 1}` : null;
  let previewing = false;
  let noteGeneration = 0;

  const updatePreviewNote = (): void => {
    if (previewing) return; // the note says what the preview is doing until it is done
    const key = previewKey();
    const mine = ++noteGeneration;
    if (!key || !modelId) {
      previewNote.textContent = '';
      return;
    }
    if (previews.has(key)) {
      previewNote.textContent = 'Preview ready: it plays from memory, at no cost.';
      return;
    }
    previewNote.textContent = 'Preview reads one short sentence.';
    void estimateText(previewText(currentVoice()), modelId)
      .catch(() => null)
      .then((usd) => {
        if (mine !== noteGeneration || previewing) return;
        const cost = usd === null ? 'cost unknown' : usd === 0 ? 'free' : `about ${formatUsd(usd)}`;
        previewNote.textContent = `Preview reads one short sentence (${cost}).`;
      });
  };

  const playPreview = (url: string): void => {
    previewAudio.src = url;
    previewAudio.hidden = false;
    void previewAudio.play().catch(() => undefined); // a blocked autoplay leaves the controls to the user
  };

  /** Busy without `disabled`, so the button keeps focus (and a second press is simply ignored). */
  const setPreviewBusy = (busy: boolean): void => {
    previewButton.setAttribute('aria-disabled', String(busy));
    previewButton.classList.toggle('disabled', busy);
    if (busy) previewButton.setAttribute('aria-busy', 'true');
    else previewButton.removeAttribute('aria-busy');
  };

  const preview = async (): Promise<void> => {
    const model = ctx.model().model;
    if (!model || previewing) return;
    previewing = true;
    let started = false;
    try {
      const info = await infoFor(model);
      const chosenVoice = voiceFor(info);
      const chosenSpeed = speedFor(info);
      const key = `${model}|${chosenVoice ?? ''}|${chosenSpeed ?? 1}`;
      const cached = previews.get(key);
      if (cached) {
        playPreview(cached);
        announce('Playing the preview.');
        return;
      }
      const sentence = previewText(chosenVoice);
      // Refused before anything was sent (no key, locked, budget, Cancel): the button and note stay as they were.
      const run = await ctx.beginRun({
        model,
        title: `Voice preview: ${chosenVoice ? voiceLabel(chosenVoice) : "the model's own voice"}`,
        // No prompt: a preview is not a Recent prompt.
        prompt: '',
        settings: { voice: chosenVoice ?? '', speed: chosenSpeed ?? 1, preview: true },
        estimateUsd: await estimateText(sentence, model).catch(() => null),
        addons: [],
      });
      started = true;
      setPreviewBusy(true);
      previewNote.textContent = 'Making the preview…';
      announce('Making the preview…');
      try {
        const result = await ctx.api.speech(
          {
            model,
            input: sentence,
            ...(chosenVoice ? { voice: chosenVoice } : {}),
            ...(chosenSpeed !== null ? { speed: chosenSpeed } : {}),
          },
          { run },
        );
        await checkAudio(result);
        const url = URL.createObjectURL(await toSegment(result));
        await run.finish({ output: sentence, meta: { preview: true } });
        previews.set(key, url);
        announce('The preview is ready.');
        if (previewKey() === key) playPreview(url);
      } catch (error) {
        await run.fail(error);
        throw error;
      }
    } catch (error) {
      if (isStop(error)) {
        if (started) announce('The preview was stopped.');
      } else {
        announce('The preview could not be made.');
        void presentError(error, { retry: () => void preview() });
      }
    } finally {
      previewing = false;
      if (started) setPreviewBusy(false);
      updatePreviewNote();
    }
  };

  // --- output zone ----------------------------------------------------------------------------------------
  const bar = progressBar({ label: 'Parts made', hidden: true, testId: 'tts-progress' });
  const notice = h('div', { hidden: true, 'data-testid': 'tts-notice' });
  const empty = emptyState({
    icon: 'volume-up',
    title: 'No audio yet',
    text: 'Add text, choose a voice and press Read aloud.',
    testId: 'tts-empty',
  });
  // Focus lands here when the last take is removed.
  empty.tabIndex = -1;
  const takesList = h('div', { class: 'vstack gap-3', 'data-testid': 'tts-results' });
  ui.output.append(h('div', { class: 'vstack gap-3' }, bar.element, notice, empty, takesList));

  let takes = 0;
  const showEmpty = (): void => {
    empty.hidden = takes > 0 || !bar.element.hidden;
  };

  /** A joined take as a card. Built from plain values, so nothing in it keeps a plan (and its parts) alive. */
  const addTake = (blob: Blob, info: TakeInfo): void => {
    const { stem, format: madeAs, seconds } = info;
    const card = audioResultCard({
      ui,
      blob,
      name: `${stem}.${madeAs}`,
      ...(seconds === null ? {} : { seconds }),
      metaParts: [
        seconds === null ? null : formatDuration(seconds),
        info.voice ? voiceLabel(info.voice) : "The model's own voice",
        formatBytes(blob.size),
      ],
      formats: ['mp3', 'wav'],
      onRemove: () => {
        takes -= 1;
        showEmpty();
      },
      focusFallback: () => empty,
      testId: 'tts',
    });
    takes += 1;
    takesList.prepend(card.element);
    showEmpty();
  };

  // --- running --------------------------------------------------------------------------------------------
  let plan: Plan | null = null;
  let running = false;

  const missing = (current: Plan): Chunk[] =>
    current.chunks.filter((chunk) => chunk.status !== 'done');
  const madeCount = (current: Plan): number => current.chunks.length - missing(current).length;
  /** The plan's own settings, for History: a retry records what it made, not what the form says now. */
  const planSettings = (current: Plan) => ({
    voice: current.voice ?? '',
    speed: current.speed ?? 1,
    format: current.format,
  });
  /** The bar and the status line's counter (announced now and then, not on every tick). */
  const setProgress = (ratio: number, label: string): void => {
    bar.update(Math.round(Math.min(1, Math.max(0, ratio)) * 100), 100, label);
    ui.progress(label);
  };
  /** Lets go of a plan's part audio (after the join, or when a new plan replaces it). */
  const releasePlan = (current: Plan | null): void => {
    for (const chunk of current?.chunks ?? []) chunk.blob = null;
  };

  /**
   * Paid parts that are not joined yet live only in this page: leaving asks first. The hold follows the plan
   * (its description says how many parts) and ends when the audio is joined or the plan is replaced.
   */
  let held: { description: string; release: () => void } | null = null;
  const syncHold = (): void => {
    const made = plan ? madeCount(plan) : 0;
    const description = made > 0 ? `${plural(made, 'paid speech part')} not joined yet` : null;
    if (description === (held?.description ?? null)) return;
    held?.release();
    held = description ? { description, release: ui.holdWork(description) } : null;
  };

  /** A notice button that follows Run (unavailable while it is busy or disabled, but focusable). */
  const actionButton = (
    label: string,
    testId: string,
    arg: () => RunArg,
    cause: () => unknown = () => null,
  ): HTMLElement =>
    gate.bind(
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-warning',
          'data-testid': testId,
          // A part whose request may have been billed asks before it is sent again.
          onclick: () => void gate.retryFailed(cause(), arg(), 'Reading aloud cannot start now.'),
        },
        label,
      ),
    );

  const renderNotice = (): void => {
    syncHold();
    const current = plan;
    const left = current && !running ? missing(current) : [];
    const joinPending = current !== null && !running && left.length === 0 && current.joinNote;
    notice.hidden = left.length === 0 && !joinPending;
    if (!current || notice.hidden) {
      replaceWith(notice, null);
      return;
    }
    const total = current.chunks.length;
    if (joinPending) {
      replaceWith(
        notice,
        h(
          'div',
          { class: 'alert alert-warning d-flex flex-wrap align-items-center gap-2 mb-0' },
          icon('exclamation-triangle'),
          h(
            'span',
            { class: 'me-auto' },
            `All ${plural(total, 'part')} are made and kept. ${current.joinNote}`,
          ),
          actionButton('Join again', 'tts-join', () => ({ join: true })),
        ),
      );
      return;
    }
    const failed = left.filter((chunk) => chunk.status === 'failed');
    replaceWith(
      notice,
      h(
        'div',
        { class: 'alert alert-warning vstack gap-2 mb-0' },
        h(
          'div',
          { class: 'd-flex flex-wrap align-items-center gap-2' },
          icon('exclamation-triangle'),
          h(
            'span',
            { class: 'me-auto' },
            `${total - left.length} of ${plural(total, 'part')} made. ${failed.length > 0 ? `${failed.length} failed` : `${left.length} not made`}; the audio is joined once every part is there.`,
          ),
          actionButton(
            failed.length > 0
              ? `Retry ${plural(left.length, 'part')}`
              : `Make the other ${left.length}`,
            'tts-retry',
            () => ({ parts: missing(current).map((chunk) => chunk.key) }),
            () => failed.map((chunk) => chunk.cause).find(isOutcomeUnknown),
          ),
        ),
        failed.length > 0
          ? h(
              'ul',
              { class: 'small mb-0', 'data-testid': 'tts-failed' },
              failed.slice(0, 5).map((chunk) =>
                h(
                  'li',
                  null,
                  `Part ${chunk.index + 1}: `,
                  chunk.failure
                    ? failureLine(chunk.failure, {
                        className: 'd-inline',
                        testId: 'tts-failed-item',
                      })
                    : 'failed',
                ),
              ),
            )
          : null,
      ),
    );
  };

  const synthesize = async (
    run: RunHandle,
    current: Plan,
    chunk: Chunk,
    signal: AbortSignal,
  ): Promise<Blob> => {
    const result = await ctx.api.speech(
      {
        model: current.model,
        input: chunk.text,
        response_format: defaultSpeechFormat(current.model),
        ...(current.voice ? { voice: current.voice } : {}),
        ...(current.speed !== null ? { speed: current.speed } : {}),
      },
      { run, signal },
    );
    await checkAudio(result);
    return toSegment(result);
  };

  /**
   * After a join failed: the parts that do not decode on their own, marked failed so they can be made again
   * (the others are kept). Returns how many were found.
   */
  const findBadParts = async (current: Plan, signal: AbortSignal): Promise<number> => {
    let bad = 0;
    for (const chunk of current.chunks) {
      if (signal.aborted) break;
      try {
        if (!chunk.blob) throw new InvalidInputError('The part is missing.');
        await decodeAudio(chunk.blob, { sampleRate: PROBE_RATE });
      } catch (error) {
        if (isAbortError(error)) break;
        bad += 1;
        Object.assign(chunk, {
          status: 'failed',
          blob: null,
          failure: {
            text: 'its audio could not be decoded',
            outcomeUnknown: false,
            activityUrl: null,
            note: null,
          },
          cause: null,
        });
      }
    }
    return bad;
  };

  /**
   * Joins a plan whose parts are all made, shows the take and lets go of the parts. A failed or stopped join
   * keeps every part (and marks any that will not decode), so Join again or a retry finishes it for free.
   * With `handle`, the run that made the last parts is finished or failed here too.
   */
  const joinPlan = async (
    current: Plan,
    signal: AbortSignal,
    handle: RunHandle | null,
    meta: Record<string, unknown>,
  ): Promise<void> => {
    const total = current.chunks.length;
    current.joinNote = null;
    let blob: Blob;
    try {
      bar.update(0, 100, 'Joining the parts…');
      ui.status('Joining the parts…');
      const { stitchAudio } = await import('../../core/media/stitch');
      blob = await stitchAudio(
        current.chunks.map((chunk) => chunk.blob!),
        current.format,
        {
          signal,
          onProgress: (ratio) =>
            setProgress(ratio, `Joining the parts… ${Math.round(ratio * 100)}%`),
          onLoadProgress: ({ loaded, total: bytes }) =>
            setProgress(
              bytes ? loaded / bytes : 0,
              `Loading the MP3 encoder… ${formatBytes(loaded)}`,
            ),
        },
      );
    } catch (error) {
      if (isStop(error) || signal.aborted) {
        current.joinNote = 'Joining was stopped.';
        ui.status(`Stopped while joining · all ${plural(total, 'part')} kept`);
      } else {
        const bad = await findBadParts(current, signal);
        current.joinNote = bad > 0 ? null : `Joining failed: ${userMessage(error)}`;
        ui.status(
          bad > 0
            ? `Joining failed: ${plural(bad, 'part')} could not be decoded`
            : 'Joining failed · every part kept',
        );
      }
      if (handle) await handle.fail(error);
      throw error;
    }
    // A length that cannot be read is left out, never shown as 0:00.
    const seconds = await getAudioDuration(blob).then(
      (value) => (Number.isFinite(value) && value > 0 ? value : null),
      () => null,
    );
    addTake(blob, {
      stem: current.stem,
      format: current.format,
      voice: current.voice,
      seconds,
    });
    const summary =
      seconds === null
        ? `Generated the audio, ${plural(total, 'part')}`
        : `Generated ${formatDuration(seconds)} of audio, ${plural(total, 'part')}`;
    ui.status(summary);
    // Complete: the parts are no longer needed (the take keeps only the joined audio).
    releasePlan(current);
    if (plan === current) plan = null;
    if (handle) {
      await handle.finish({
        output: summary,
        meta: {
          chunks: total,
          seconds: seconds === null ? null : Math.round(seconds * 10) / 10,
          voice: current.voice,
          format: current.format,
          ...meta,
        },
      });
    }
  };

  /**
   * The plan for `value`. A part of `previous` made with the same model, voice and speed from exactly the same
   * words is taken over as made (paid for once): editing one paragraph remakes that part only.
   */
  const newPlan = (
    value: string,
    model: string,
    info: ModelInfo | undefined,
    previous: Plan | null,
  ): Plan => {
    const chosenSpeed = speedFor(info);
    const chosenVoice = voiceFor(info);
    const made = new Map<string, Blob[]>();
    if (
      previous &&
      previous.model === model &&
      previous.voice === chosenVoice &&
      previous.speed === chosenSpeed
    ) {
      for (const chunk of previous.chunks) {
        if (chunk.status === 'done' && chunk.blob) {
          made.set(chunk.text, [...(made.get(chunk.text) ?? []), chunk.blob]);
        }
      }
    }
    return {
      model,
      voice: chosenVoice,
      speed: chosenSpeed,
      format: currentFormat(),
      stem: sanitizeFilename(fileStem(value), 'speech'),
      source: value,
      joinNote: null,
      chunks: splitText(value, limitFor(value, info, chosenSpeed)).map((chunkText, index) => {
        const blob = made.get(chunkText)?.shift() ?? null;
        return {
          key: String(index),
          index,
          text: chunkText,
          status: blob ? 'done' : 'queued',
          blob,
          failure: null,
          cause: null,
        };
      }),
    };
  };

  /** Joins the current plan without making anything (Join again, or a continued plan with every part made). */
  const joinOnly = async (current: Plan, signal: AbortSignal): Promise<void> => {
    running = true;
    bar.element.hidden = false;
    showEmpty();
    renderNotice();
    try {
      await joinPlan(current, signal, null, {});
    } finally {
      running = false;
      bar.element.hidden = true;
      showEmpty();
      renderNotice();
    }
  };

  const run = async (signal: AbortSignal, arg?: RunArg): Promise<void> => {
    if (arg && 'join' in arg) {
      if (plan && missing(plan).length === 0) {
        plan.format = currentFormat();
        await joinOnly(plan, signal);
      }
      return;
    }

    let target: Plan;
    let todo: Chunk[];
    let continued = false;
    let previous: Plan | null = null;
    if (arg) {
      if (!plan) return;
      target = plan;
      // The format is the one setting that may change without remaking a part: the join follows the form.
      target.format = currentFormat();
      todo = plan.chunks.filter(
        (chunk) => arg.parts.includes(chunk.key) && chunk.status !== 'done',
      );
      if (todo.length === 0) {
        if (missing(plan).length === 0) await joinOnly(plan, signal);
        return;
      }
    } else {
      const value = normalizeText(text.value);
      if (!value) {
        ui.status('Add some text first.');
        text.focus();
        return;
      }
      const model = ctx.model().model;
      if (!model) return;
      // Wait for the catalog: a model that lists voices must be sent one.
      const info = await infoFor(model);
      previous = plan;
      // Parts made earlier from the same words, model, voice and speed are kept: only the rest is made.
      target = newPlan(value, model, info, previous);
      const kept = target.chunks.length - missing(target).length;
      continued = kept > 0;
      // Paid parts that are not joined yet and cannot be kept would be thrown away: ask first.
      const lost = previous ? madeCount(previous) - kept : 0;
      if (
        lost > 0 &&
        !(await ui.confirmDiscard({
          what: `${plural(lost, 'paid speech part')} not joined yet`,
          title: 'Replace the parts already made?',
          testId: 'tts-discard-dialog',
        }))
      ) {
        return;
      }
      todo = missing(target);
      if (continued && todo.length === 0) {
        releasePlan(plan);
        plan = target;
        await joinOnly(target, signal);
        return;
      }
    }

    const total = target.chunks.length;
    const extra = arg !== undefined || continued;
    // Refused before anything was sent (no key, locked, free-only, budget, Cancel): nothing changes.
    const handle = await ctx.beginRun(
      {
        model: target.model,
        settings: planSettings(target),
        ...(extra
          ? {
              // The same words again (or a retry) is no new Recent prompt; edited words are.
              ...(arg || previous?.source === target.source
                ? {
                    title: `${arg ? 'Retry' : 'Continue'}: ${plural(todo.length, 'part')} of ${target.stem}`,
                    prompt: '',
                  }
                : {}),
              estimateUsd: await estimateText(
                todo.map((chunk) => chunk.text).join(' '),
                target.model,
              ).catch(() => null),
            }
          : {}),
      },
      signal,
    );

    if (plan !== target) {
      releasePlan(plan);
      plan = target;
    }
    running = true;
    target.joinNote = null;
    for (const chunk of todo) {
      Object.assign(chunk, { status: 'queued', blob: null, failure: null, cause: null });
    }
    const showMade = (first = false): void => {
      const made = madeCount(target);
      bar.update(made, total, `${made} of ${plural(total, 'part')} made`);
      const text = `Reading aloud: ${made} of ${plural(total, 'part')}`;
      if (first) ui.status(text);
      else ui.progress(text);
      syncHold();
    };
    bar.element.hidden = false;
    showEmpty();
    renderNotice();
    if (continued) {
      ui.status(`Continuing: ${plural(total - todo.length, 'part')} made earlier are kept`);
    }
    showMade(!continued);
    try {
      try {
        await runItems({
          items: todo,
          concurrency: CONCURRENCY,
          signal: handle.signal,
          work: (chunk, itemSignal) => synthesize(handle, target, chunk, itemSignal),
          onItem: (outcome) => {
            const chunk = outcome.item;
            chunk.status = outcome.status;
            if (outcome.status === 'done') chunk.blob = outcome.value ?? null;
            if (outcome.status === 'failed') {
              chunk.failure = outcome.failure ?? null;
              chunk.cause = outcome.error;
            }
            if (outcome.status === 'done' || outcome.status === 'failed') {
              showMade();
              void handle
                .checkpoint({
                  output: () => `Made ${madeCount(target)} of ${plural(total, 'part')}.`,
                })
                .catch(() => undefined);
            }
          },
        });
      } catch (error) {
        ui.status(
          isStop(error)
            ? `Stopped · ${madeCount(target)} of ${plural(total, 'part')} made`
            : 'Failed',
        );
        await handle.fail(error);
        throw error;
      }

      const left = missing(target);
      if (left.length > 0) {
        const summary = `Made ${madeCount(target)} of ${plural(total, 'part')}; ${left.length} failed.`;
        ui.status(summary);
        await handle.finish({ output: summary, meta: { parts: total, failed: left.length } });
        return;
      }
      await joinPlan(target, handle.signal, handle, {
        ...(arg ? { retried: todo.length } : {}),
        ...(continued ? { continued: todo.length } : {}),
      });
    } finally {
      running = false;
      bar.element.hidden = true;
      showEmpty();
      renderNotice();
    }
  };

  const runner = ui.runner<RunArg>({ label: 'Read aloud', icon: 'volume-up', run });
  // A notice button that starts a run disappears with the notice: focus goes to Stop (or back to Run).
  const gate = retryGate(runner, {
    fallback: () => (runner.busy ? runner.stopButton : runner.button),
  });

  // --- files and text in ----------------------------------------------------------------------------------
  const addText = (incoming: string, label: string): void => {
    const value = incoming.trim();
    if (!value) {
      ui.status(`${label} has no text.`);
      return;
    }
    text.value = text.value.trim() ? `${text.value.trimEnd()}\n\n${value}` : value;
    updateCounts();
    void ui.refreshEstimate();
    ui.status(`Added ${label} (${plural(countWords(value), 'word')}).`);
  };

  const addFiles = async (files: File[]): Promise<void> => {
    const skipped = files.filter((file) => !isText(file));
    if (skipped.length > 0)
      ui.status(`${plural(skipped.length, 'file')} skipped: only text files are read.`);
    try {
      for (const file of files.filter(isText)) {
        const raw = await readAsText(file);
        addText(isMarkdown(file.type, file.name) ? await stripMarkdown(raw) : raw, file.name);
      }
    } catch (error) {
      void presentError(error);
    }
  };

  /** The form's settings; a voice the model does not list is left out once the catalog has answered. */
  const settings = () => {
    const keepVoice = voiceValue !== '' && (!modelKnown || voices().includes(voiceValue));
    return {
      ...(keepVoice ? { voice: voiceValue } : {}),
      speed: Number(speed.value),
      format: currentFormat(),
    };
  };

  renderVoices();
  void syncModel();

  return {
    getState: () => ({ prompt: text.value, settings: settings() }),
    applyState: ({ prompt, settings: state }) => {
      text.value = prompt;
      if (typeof state['voice'] === 'string') {
        voiceValue = state['voice'];
        if (voices().includes(voiceValue)) voice.value = voiceValue;
        else if (modelKnown) renderVoices();
      }
      const savedRate = state['speed'];
      if (typeof savedRate === 'number' && savedRate >= SPEED_MIN && savedRate <= SPEED_MAX) {
        speed.value = String(savedRate);
        showSpeed();
      }
      if (isFormat(state['format'])) format.value = state['format'];
      updateCounts();
      updatePreviewNote();
      void ui.refreshEstimate();
    },
    estimate: (model) => estimateText(normalizeText(text.value), model),
    onFiles: (files) => void addFiles(files),
    onReceive: (items) => {
      void (async () => {
        for (const item of items) {
          if (item.kind === 'text') {
            const label = item.name ?? 'the text';
            addText(
              isMarkdown(item.type, item.name) ? await stripMarkdown(item.text) : item.text,
              label,
            );
          } else if (isTextFile(item.blob.type, item.name)) {
            const raw = await readAsText(item.blob);
            addText(
              isMarkdown(item.blob.type, item.name) ? await stripMarkdown(raw) : raw,
              item.name,
            );
          }
        }
      })().catch((error: unknown) => void presentError(error));
    },
    sample: () => {
      text.value =
        'ORtoolbox reads your text aloud in the voice you choose. Long texts are split into pieces, read a few at a time and joined into one file, with no gaps between them.';
      updateCounts();
      void ui.refreshEstimate();
    },
  };
}
