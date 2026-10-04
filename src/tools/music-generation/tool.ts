/**
 * Music generation: a song form (style, vocals or instrumental, lyrics with section tags, an optional reference
 * image) turned into a Lyria prompt, streamed back as one MP3 per variation with its timed lyrics.
 *
 * Lyria ignores lengths (docs/openrouter-api.md §6.2): Clip makes about 30 seconds and Pro about 3 minutes
 * whatever the prompt says, so a target length is applied afterwards in the browser (`trimMedia`, with a short
 * fade-out). Variations are one run with one request per variation (`runItems`, all at once): one Run press is
 * one History entry and one budget decision, and the estimate is the flat price times the count. A variation
 * that fails does not take the others with it. The free-only notice comes from the framework: no music model
 * is free.
 */
import { base64ToBlob } from '../../core/api/encoding';
import { ApiError, isAbortError, userMessage } from '../../core/errors';
import { getAudioDuration } from '../../core/media/audio';
import type { RunHandle } from '../../core/types';
import { audioPlayer, type AudioPlayer } from '../../ui/components/audio-player';
import { dropZone } from '../../ui/components/drop-zone';
import { emptyState } from '../../ui/components/empty-state';
import { exportMenu } from '../../ui/components/export-menu';
import { h, replace } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { isStop } from '../../ui/feedback/errors';
import { setFieldError } from '../../ui/feedback/field-error';
import { formatBytes, formatDateTime, formatDuration, formatUsd, plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import { setToolBinding } from '../../ui/settings-actions';
import { type ItemStatus, runItems } from '../../ui/tool/batch';
import type { ResultHandle, ToolContext, ToolInstance } from '../../ui/tool/index';
import {
  activeLine,
  insertTag,
  lyricsText,
  parseTimedLyrics,
  SECTION_TAGS,
  type TimedLyrics,
  validateLyrics,
} from './lyrics';
import { buildPrompt, isVocals, type SongForm, songRequest, type Vocals } from './prompt';

/** The two Lyria models, with the length each always makes (§6.2). */
const LENGTHS = [
  {
    id: 'google/lyria-3-clip-preview',
    name: 'Clip',
    model: 'Lyria 3 Clip',
    wait: 'about 10 seconds',
    detail: 'about 30 seconds: a jingle, a loop or a preview',
  },
  {
    id: 'google/lyria-3-pro-preview',
    name: 'Song',
    model: 'Lyria 3 Pro',
    wait: 'about a minute',
    detail: 'about 3 minutes, with verses, choruses and a bridge',
  },
] as const;
const CLIP_ID = LENGTHS[0].id;

const VARIATIONS = [1, 2, 3] as const;
const MIN_TARGET = 5;
const MAX_TARGET = 600;
/** Seconds of fade-out at a cut. */
const FADE_SECONDS = 2;
/** Lyria's MP3s are 192 kbit/s; a cut keeps that. */
const MP3_BITRATE = 192;
/** Reference images are scaled down to this before upload: plenty to set a mood. */
const IMAGE_MAX_SIDE = 1024;

interface Song {
  blob: Blob;
  seconds: number;
  /** Length before the cut, when it was cut. */
  fullSeconds: number | null;
  /** Why a cut that was asked for did not happen. */
  trimNote: string | null;
  lyrics: TimedLyrics;
}

interface Variation {
  index: number;
  status: ItemStatus;
  phase: string;
  song: Song | null;
  error: string | null;
  card: HTMLElement;
  handle: ResultHandle | null;
  player: AudioPlayer | null;
}

const isVariationCount = (value: unknown): value is (typeof VARIATIONS)[number] =>
  VARIATIONS.includes(value as (typeof VARIATIONS)[number]);
const isTarget = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= MIN_TARGET &&
  value <= MAX_TARGET;

export function setup(ctx: ToolContext): ToolInstance {
  const { ui } = ctx;
  const saved = ctx.options.get();
  const ids = {
    description: uid('music-description'),
    genre: uid('music-genre'),
    mood: uid('music-mood'),
    tempo: uid('music-tempo'),
    instruments: uid('music-instruments'),
    voice: uid('music-voice'),
    lyrics: uid('music-lyrics'),
    lyricsHelp: uid('music-lyrics-help'),
    lengthNote: uid('music-length-note'),
    variations: uid('music-variations'),
    target: uid('music-target'),
    targetHelp: uid('music-target-help'),
    preview: uid('music-preview'),
  };

  // --- song form ------------------------------------------------------------------------------------------
  const field = (
    id: string,
    label: string,
    placeholder: string,
    testId: string,
  ): { input: HTMLInputElement; element: HTMLElement } => {
    const input = h('input', {
      id,
      type: 'text',
      class: 'form-control',
      placeholder,
      autocomplete: 'off',
      'data-testid': testId,
    });
    return {
      input,
      element: h(
        'div',
        { class: 'col-sm-6' },
        h('label', { class: 'form-label', htmlFor: id }, label),
        input,
      ),
    };
  };

  const description = h('textarea', {
    id: ids.description,
    class: 'form-control',
    rows: 3,
    placeholder: 'For example: a hopeful song about a long walk home at dawn',
    'data-testid': 'tool-prompt',
  });
  const genre = field(ids.genre, 'Genre', 'Folk pop', 'music-genre');
  const mood = field(ids.mood, 'Mood', 'Warm, hopeful', 'music-mood');
  const tempo = field(ids.tempo, 'Tempo', '96 BPM, or slow', 'music-tempo');
  const instruments = field(
    ids.instruments,
    'Instruments',
    'Acoustic guitar, piano',
    'music-instruments',
  );

  const vocalsName = uid('music-vocals');
  const vocalsRadio = (
    value: Vocals,
    label: string,
  ): { input: HTMLInputElement; element: HTMLElement } => {
    const id = uid('music-vocals-option');
    const input = h('input', {
      id,
      type: 'radio',
      class: 'form-check-input',
      name: vocalsName,
      value,
      'data-testid': `music-${value}`,
      onchange: () => formChanged(),
    });
    return {
      input,
      element: h(
        'div',
        { class: 'form-check form-check-inline' },
        input,
        h('label', { class: 'form-check-label', htmlFor: id }, label),
      ),
    };
  };
  const withVocals = vocalsRadio('vocals', 'Vocals');
  const instrumental = vocalsRadio('instrumental', 'Instrumental');
  withVocals.input.checked = true;
  const vocals = (): Vocals => (instrumental.input.checked ? 'instrumental' : 'vocals');
  const voice = h('input', {
    id: ids.voice,
    type: 'text',
    class: 'form-control',
    placeholder: 'Warm female vocals',
    autocomplete: 'off',
    'data-testid': 'music-voice',
  });
  const voiceField = h(
    'div',
    null,
    h('label', { class: 'form-label', htmlFor: ids.voice }, 'Singing voice'),
    voice,
  );

  const lyrics = h('textarea', {
    id: ids.lyrics,
    class: 'form-control font-monospace',
    rows: 8,
    placeholder: '[Verse]\nMorning light on the quiet hill\n\n[Chorus]\nCarry me home',
    'aria-describedby': ids.lyricsHelp,
    spellcheck: true,
    'data-testid': 'music-lyrics',
  });
  const lyricsFeedback = h('div', {
    class: 'invalid-feedback',
    'data-testid': 'music-lyrics-error',
  });
  const lyricsWarnings = h('ul', {
    class: 'small text-warning-emphasis ps-3 mb-0 empty-hidden',
    'data-testid': 'music-lyrics-warnings',
  });
  const tagButtons = SECTION_TAGS.map((tag) =>
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm btn-outline-secondary',
        'aria-label': `Insert a ${tag} tag`,
        'data-testid': `music-tag-${tag.toLowerCase()}`,
        onclick: () => {
          const { value, cursor } = insertTag(
            lyrics.value,
            lyrics.selectionStart,
            lyrics.selectionEnd,
            tag,
          );
          lyrics.value = value;
          lyrics.focus();
          lyrics.setSelectionRange(cursor, cursor);
          formChanged();
        },
      },
      `[${tag}]`,
    ),
  );
  const lyricsSection = h(
    'div',
    null,
    h('label', { class: 'form-label fw-semibold', htmlFor: ids.lyrics }, 'Lyrics (optional)'),
    h(
      'div',
      { class: 'd-flex flex-wrap gap-1 mb-2', role: 'group', 'aria-label': 'Section tags' },
      tagButtons,
    ),
    lyrics,
    lyricsFeedback,
    h(
      'div',
      { id: ids.lyricsHelp, class: 'form-text' },
      'Section tags shape the song. Without lyrics, Lyria writes its own.',
    ),
    lyricsWarnings,
  );

  // --- reference image ------------------------------------------------------------------------------------
  let image: { file: File; url: string } | null = null;
  const imageSlot = h('div', { 'data-testid': 'music-image' });
  const renderImage = (): void => {
    if (!image) {
      replace(
        imageSlot,
        dropZone({
          accept: ctx.manifest.accepts,
          compact: true,
          label: 'Drop a reference image (optional)',
          hint: 'PNG, JPEG or WebP: its mood guides the music',
          testId: 'music-image-drop',
          onFiles: (files) => setImage(files[0]),
        }),
      );
      return;
    }
    const current = image;
    replace(
      imageSlot,
      h(
        'div',
        { class: 'd-flex align-items-center gap-3 border rounded p-2' },
        h('img', {
          src: current.url,
          alt: `Reference image: ${current.file.name}`,
          class: 'rounded object-fit-cover',
          width: 64,
          height: 64,
        }),
        h('span', { class: 'small text-break me-auto' }, current.file.name),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm btn-outline-danger',
            'aria-label': `Remove the reference image ${current.file.name}`,
            'data-focus-key': 'music-image-remove',
            'data-testid': 'music-image-remove',
            onclick: () => setImage(undefined),
          },
          icon('x-lg'),
        ),
      ),
    );
  };
  const setImage = (file: File | undefined): void => {
    if (image) URL.revokeObjectURL(image.url);
    image = file ? { file, url: URL.createObjectURL(file) } : null;
    renderImage();
    formChanged();
  };
  renderImage();

  // --- length (the model) ---------------------------------------------------------------------------------
  const lengthName = uid('music-length');
  const lengthPrices = new Map<string, number | null>();
  const lengthNote = h('div', {
    id: ids.lengthNote,
    class: 'form-text',
    'data-testid': 'music-length-note',
  });
  const lengthInputs = LENGTHS.map((length) => {
    const id = uid('music-length-option');
    const price = h('span', { class: 'text-body-secondary' });
    const input = h('input', {
      id,
      type: 'radio',
      class: 'form-check-input',
      name: lengthName,
      value: length.id,
      'aria-describedby': ids.lengthNote,
      'data-testid': `music-length-${length.name.toLowerCase()}`,
      onchange: () => {
        if (input.checked) setToolBinding(ctx, ctx.manifest.id, { model: length.id });
      },
    });
    const element = h(
      'div',
      { class: 'form-check' },
      input,
      h(
        'label',
        { class: 'form-check-label', htmlFor: id },
        h('span', { class: 'fw-semibold' }, `${length.name} `),
        `(${length.model}): ${length.detail}`,
        ' ',
        price,
      ),
    );
    return { length, input, price, element };
  });
  const lengthFieldset = h(
    'fieldset',
    null,
    h('legend', { class: 'form-label fw-semibold fs-6 mb-1' }, 'Length'),
    lengthInputs.map((entry) => entry.element),
    lengthNote,
  );

  const syncLength = (): void => {
    const model = ctx.model().model;
    const known = LENGTHS.some((length) => length.id === model);
    for (const entry of lengthInputs) {
      entry.input.checked = entry.length.id === model;
      entry.input.disabled = ctx.modelOverride !== null;
      const usd = lengthPrices.get(entry.length.id);
      entry.price.textContent = usd === undefined || usd === null ? '' : `· ${formatUsd(usd)} each`;
    }
    lengthNote.textContent =
      ctx.modelOverride !== null
        ? 'This visit uses the model from the link you opened; change it with the model button above.'
        : known || !model
          ? 'Lyria always makes this length; set a target length below to cut it shorter.'
          : `The model above (${model}) is not one of these; its length is up to the model.`;
    formChanged();
  };
  ctx.settings.subscribe(syncLength);
  void Promise.all(
    LENGTHS.map(async (length) => {
      lengthPrices.set(
        length.id,
        await ctx.models.estimate({ kind: 'music', model: length.id }).catch(() => null),
      );
    }),
  ).then(syncLength);

  const variations = h(
    'select',
    {
      id: ids.variations,
      class: 'form-select',
      'data-testid': 'music-variations',
      onchange: () => {
        ctx.options.set({ variations: Number(variations.value) });
        void ui.refreshEstimate();
      },
    },
    VARIATIONS.map((count) => h('option', { value: String(count) }, plural(count, 'variation'))),
  );
  variations.value = String(isVariationCount(saved['variations']) ? saved['variations'] : 1);

  const target = h('input', {
    id: ids.target,
    type: 'number',
    class: 'form-control',
    min: String(MIN_TARGET),
    max: String(MAX_TARGET),
    step: '1',
    placeholder: 'Full length',
    inputMode: 'numeric',
    'aria-describedby': ids.targetHelp,
    'data-testid': 'music-target',
    onchange: () => {
      const value = targetSeconds();
      ctx.options.set({ targetSeconds: value });
      formChanged();
    },
  });
  if (isTarget(saved['targetSeconds'])) target.value = String(saved['targetSeconds']);
  const targetFeedback = h('div', { class: 'invalid-feedback' });
  const targetHelp = h(
    'div',
    { id: ids.targetHelp, class: 'form-text' },
    `Seconds. Longer results are cut to this length in your browser, ending with a ${FADE_SECONDS}-second fade-out. Empty keeps the full length.`,
  );
  /** The target in whole seconds, or null for the full length (empty or invalid). */
  const targetSeconds = (): number | null => {
    const value = Number(target.value);
    return target.value.trim() !== '' && isTarget(value) ? value : null;
  };

  ui.input.append(
    h(
      'div',
      null,
      h(
        'label',
        { class: 'form-label fw-semibold', htmlFor: ids.description },
        'Describe the music',
      ),
      description,
    ),
    h('div', { class: 'row g-3' }, genre.element, mood.element, tempo.element, instruments.element),
    h(
      'fieldset',
      { class: 'vstack gap-2' },
      h('legend', { class: 'form-label fw-semibold fs-6 mb-0' }, 'Vocals'),
      h('div', null, withVocals.element, instrumental.element),
      voiceField,
    ),
    lyricsSection,
    imageSlot,
    lengthFieldset,
  );

  ui.drawer.append(
    h(
      'div',
      null,
      h('label', { class: 'form-label', htmlFor: ids.variations }, 'Variations'),
      variations,
      h(
        'div',
        { class: 'form-text' },
        'Each variation is a separate song from the same form, shown side by side, and costs the full price.',
      ),
    ),
    h(
      'div',
      null,
      h('label', { class: 'form-label', htmlFor: ids.target }, 'Target length'),
      target,
      targetFeedback,
      targetHelp,
    ),
  );

  const promptPreview = h('textarea', {
    id: ids.preview,
    class: 'form-control font-monospace small',
    rows: 10,
    readOnly: true,
    'data-testid': 'music-prompt-preview',
  });
  ui.advanced('Prompt preview').append(
    h('label', { class: 'form-label', htmlFor: ids.preview }, 'What is sent to Lyria'),
    promptPreview,
    h(
      'p',
      { class: 'form-text mb-0' },
      'Lyria has no separate settings for style, lyrics or length: the form becomes this text.',
    ),
  );

  // --- form state -----------------------------------------------------------------------------------------
  const form = (): SongForm => ({
    description: description.value,
    genre: genre.input.value,
    mood: mood.input.value,
    tempo: tempo.input.value,
    instruments: instruments.input.value,
    vocals: vocals(),
    voice: voice.value,
    lyrics: lyrics.value,
  });

  /** The error each field shows, so a message is set (and announced) only when it changes. */
  const shownErrors = new Map<HTMLElement, string | null>();
  const showError = (input: HTMLElement, feedback: HTMLElement, message: string | null): void => {
    if ((shownErrors.get(input) ?? null) === message) return;
    shownErrors.set(input, message);
    setFieldError(input, feedback, message);
  };
  /** Re-checks the lyrics and the target, updates the preview; returns false when something blocks a run. */
  const check = (): boolean => {
    const issues = validateLyrics(lyrics.value, {
      instrumental: vocals() === 'instrumental',
      clip: ctx.model().model === CLIP_ID,
    });
    const errors = issues.filter((issue) => issue.level === 'error').map((issue) => issue.message);
    const lyricsError = errors.length > 0 ? errors.join(' ') : null;
    showError(lyrics, lyricsFeedback, lyricsError);
    replace(
      lyricsWarnings,
      issues
        .filter((issue) => issue.level === 'warning')
        .map((issue) => h('li', null, issue.message)),
    );
    const targetError =
      target.value.trim() !== '' && targetSeconds() === null
        ? `Enter whole seconds from ${MIN_TARGET} to ${MAX_TARGET}, or leave it empty.`
        : null;
    showError(target, targetFeedback, targetError);
    voiceField.hidden = vocals() === 'instrumental';
    promptPreview.value = buildPrompt(form(), image !== null);
    return lyricsError === null && targetError === null;
  };
  function formChanged(): void {
    check();
  }
  for (const input of [
    description,
    genre.input,
    mood.input,
    tempo.input,
    instruments.input,
    voice,
    lyrics,
  ]) {
    input.addEventListener('input', formChanged);
  }

  // --- output zone ----------------------------------------------------------------------------------------
  const empty = emptyState({
    icon: 'music-note-beamed',
    title: 'No music yet',
    text: 'Fill in the form and press Compose. A clip takes about 10 seconds, a full song about a minute.',
    testId: 'music-empty',
  });
  const groups = h('div', { class: 'vstack gap-4', 'data-testid': 'music-results' });
  ui.output.append(empty, groups);
  const showEmpty = (): void => {
    empty.hidden = groups.childElementCount > 0;
  };

  const transcode = async (blob: Blob, to: 'mp3' | 'wav'): Promise<Blob> =>
    (await import('../../core/media/ffmpeg-ops')).transcodeAudio(blob, to);

  /** The lyrics under a player, the line being sung highlighted as it plays. */
  const lyricsPanel = (
    lyricsData: TimedLyrics,
    player: AudioPlayer,
    label: string,
  ): HTMLElement | null => {
    if (lyricsData.lines.length === 0) {
      const text = lyricsData.instrumental
        ? 'Instrumental: no lyrics.'
        : lyricsData.untimed.join('\n');
      return text
        ? h(
            'p',
            {
              class: 'small text-body-secondary mb-0',
              style: { whiteSpace: 'pre-line' },
              'data-testid': 'music-lyrics-plain',
            },
            text,
          )
        : null;
    }
    const items = lyricsData.lines.map((line) =>
      h(
        'li',
        {
          class: ['px-2 py-1 rounded', line.sectionStart && 'mt-2'],
          'data-testid': 'music-lyric-line',
        },
        line.text,
      ),
    );
    // A scroll region (focusable, named) around the list, so the list keeps its own semantics.
    const list = h(
      'div',
      {
        class: 'small overflow-auto position-relative border rounded p-1',
        style: { maxHeight: '14rem' },
        tabIndex: 0,
        role: 'region',
        'aria-label': label,
        'data-testid': 'music-lyrics-panel',
      },
      h('ol', { class: 'list-unstyled mb-0' }, items),
    );
    let current = -1;
    const follow = (): void => {
      const next = activeLine(lyricsData.lines, player.audio.currentTime);
      if (next === current) return;
      const previous = items[current];
      if (previous) {
        previous.classList.remove('bg-primary-subtle', 'text-primary-emphasis', 'fw-semibold');
        previous.removeAttribute('aria-current');
      }
      current = next;
      const item = items[current];
      if (!item) return;
      item.classList.add('bg-primary-subtle', 'text-primary-emphasis', 'fw-semibold');
      item.setAttribute('aria-current', 'true');
      // Scroll the panel only, never the page.
      if (
        item.offsetTop < list.scrollTop ||
        item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight
      ) {
        list.scrollTop = Math.max(0, item.offsetTop - list.clientHeight / 3);
      }
    };
    player.audio.addEventListener('timeupdate', follow);
    player.audio.addEventListener('seeked', follow);
    return list;
  };

  const drawVariation = (variation: Variation, total: number): void => {
    const title = total > 1 ? `Variation ${variation.index + 1}` : 'Result';
    const song = variation.song;
    let body: (HTMLElement | null)[];
    if (song && variation.player && variation.handle) {
      const handle = variation.handle;
      const name = handle.result.name;
      const fileStem = name.replace(/\.mp3$/, '');
      body = [
        h(
          'div',
          { class: 'small text-body-secondary', 'data-testid': 'music-meta' },
          [
            formatDuration(song.seconds),
            song.fullSeconds !== null ? `cut from ${formatDuration(song.fullSeconds)}` : null,
            formatBytes(song.blob.size),
          ]
            .filter(Boolean)
            .join(' · '),
        ),
        song.trimNote
          ? h('div', { class: 'small text-warning-emphasis', role: 'note' }, song.trimNote)
          : null,
        variation.player.element,
        lyricsPanel(song.lyrics, variation.player, `Lyrics of ${title.toLowerCase()}`),
        h(
          'div',
          { class: 'd-flex flex-wrap gap-2 mt-auto' },
          exportMenu({
            filename: fileStem,
            resultIds: () => [handle.result.id],
            testId: 'music-download',
            formats: [
              {
                label: 'MP3',
                extension: 'mp3',
                icon: 'file-earmark-music',
                build: () => song.blob,
              },
              {
                label: 'WAV',
                extension: 'wav',
                icon: 'file-earmark-music',
                build: () => transcode(song.blob, 'wav'),
              },
            ],
          }),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-sm btn-outline-danger d-inline-flex align-items-center gap-1 ms-auto',
              'aria-label': `Remove ${name}`,
              'data-testid': 'music-remove',
              onclick: () => removeVariation(variation),
            },
            icon('trash'),
            'Remove',
          ),
        ),
      ];
    } else if (variation.status === 'queued' || variation.status === 'running') {
      body = [
        h(
          'div',
          {
            class: 'progress',
            role: 'progressbar',
            'aria-label': `${title}: ${variation.phase}`,
            'data-testid': 'music-busy',
          },
          h('div', { class: 'progress-bar progress-bar-striped progress-bar-animated w-100' }),
        ),
        h('div', { class: 'small text-body-secondary' }, variation.phase),
      ];
    } else {
      body = [
        h(
          'div',
          { class: 'small text-danger-emphasis', role: 'note', 'data-testid': 'music-failed' },
          variation.status === 'stopped'
            ? 'Stopped before it was ready.'
            : (variation.error ?? 'It failed.'),
        ),
      ];
    }
    replace(
      variation.card,
      h(
        'div',
        { class: 'card h-100' },
        h('div', { class: 'card-body vstack gap-2' }, h('h4', { class: 'h6 mb-0' }, title), body),
      ),
    );
    variation.card.dataset['status'] = variation.status;
  };

  const removeVariation = (variation: Variation): void => {
    variation.handle?.remove();
    variation.player?.dispose();
    const group = variation.card.closest('section');
    variation.card.remove();
    if (group && !group.querySelector('[data-testid="music-variation"]')) group.remove();
    showEmpty();
    announce('Removed.');
  };

  // --- running --------------------------------------------------------------------------------------------
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;

  const compose = async (
    run: RunHandle,
    prompt: string,
    imageUrl: string | null,
    variation: Variation,
    total: number,
    targetLength: number | null,
    signal: AbortSignal,
  ): Promise<Song> => {
    const phase = (text: string): void => {
      variation.phase = text;
      drawVariation(variation, total);
    };
    const result = await ctx.api.chatStream(songRequest(run.model, prompt, imageUrl), {
      run,
      signal,
      onEvent: (event) => {
        if (event.type === 'audio') phase('Putting the audio together…');
      },
    });
    if (result.audioChunks.length === 0) {
      throw new ApiError('Lyria answered without any audio. Try again.', 502, {});
    }
    // Lyria sends the whole MP3 as one base64 fragment; join any others before decoding once.
    const { blob: full } = base64ToBlob(result.audioChunks.join(''), 'audio/mpeg');
    const lyricsData = parseTimedLyrics(result.text);
    const fullSeconds = await getAudioDuration(full).catch(() => 0);
    if (targetLength === null || !(fullSeconds > targetLength + 0.5)) {
      return {
        blob: full,
        seconds: fullSeconds,
        fullSeconds: null,
        trimNote: null,
        lyrics: lyricsData,
      };
    }
    // The song is paid for: if the cut fails (or Stop lands here), keep it whole and say so.
    phase(`Cutting it to ${formatDuration(targetLength)}…`);
    try {
      const { trimMedia } = await import('../../core/media/ffmpeg-ops');
      const blob = await trimMedia(full, 0, targetLength, {
        kind: 'audio',
        fadeOut: FADE_SECONDS,
        bitrate: MP3_BITRATE,
        signal,
      });
      return {
        blob,
        seconds: await getAudioDuration(blob).catch(() => targetLength),
        fullSeconds,
        trimNote: null,
        lyrics: lyricsData,
      };
    } catch (error) {
      const note = isAbortError(error)
        ? 'Stopped while cutting: kept at full length.'
        : `Could not cut it (${userMessage(error)}); kept at full length.`;
      return {
        blob: full,
        seconds: fullSeconds,
        fullSeconds: null,
        trimNote: note,
        lyrics: lyricsData,
      };
    }
  };

  const run = async (signal: AbortSignal): Promise<void> => {
    if (!check()) {
      ui.status('Fix the highlighted fields first.');
      (lyrics.classList.contains('is-invalid') ? lyrics : target).focus();
      return;
    }
    const model = ctx.model().model;
    if (!model) return;
    const count = Number(variations.value) || 1;
    const targetLength = targetSeconds();
    const prompt = buildPrompt(form(), image !== null);
    const imageFile = image?.file ?? null;

    // Refused before anything was sent (no key, locked, free-only, budget, Cancel): nothing changes.
    const handle = await ctx.beginRun({}, signal);
    const started = Date.now();
    const stem = `music-${new Date(started).toISOString().slice(0, 19).replace(/[T:]/g, '-')}`;
    const length = LENGTHS.find((entry) => entry.id === model);
    const group: Variation[] = Array.from({ length: count }, (_, index) => ({
      index,
      status: 'queued',
      phase: 'Waiting for Lyria…',
      song: null,
      error: null,
      card: h('div', { class: 'col', 'data-testid': 'music-variation' }),
      handle: null,
      player: null,
    }));
    const columns =
      count === 1 ? '' : count === 2 ? 'row-cols-md-2' : 'row-cols-md-2 row-cols-xl-3';
    groups.prepend(
      h(
        'section',
        { class: 'vstack gap-2', 'data-testid': 'music-group' },
        h(
          'h3',
          { class: 'h6 mb-0 text-body-secondary' },
          `${formatDateTime(started)} · ${length?.model ?? model}${targetLength ? ` · cut to ${formatDuration(targetLength)}` : ''}`,
        ),
        h(
          'div',
          { class: ['row row-cols-1 g-3', columns] },
          group.map((variation) => variation.card),
        ),
      ),
    );
    showEmpty();
    for (const variation of group) drawVariation(variation, count);

    const tick = (): void => {
      const seconds = Math.round((Date.now() - started) / 1000);
      ui.status(`Composing… ${seconds} s`);
    };
    tick();
    elapsedTimer = setInterval(tick, 1000);
    try {
      const imageUrl = imageFile
        ? await (
            await import('../../core/media/image')
          ).toDataUrl(imageFile, {
            maxDimension: IMAGE_MAX_SIDE,
            maxBytes: 1024 * 1024,
          })
        : null;
      for (const variation of group) {
        variation.phase = `Composing: Lyria takes ${length?.wait ?? 'a while'}…`;
        drawVariation(variation, count);
      }
      const outcome = await runItems({
        items: group,
        concurrency: count,
        signal: handle.signal,
        work: (variation, itemSignal) =>
          compose(handle, prompt, imageUrl, variation, count, targetLength, itemSignal),
        onItem: (item) => {
          const variation = item.item;
          variation.status = item.status;
          if (item.status === 'failed') variation.error = userMessage(item.error);
          if (item.status === 'done' && item.value) {
            const song = item.value;
            const name = `${stem}${count > 1 ? `-${variation.index + 1}` : ''}.mp3`;
            variation.song = song;
            variation.handle = ui.addResult({ kind: 'audio', name, blob: song.blob });
            variation.player = audioPlayer({
              blob: song.blob,
              label: `${name}, ${formatDuration(song.seconds)}`,
              testId: 'music-player',
            });
          }
          drawVariation(variation, count);
        },
      });
      const made = group.filter((variation) => variation.song);
      const summary =
        outcome.failed > 0
          ? `${made.length} of ${plural(count, 'variation')} ready; ${outcome.failed} failed`
          : `${plural(made.length, 'variation')} ready`;
      ui.status(summary);
      announce('The music is ready.');
      await handle.finish({
        output: [
          `${summary}.`,
          ...made.map(
            (variation) =>
              `\n${count > 1 ? `Variation ${variation.index + 1}` : 'Lyrics'} (${formatDuration(variation.song!.seconds)}):\n${lyricsText(variation.song!.lyrics)}`,
          ),
        ].join('\n'),
        meta: {
          variations: count,
          failed: outcome.failed,
          seconds: made.map((variation) => Math.round(variation.song!.seconds * 10) / 10),
          ...(targetLength ? { targetSeconds: targetLength } : {}),
        },
      });
    } catch (error) {
      ui.status(isStop(error) ? 'Stopped' : 'Failed');
      await handle.fail(error);
      throw error;
    } finally {
      if (elapsedTimer) clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  };

  ui.runner({ label: 'Compose', icon: 'music-note-beamed', run });

  // --- state ----------------------------------------------------------------------------------------------
  const settings = () => ({
    genre: genre.input.value,
    mood: mood.input.value,
    tempo: tempo.input.value,
    instruments: instruments.input.value,
    vocals: vocals(),
    voice: voice.value,
    lyrics: lyrics.value,
    targetSeconds: targetSeconds(),
    variations: Number(variations.value),
  });

  syncLength();

  return {
    getState: () => ({ prompt: description.value, settings: settings() }),
    applyState: ({ prompt, settings: state }) => {
      description.value = prompt;
      const text = (key: string, input: HTMLInputElement | HTMLTextAreaElement): void => {
        const value = state[key];
        if (typeof value === 'string') input.value = value;
      };
      text('genre', genre.input);
      text('mood', mood.input);
      text('tempo', tempo.input);
      text('instruments', instruments.input);
      text('voice', voice);
      text('lyrics', lyrics);
      if (isVocals(state['vocals'])) {
        withVocals.input.checked = state['vocals'] === 'vocals';
        instrumental.input.checked = state['vocals'] === 'instrumental';
      }
      if (state['targetSeconds'] === null) target.value = '';
      else if (isTarget(state['targetSeconds'])) target.value = String(state['targetSeconds']);
      if (isVariationCount(state['variations'])) variations.value = String(state['variations']);
      formChanged();
      void ui.refreshEstimate();
    },
    estimate: async (model) => {
      const each = await ctx.models.estimate({ kind: 'music', model });
      return each === null ? null : each * (Number(variations.value) || 1);
    },
    onFiles: (files) => setImage(files[0]),
    onReceive: (items) => {
      const file = items.find((item) => item.kind === 'file');
      if (file?.kind === 'file')
        setImage(new File([file.blob], file.name, { type: file.blob.type }));
    },
    sample: () => {
      description.value = 'A hopeful acoustic song about walking home at dawn';
      genre.input.value = 'Folk pop';
      mood.input.value = 'Warm, hopeful';
      tempo.input.value = '96';
      instruments.input.value = 'Acoustic guitar, soft piano';
      withVocals.input.checked = true;
      voice.value = 'Warm female vocals';
      lyrics.value =
        '[Verse]\nMorning light on the quiet hill\nMist is rising, the air is still\n\n[Chorus]\nCarry me home, carry me home\nTo the place where I am known';
      formChanged();
    },
  };
}
