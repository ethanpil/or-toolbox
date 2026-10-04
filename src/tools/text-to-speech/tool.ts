/**
 * Text-to-speech: text (typed, pasted, a TXT/MD file or sent from another tool) read aloud in a chosen voice.
 *
 * One run per Run press. Long text is split under the model's limit (text.ts), the chunks are synthesised a few
 * at a time with `runItems`, and the pieces are joined gaplessly with `stitchAudio` into one MP3 or WAV (PCM-only
 * models are wrapped as WAV first). A chunk that fails, or that Stop left unmade, can be retried on its own:
 * the chunks already made are kept until the audio is complete. Voice previews read a short sentence, once per
 * model, voice and speed, and stay in memory for the session.
 */
import { defaultSpeechFormat } from '../../core/api/client';
import type { SpeechResult } from '../../core/api/types';
import { userMessage } from '../../core/errors';
import { readAsText, sanitizeFilename } from '../../core/files';
import { getAudioDuration } from '../../core/media/audio';
import { pcmToWav } from '../../core/media/wav';
import type { ModelInfo, RunHandle } from '../../core/types';
import { debounce } from '../../core/util';
import { audioPlayer, type AudioPlayer } from '../../ui/components/audio-player';
import { dropZone } from '../../ui/components/drop-zone';
import { emptyState } from '../../ui/components/empty-state';
import { exportMenu } from '../../ui/components/export-menu';
import { h, replaceWith } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { isStop, presentError } from '../../ui/feedback/errors';
import { formatBytes, formatDuration, formatInt, formatUsd, plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import { type ItemStatus, runItems } from '../../ui/tool/batch';
import type {
  ResultHandle,
  RunnerState,
  SendItem,
  ToolContext,
  ToolInstance,
} from '../../ui/tool/index';
import { countWords, normalizeText, splitText, stripMarkdown } from './text';
import { chunkLimit, PREVIEW_TEXT, speedSupported, voiceLabel } from './voices';

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

interface Chunk {
  key: string;
  index: number;
  text: string;
  status: ItemStatus;
  blob: Blob | null;
  error: string | null;
}

/** What one Read aloud press asked for; a retry finishes it with exactly these settings. */
interface Plan {
  model: string;
  voice: string | null;
  speed: number | null;
  format: Format;
  /** File name stem, from the first words of the text. */
  stem: string;
  chunks: Chunk[];
}

interface Take {
  handle: ResultHandle;
  player: AudioPlayer;
  element: HTMLElement;
}

const isTextFile = (type: string, name: string): boolean =>
  type.startsWith('text/') || /\.(txt|md|markdown)$/i.test(name);
const isText = (file: File): boolean => isTextFile(file.type, file.name);
const isMarkdown = (type: string | undefined, name = ''): boolean =>
  type === 'text/markdown' || /\.(md|markdown)$/i.test(name);

/** `speech-hello-there-friend`: a file name stem from the first words. */
function stemFor(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .slice(0, 4)
    .join('-');
  return sanitizeFilename(words ? `speech-${words}` : 'speech', 'speech');
}

/** A chunk's audio as something `stitchAudio` decodes: MP3 as it came, raw PCM wrapped as WAV. */
async function toSegment(result: SpeechResult): Promise<Blob> {
  if (result.mimeType !== 'audio/pcm') return result.blob;
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  return pcmToWav(bytes, result.sampleRate ?? DEFAULT_PCM_RATE, result.channels ?? 1);
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
  /** The chosen voice id ('' when the model lists none). */
  let voiceValue = '';
  let modelGeneration = 0;

  const savedVoices = (): Record<string, string> => {
    const value = ctx.options.get()['voices'];
    return value && typeof value === 'object' ? (value as Record<string, string>) : {};
  };
  const voices = (): readonly string[] => modelInfo?.supportedVoices ?? [];
  const canSpeed = (): boolean => (modelInfo ? speedSupported(modelInfo) : false);
  const currentVoice = (): string | null => (voices().length > 0 ? voiceValue : null);
  const currentSpeed = (): number | null => {
    const value = Number(speed.value);
    return canSpeed() && value !== 1 ? value : null;
  };

  const renderVoices = (): void => {
    const list = voices();
    if (list.length > 0) {
      const remembered = modelId ? savedVoices()[modelId] : undefined;
      if (!list.includes(voiceValue)) {
        voiceValue = remembered && list.includes(remembered) ? remembered : list[0]!;
      }
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
  const syncModel = async (force = false): Promise<void> => {
    const next = ctx.model().model;
    if (next === modelId && !force) return;
    const mine = ++modelGeneration;
    modelId = next;
    const info = next ? await ctx.models.get(next).catch(() => undefined) : undefined;
    if (mine !== modelGeneration) return;
    modelInfo = info;
    renderVoices();
    updateCounts();
  };
  ctx.settings.subscribe(() => void syncModel());
  ctx.bus.on('models-refreshed', () => void syncModel(true));

  // --- counts and estimate --------------------------------------------------------------------------------
  const updateCounts = (): void => {
    const value = normalizeText(text.value);
    if (!value) {
      counts.textContent = 'No text yet.';
      return;
    }
    const requests = splitText(value, chunkLimit(modelInfo)).length;
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
    modelId ? `${modelId}|${currentVoice() ?? ''}|${currentSpeed() ?? 1}` : null;
  let previewing = false;
  let noteGeneration = 0;

  const updatePreviewNote = (): void => {
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
    void estimateText(PREVIEW_TEXT, modelId)
      .catch(() => null)
      .then((usd) => {
        if (mine !== noteGeneration) return;
        const cost = usd === null ? 'cost unknown' : usd === 0 ? 'free' : `about ${formatUsd(usd)}`;
        previewNote.textContent = `Preview reads one short sentence (${cost}).`;
      });
  };

  const playPreview = (url: string): void => {
    previewAudio.src = url;
    previewAudio.hidden = false;
    void previewAudio.play().catch(() => undefined); // a blocked autoplay leaves the controls to the user
  };

  const preview = async (): Promise<void> => {
    const key = previewKey();
    const model = modelId;
    if (!key || !model || previewing) return;
    const cached = previews.get(key);
    if (cached) {
      playPreview(cached);
      announce('Playing the preview.');
      return;
    }
    const chosenVoice = currentVoice();
    const chosenSpeed = currentSpeed();
    previewing = true;
    previewButton.disabled = true;
    previewButton.setAttribute('aria-busy', 'true');
    previewNote.textContent = 'Making the preview…';
    try {
      const run = await ctx.beginRun({
        model,
        title: `Voice preview: ${chosenVoice ? voiceLabel(chosenVoice) : "the model's own voice"}`,
        // No prompt: a preview is not a Recent prompt.
        prompt: '',
        settings: { voice: chosenVoice ?? '', speed: chosenSpeed ?? 1, preview: true },
        estimateUsd: await estimateText(PREVIEW_TEXT, model).catch(() => null),
        addons: [],
      });
      try {
        const result = await ctx.api.speech(
          {
            model,
            input: PREVIEW_TEXT,
            ...(chosenVoice ? { voice: chosenVoice } : {}),
            ...(chosenSpeed !== null ? { speed: chosenSpeed } : {}),
          },
          { run },
        );
        const url = URL.createObjectURL(await toSegment(result));
        await run.finish({ output: PREVIEW_TEXT, meta: { preview: true } });
        previews.set(key, url);
        if (previewKey() === key) playPreview(url);
      } catch (error) {
        await run.fail(error);
        throw error;
      }
    } catch (error) {
      if (!isStop(error)) void presentError(error, { retry: () => void preview() });
    } finally {
      previewing = false;
      previewButton.disabled = false;
      previewButton.removeAttribute('aria-busy');
      updatePreviewNote();
    }
  };

  // --- output zone ----------------------------------------------------------------------------------------
  const progressBar = h('div', { class: 'progress-bar' });
  const progress = h(
    'div',
    {
      class: 'progress',
      role: 'progressbar',
      'aria-label': 'Progress',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '0',
      'data-testid': 'tts-progress',
    },
    progressBar,
  );
  const progressText = h('div', {
    class: 'small text-body-secondary',
    'data-testid': 'tts-progress-text',
  });
  const progressSection = h('div', { class: 'vstack gap-2', hidden: true }, progress, progressText);
  const notice = h('div', { hidden: true, 'data-testid': 'tts-notice' });
  const empty = emptyState({
    icon: 'volume-up',
    title: 'No audio yet',
    text: 'Add text, choose a voice and press Read aloud.',
    testId: 'tts-empty',
  });
  const takesList = h('div', { class: 'vstack gap-3', 'data-testid': 'tts-results' });
  ui.output.append(h('div', { class: 'vstack gap-3' }, progressSection, notice, empty, takesList));

  const takes: Take[] = [];
  const setProgress = (ratio: number, label: string): void => {
    const percent = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
    progressBar.style.width = `${percent}%`;
    progress.setAttribute('aria-valuenow', String(percent));
    progressText.textContent = label;
  };
  const showEmpty = (): void => {
    empty.hidden = takes.length > 0 || !progressSection.hidden;
  };

  const transcode = async (blob: Blob, to: Format): Promise<Blob> =>
    (await import('../../core/media/ffmpeg-ops')).transcodeAudio(blob, to);

  const addTake = (blob: Blob, plan: Plan, seconds: number): void => {
    const name = `${plan.stem}.${plan.format}`;
    const handle = ui.addResult({ kind: 'audio', name, blob });
    const player = audioPlayer({
      blob,
      label: `${name}, ${formatDuration(seconds)}`,
      testId: 'tts-player',
    });
    const menu = exportMenu({
      filename: plan.stem,
      resultIds: () => [handle.result.id],
      testId: 'tts-download',
      formats: (['mp3', 'wav'] as const).map((id) => ({
        label: id === 'mp3' ? 'MP3' : 'WAV',
        extension: id,
        icon: 'file-earmark-music',
        build: () => (id === plan.format ? blob : transcode(blob, id)),
      })),
    });
    const item: Take = { handle, player, element: h('div') };
    const remove = (): void => {
      handle.remove();
      player.dispose();
      item.element.remove();
      takes.splice(takes.indexOf(item), 1);
      showEmpty();
      announce(`Removed ${name}.`);
    };
    const send: SendItem[] = [{ kind: 'file', blob, name }];
    item.element = h(
      'article',
      { class: 'border rounded p-3 vstack gap-2', 'data-testid': 'tts-result' },
      h(
        'div',
        { class: 'd-flex flex-wrap align-items-baseline gap-2' },
        h('h3', { class: 'h6 mb-0 text-break me-auto' }, name),
        h(
          'span',
          { class: 'small text-body-secondary', 'data-testid': 'tts-result-meta' },
          [
            formatDuration(seconds),
            plan.voice ? voiceLabel(plan.voice) : "The model's own voice",
            formatBytes(blob.size),
          ].join(' · '),
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
            'data-testid': 'tts-send',
            onclick: () => ui.sendTo(send),
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
            'data-testid': 'tts-remove',
            onclick: remove,
          },
          icon('trash'),
          'Remove',
        ),
      ),
    );
    takes.unshift(item);
    takesList.prepend(item.element);
    showEmpty();
  };

  // --- running --------------------------------------------------------------------------------------------
  let plan: Plan | null = null;
  let running = false;
  let runnerState: RunnerState = { busy: false, disabledReason: null };

  const missing = (current: Plan): Chunk[] =>
    current.chunks.filter((chunk) => chunk.status !== 'done');

  const renderNotice = (): void => {
    const left = plan && !running ? missing(plan) : [];
    notice.hidden = left.length === 0;
    if (!plan || left.length === 0) {
      replaceWith(notice, null);
      return;
    }
    const failed = left.filter((chunk) => chunk.status === 'failed');
    const blocked = runnerState.busy
      ? 'Wait until the current run ends.'
      : runnerState.disabledReason;
    const total = plan.chunks.length;
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
          h(
            'button',
            {
              type: 'button',
              class: ['btn btn-sm btn-warning', blocked && 'disabled'],
              'aria-disabled': String(blocked !== null),
              title: blocked ?? '',
              'data-focus-key': 'tts-retry',
              'data-testid': 'tts-retry',
              onclick: () => {
                const keys = missing(plan!).map((chunk) => chunk.key);
                if (!runner.trigger(keys).started) announce(blocked ?? 'Cannot start now.');
              },
            },
            failed.length > 0
              ? `Retry ${plural(left.length, 'part')}`
              : `Make the other ${left.length}`,
          ),
        ),
        failed.length > 0
          ? h(
              'ul',
              { class: 'small mb-0', 'data-testid': 'tts-failed' },
              failed
                .slice(0, 5)
                .map((chunk) =>
                  h('li', null, `Part ${chunk.index + 1}: ${chunk.error ?? 'failed'}`),
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
    return toSegment(result);
  };

  const join = async (current: Plan, signal: AbortSignal): Promise<Blob> => {
    setProgress(0, 'Joining the parts…');
    const { stitchAudio } = await import('../../core/media/stitch');
    return stitchAudio(
      current.chunks.map((chunk) => chunk.blob!),
      current.format,
      {
        signal,
        onProgress: (ratio) => setProgress(ratio, `Joining the parts… ${Math.round(ratio * 100)}%`),
        onLoadProgress: ({ loaded, total }) =>
          setProgress(
            total ? loaded / total : 0,
            `Loading the MP3 encoder… ${formatBytes(loaded)}`,
          ),
      },
    );
  };

  const planFor = async (value: string, model: string): Promise<Plan> => {
    const info = model === modelId ? modelInfo : await ctx.models.get(model).catch(() => undefined);
    return {
      model,
      voice: currentVoice(),
      speed: currentSpeed(),
      format: isFormat(format.value) ? format.value : 'mp3',
      stem: stemFor(value),
      chunks: splitText(value, chunkLimit(info)).map((chunkText, index) => ({
        key: String(index),
        index,
        text: chunkText,
        status: 'queued',
        blob: null,
        error: null,
      })),
    };
  };

  const run = async (signal: AbortSignal, keys?: string[]): Promise<void> => {
    const retry = keys !== undefined;
    const value = normalizeText(text.value);
    if (!retry && !value) {
      ui.status('Add some text first.');
      text.focus();
      return;
    }
    const model = ctx.model().model;
    if (!retry && !model) return;
    const target = retry ? plan : await planFor(value, model!);
    if (!target) return;
    const todo = retry ? target.chunks.filter((chunk) => keys.includes(chunk.key)) : target.chunks;
    if (todo.length === 0) return;

    // Refused before anything was sent (no key, locked, free-only, budget, Cancel): nothing changes.
    const handle = await ctx.beginRun(
      retry
        ? {
            model: target.model,
            title: `Retry: ${plural(todo.length, 'part')} of ${target.stem}`,
            prompt: '',
            estimateUsd: await estimateText(
              todo.map((chunk) => chunk.text).join(' '),
              target.model,
            ).catch(() => null),
          }
        : {},
      signal,
    );

    plan = target;
    running = true;
    for (const chunk of todo) Object.assign(chunk, { status: 'queued', blob: null, error: null });
    const total = target.chunks.length;
    const made = (): number => target.chunks.filter((chunk) => chunk.status === 'done').length;
    const showMade = (): void => {
      setProgress(made() / total, `${made()} of ${plural(total, 'part')} made`);
      ui.status(`Reading aloud: ${made()} of ${plural(total, 'part')}`);
    };
    progressSection.hidden = false;
    showEmpty();
    renderNotice();
    showMade();
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
          if (outcome.status === 'failed') chunk.error = userMessage(outcome.error);
          if (outcome.status === 'done' || outcome.status === 'failed') {
            showMade();
            void handle
              .checkpoint({ output: () => `Made ${made()} of ${plural(total, 'part')}.` })
              .catch(() => undefined);
          }
        },
      });

      const left = missing(target);
      if (left.length > 0) {
        const summary = `Made ${made()} of ${plural(total, 'part')}; ${left.length} failed.`;
        ui.status(summary);
        await handle.finish({ output: summary, meta: { parts: total, failed: left.length } });
        return;
      }

      const blob = await join(target, handle.signal);
      const seconds = await getAudioDuration(blob).catch(() => 0);
      addTake(blob, target, seconds);
      const summary = `Generated ${formatDuration(seconds)} of audio, ${plural(total, 'part')}`;
      ui.status(summary);
      announce('The audio is ready.');
      plan = null; // complete: the parts are no longer needed
      await handle.finish({
        output: summary,
        meta: {
          chunks: total,
          seconds: Math.round(seconds * 10) / 10,
          voice: target.voice,
          format: target.format,
          ...(retry ? { retried: todo.length } : {}),
        },
      });
    } catch (error) {
      ui.status(isStop(error) ? `Stopped · ${made()} of ${plural(total, 'part')} made` : 'Failed');
      await handle.fail(error);
      throw error;
    } finally {
      running = false;
      progressSection.hidden = true;
      showEmpty();
      renderNotice();
    }
  };

  const runner = ui.runner<string[]>({ label: 'Read aloud', icon: 'volume-up', run });
  runner.subscribe((state) => {
    runnerState = state;
    renderNotice();
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

  const settings = () => ({
    voice: voiceValue,
    speed: Number(speed.value),
    format: isFormat(format.value) ? format.value : 'mp3',
  });

  void syncModel();

  return {
    getState: () => ({ prompt: text.value, settings: settings() }),
    applyState: ({ prompt, settings: state }) => {
      text.value = prompt;
      if (typeof state['voice'] === 'string') {
        voiceValue = state['voice'];
        if (voices().includes(voiceValue)) voice.value = voiceValue;
        else if (modelInfo) renderVoices();
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
