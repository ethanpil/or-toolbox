/**
 * Music generation: a song form (style, vocals or instrumental, lyrics with section tags, an optional reference
 * image) turned into a Lyria prompt, streamed back as one MP3 per variation with its timed lyrics.
 *
 * Lyria ignores lengths (docs/openrouter-api.md §6.2): Clip makes about 30 seconds and Pro about 3 minutes
 * whatever the prompt says, so a target length is applied afterwards in the browser (`trimMedia`, with a short
 * fade-out). Variations are one run with one request per variation (`runItems`, all at once): one Run press is
 * one History entry and one budget decision, and the estimate is the flat price times the count. A variation
 * that fails does not take the others with it, and can be retried on its own (a run of one). A song whose
 * audio arrived before the stream broke is kept: it is paid for. The free-only notice comes from the
 * framework: no music model is free.
 */
import { partialStreamResult } from '../../core/api/chat-stream';
import { base64ToBlob } from '../../core/api/encoding';
import type { ChatStreamResult } from '../../core/api/types';
import { ApiError, InvalidInputError, isAbortError, userMessage } from '../../core/errors';
import { getAudioDuration } from '../../core/media/audio';
import type { RunHandle } from '../../core/types';
import type { AudioPlayer } from '../../ui/components/audio-player';
import { type AudioResultCard, audioResultCard } from '../../ui/components/audio-result-card';
import { dropZone } from '../../ui/components/drop-zone';
import { emptyState } from '../../ui/components/empty-state';
import { h, replace } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { isStop, markPresented } from '../../ui/feedback/errors';
import { setFieldError } from '../../ui/feedback/field-error';
import { formatBytes, formatDateTime, formatDuration, formatUsd, plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import { setToolBinding } from '../../ui/settings-actions';
import { type ItemStatus, runItems } from '../../ui/tool/batch';
import type { ToolContext, ToolInstance } from '../../ui/tool/index';
import { retryGate } from '../../ui/tool/retry-gate';
import {
  activeLine,
  insertTag,
  lyricsText,
  parseTimedLyrics,
  SECTION_TAGS,
  type TimedLyrics,
  trimLyrics,
  validateLyrics,
  withArticle,
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
/** How much of a text-only answer (a refusal) is shown. */
const REFUSAL_CHARS = 300;

/** Lyria answered with words and no music (a refusal): asking again the same way gets the same answer. */
class NoMusicError extends InvalidInputError {}

interface Song {
  blob: Blob;
  /** Null when the length could not be read. */
  seconds: number | null;
  /** Length before the cut, when it was cut. */
  fullSeconds: number | null;
  /** Things worth knowing about this song: why a cut did not happen, a stream that broke after the audio. */
  notes: string[];
  lyrics: TimedLyrics;
}

/** One Compose press: what every variation in it was asked with, so a variation can be retried alike. */
interface Group {
  model: string;
  /** Variations asked for (cards keep their numbers when one is removed). */
  count: number;
  prompt: string;
  imageUrl: string | null;
  targetLength: number | null;
  stem: string;
  settings: Record<string, unknown>;
  section: HTMLElement;
  variations: Variation[];
}

interface Variation {
  group: Group;
  index: number;
  status: ItemStatus;
  phase: string;
  song: Song | null;
  error: string | null;
  /** The failure was Lyria declining: a retry would only be charged for the same answer. */
  refused: boolean;
  card: HTMLElement;
  /** The song as a result card (player, downloads, Send to…, Remove), once it is made. */
  result: AudioResultCard | null;
  /** A card without a song: its Remove button, where focus goes when a neighbouring card is removed. */
  removeButton: HTMLButtonElement | null;
}

/** The runner's argument: retry one variation. */
interface RetryArg {
  retry: Variation;
}

const isVariationCount = (value: unknown): value is (typeof VARIATIONS)[number] =>
  VARIATIONS.includes(value as (typeof VARIATIONS)[number]);
const isTarget = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= MIN_TARGET &&
  value <= MAX_TARGET;
const roundSeconds = (seconds: number | null): number | null =>
  seconds === null ? null : Math.round(seconds * 10) / 10;
/** The length of some audio, or null when it cannot be read (never a made-up 0:00). */
const durationOf = (blob: Blob): Promise<number | null> =>
  getAudioDuration(blob).then(
    (seconds) => (Number.isFinite(seconds) && seconds > 0 ? seconds : null),
    () => null,
  );

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
    image: uid('music-image'),
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

  /**
   * Inserts a section tag at the caret, keeping any selected text (the tag goes before it). The edit goes
   * through `insertText` where the browser has it, so Ctrl+Z undoes it like typing; else `setRangeText`.
   */
  const addTag = (tag: string): void => {
    const edit = insertTag(lyrics.value, lyrics.selectionStart, lyrics.selectionEnd, tag);
    lyrics.focus();
    lyrics.setSelectionRange(edit.from, edit.to);
    const before = lyrics.value;
    try {
      document.execCommand('insertText', false, edit.text);
    } catch {
      // Not available (or refused): the fallback below applies the edit.
    }
    if (lyrics.value === before) lyrics.setRangeText(edit.text, edit.from, edit.to, 'end');
    lyrics.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    formChanged();
    announce(`Inserted the [${tag}] tag.`);
  };
  const tagButtons = SECTION_TAGS.map((tag) =>
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm btn-outline-secondary',
        'aria-label': `Insert ${withArticle(tag)} tag`,
        'data-testid': `music-tag-${tag.toLowerCase()}`,
        onclick: () => addTag(tag),
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
  const imageSlot = h('div', { id: ids.image, 'data-testid': 'music-image' });
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
          ? 'Lyria always makes this length; a target length in Settings cuts it shorter.'
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
  /** Re-checks the lyrics and the target, updates the preview; returns the first field that blocks a run. */
  const check = (): HTMLElement | null => {
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
    return lyricsError !== null ? lyrics : targetError !== null ? target : null;
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

  /** Focuses a field, opening the settings drawer first when the field is in it (focus once it is shown). */
  const focusField = (input: HTMLElement): void => {
    const panel = ui.drawer.contains(input) ? input.closest('.offcanvas') : null;
    if (panel && !panel.classList.contains('show')) {
      panel.addEventListener('shown.bs.offcanvas', () => input.focus(), { once: true });
      ui.openDrawer();
      return;
    }
    if (ui.drawer.contains(input)) ui.openDrawer();
    input.focus();
  };

  // --- output zone ----------------------------------------------------------------------------------------
  const empty = emptyState({
    icon: 'music-note-beamed',
    title: 'No music yet',
    text: 'Fill in the form and press Compose. A clip takes about 10 seconds, a full song about a minute.',
    testId: 'music-empty',
  });
  // Focus lands here when the last result is removed.
  empty.tabIndex = -1;
  const groupsList = h('div', { class: 'vstack gap-4', 'data-testid': 'music-results' });
  ui.output.append(empty, groupsList);
  const groups: Group[] = [];
  const showEmpty = (): void => {
    empty.hidden = groups.length > 0;
  };

  /** Every player on the page: starting one pauses the others. */
  const players = new Set<AudioPlayer>();
  const addPlayer = (player: AudioPlayer): void => {
    players.add(player);
    player.audio.addEventListener('play', () => {
      for (const other of players) if (other !== player) other.audio.pause();
    });
  };

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

  const titleOf = (variation: Variation): string =>
    variation.group.count > 1 ? `Variation ${variation.index + 1}` : 'Result';

  /** Where focus can land in a card: its Remove button. */
  const removeButtonOf = (variation: Variation): HTMLElement | null =>
    variation.result
      ? variation.result.element.querySelector<HTMLElement>('button[aria-label^="Remove "]')
      : variation.removeButton;

  /** Takes a variation off the page's books (its card, its group when it was the last). Safe to call twice. */
  const forget = (variation: Variation): void => {
    const group = variation.group;
    const at = group.variations.indexOf(variation);
    if (at < 0) return;
    if (variation.result) players.delete(variation.result.player);
    variation.card.remove();
    group.variations.splice(at, 1);
    if (group.variations.length === 0) {
      group.section.remove();
      groups.splice(groups.indexOf(group), 1);
    }
    showEmpty();
  };

  /** The card that takes a removed one's place: the next in its group, the one before, another group's. */
  const neighbourOf = (variation: Variation): Variation | undefined => {
    const list = variation.group.variations;
    const at = list.indexOf(variation);
    return (
      list[at + 1] ??
      list[at - 1] ??
      groups.flatMap((group) => group.variations).find((other) => other !== variation)
    );
  };

  /** Where focus goes when `variation` is removed and no other song card took it. */
  const focusAfter = (variation: Variation): HTMLElement | null => {
    const next = neighbourOf(variation);
    forget(variation);
    return (next && removeButtonOf(next)) ?? (empty.hidden ? null : empty);
  };

  /** Removes a card that has no song (failed or stopped). Song cards remove themselves (audioResultCard). */
  const removeVariation = (variation: Variation): void => {
    focusAfter(variation)?.focus();
    announce(`Removed ${titleOf(variation).toLowerCase()}.`);
  };

  /** A finished song as a result card: player, downloads, Send to…, Remove; notes and lyrics in between. */
  const songCard = (variation: Variation, song: Song): AudioResultCard => {
    const group = variation.group;
    const title = titleOf(variation);
    const name = `${group.stem}${group.count > 1 ? `-${variation.index + 1}` : ''}.mp3`;
    const extra = h('div', { class: 'vstack gap-2' });
    const card = audioResultCard({
      ui,
      blob: song.blob,
      name,
      ...(song.seconds === null ? {} : { seconds: song.seconds }),
      title: group.count > 1 ? title : name,
      headingLevel: 4,
      metaParts: [
        song.seconds === null ? 'Length unknown' : formatDuration(song.seconds),
        song.fullSeconds !== null ? `cut from ${formatDuration(song.fullSeconds)}` : null,
        formatBytes(song.blob.size),
      ],
      formats: ['mp3', 'wav'],
      extra,
      onRemove: () => forget(variation),
      focusFallback: () => focusAfter(variation),
      testId: 'music',
    });
    extra.append(
      ...song.notes.map((note) =>
        h(
          'div',
          { class: 'small text-warning-emphasis', role: 'note', 'data-testid': 'music-note' },
          note,
        ),
      ),
    );
    const lyricsElement = lyricsPanel(song.lyrics, card.player, `Lyrics of ${title.toLowerCase()}`);
    if (lyricsElement) extra.append(lyricsElement);
    addPlayer(card.player);
    return card;
  };

  const drawVariation = (variation: Variation): void => {
    const title = titleOf(variation);
    variation.removeButton = null;
    variation.card.dataset['status'] = variation.status;
    if (variation.result) {
      replace(variation.card, variation.result.element);
      return;
    }
    let body: (HTMLElement | null)[];
    if (variation.status === 'queued' || variation.status === 'running') {
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
      variation.removeButton = h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-outline-danger d-inline-flex align-items-center gap-1 ms-auto',
          'aria-label': `Remove ${title.toLowerCase()}`,
          'data-testid': 'music-remove',
          onclick: () => removeVariation(variation),
        },
        icon('trash'),
        'Remove',
      );
      body = [
        h(
          'div',
          { class: 'small text-danger-emphasis', role: 'note', 'data-testid': 'music-failed' },
          variation.status === 'stopped'
            ? 'Stopped before it was ready.'
            : (variation.error ?? 'It failed.'),
        ),
        h(
          'div',
          { class: 'd-flex flex-wrap gap-2 mt-auto' },
          // Lyria declining is not retried: the same request would be charged for the same answer.
          variation.refused
            ? null
            : gate.bind(
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn btn-sm btn-outline-primary d-inline-flex align-items-center gap-1',
                    'aria-label': `Retry ${title.toLowerCase()}`,
                    'data-testid': 'music-retry',
                    onclick: () => gate.retry({ retry: variation }, 'Compose cannot start now.'),
                  },
                  icon('arrow-clockwise'),
                  'Retry',
                ),
              ),
          variation.removeButton,
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
  };

  // --- running --------------------------------------------------------------------------------------------
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;
  const stopTicker = (): void => {
    if (elapsedTimer) clearInterval(elapsedTimer);
    elapsedTimer = null;
  };

  /** The song from a finished (or broken-off) stream: its audio, lyrics and length, cut to the target. */
  const songFrom = async (
    result: ChatStreamResult,
    notes: string[],
    targetLength: number | null,
    phase: (text: string) => void,
    signal: AbortSignal,
  ): Promise<Song> => {
    // Lyria sends the whole MP3 as one base64 fragment; join any others before decoding once.
    const { blob: full } = base64ToBlob(result.audioChunks.join(''), 'audio/mpeg');
    const lyricsData = parseTimedLyrics(result.text);
    const fullSeconds = await durationOf(full);
    const whole = (extra: string | null): Song => ({
      blob: full,
      seconds: fullSeconds,
      fullSeconds: null,
      notes: extra ? [...notes, extra] : notes,
      lyrics: lyricsData,
    });
    if (targetLength === null) return whole(null);
    if (fullSeconds === null) return whole('Its length could not be read, so it was not cut.');
    if (!(fullSeconds > targetLength + 0.5)) {
      return whole(`Shorter than the ${formatDuration(targetLength)} target: kept whole.`);
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
      const cut = trimLyrics(lyricsData, targetLength);
      return {
        blob,
        seconds: (await durationOf(blob)) ?? targetLength,
        fullSeconds,
        notes:
          cut.dropped > 0
            ? [
                ...notes,
                `Lyrics after ${formatDuration(targetLength)} are not in this audio (${plural(cut.dropped, 'line')}).`,
              ]
            : notes,
        lyrics: cut.lyrics,
      };
    } catch (error) {
      return whole(
        isAbortError(error)
          ? 'Stopped while cutting: kept at full length.'
          : `Could not cut it (${userMessage(error)}); kept at full length.`,
      );
    }
  };

  const compose = async (
    run: RunHandle,
    variation: Variation,
    signal: AbortSignal,
  ): Promise<Song> => {
    const group = variation.group;
    const phase = (text: string): void => {
      variation.phase = text;
      drawVariation(variation);
    };
    let result: ChatStreamResult;
    const notes: string[] = [];
    try {
      result = await ctx.api.chatStream(songRequest(group.model, group.prompt, group.imageUrl), {
        run,
        signal,
        onEvent: (event) => {
          if (event.type === 'audio') phase('Putting the audio together…');
        },
      });
    } catch (error) {
      // The audio arrives in one piece near the end; a stream that breaks after it still delivered the song.
      const partial = partialStreamResult(error);
      if (isAbortError(error) || !partial || partial.audioChunks.length === 0) throw error;
      const { blob } = base64ToBlob(partial.audioChunks.join(''), 'audio/mpeg');
      if ((await durationOf(blob)) === null) throw error;
      result = partial;
      notes.push(
        `The connection ended after the song arrived (${userMessage(error)}); it is kept.`,
      );
    }
    if (result.audioChunks.length === 0) {
      const said = result.text.trim();
      if (said) {
        const shown = said.length > REFUSAL_CHARS ? `${said.slice(0, REFUSAL_CHARS)}…` : said;
        throw new NoMusicError(`Lyria answered without music: “${shown}”`);
      }
      throw new ApiError('Lyria answered without any audio. Try again.', 502, {});
    }
    return songFrom(result, notes, group.targetLength, phase, signal);
  };

  /** Shows a variation's outcome in its card (and its song as a session result). */
  const settle = (
    variation: Variation,
    outcome: { status: ItemStatus; value?: Song; error?: unknown },
  ): void => {
    variation.status = outcome.status;
    if (outcome.status === 'failed') {
      variation.error = userMessage(outcome.error);
      variation.refused = outcome.error instanceof NoMusicError;
    }
    if (outcome.status === 'done' && outcome.value) {
      variation.song = outcome.value;
      variation.error = null;
      variation.result = songCard(variation, outcome.value);
    }
    drawVariation(variation);
  };

  /** History's text for the songs made: a summary, then each song's lyrics (as far as the audio goes). */
  const historyOutput = (summary: string, made: Variation[], labelled: boolean): string =>
    [
      `${summary}.`,
      ...made.map((variation) => {
        const song = variation.song!;
        const label = labelled ? `Variation ${variation.index + 1}` : 'Lyrics';
        const length = song.seconds === null ? '' : ` (${formatDuration(song.seconds)})`;
        return `\n${label}${length}:\n${lyricsText(song.lyrics)}`;
      }),
    ].join('\n');

  const startTicker = (started: number): void => {
    stopTicker();
    const tick = (): void => {
      const seconds = Math.round((Date.now() - started) / 1000);
      ui.progress(`Composing… ${seconds} s`);
    };
    ui.status('Composing…');
    elapsedTimer = setInterval(tick, 1000);
  };

  /** A failed variation again, as a run of one with the same prompt, image and target. */
  const retryVariation = async (signal: AbortSignal, variation: Variation): Promise<void> => {
    const group = variation.group;
    if (!group.variations.includes(variation) || variation.song) return;
    const each = await ctx.models.estimate({ kind: 'music', model: group.model }).catch(() => null);
    const handle = await ctx.beginRun(
      {
        model: group.model,
        title: `Retry: variation ${variation.index + 1}`,
        prompt: '',
        settings: group.settings,
        estimateUsd: each,
      },
      signal,
    );
    const length = LENGTHS.find((entry) => entry.id === group.model);
    Object.assign(variation, {
      status: 'running',
      error: null,
      refused: false,
      phase: `Composing: Lyria takes ${length?.wait ?? 'a while'}…`,
    });
    drawVariation(variation);
    startTicker(Date.now());
    try {
      let song: Song;
      try {
        song = await compose(handle, variation, handle.signal);
      } catch (error) {
        stopTicker();
        settle(variation, { status: isStop(error) ? 'stopped' : 'failed', error });
        ui.status(isStop(error) ? 'Stopped' : `Failed: ${userMessage(error)}`);
        await handle.fail(error);
        // The card shows the error (with Retry when it is worth it); no second message for it.
        markPresented(error);
        throw error;
      }
      stopTicker();
      settle(variation, { status: 'done', value: song });
      const summary = `Variation ${variation.index + 1} ready`;
      ui.status(summary);
      await handle.finish({
        output: historyOutput(summary, [variation], true),
        meta: {
          variations: 1,
          failed: 0,
          seconds: [roundSeconds(variation.song!.seconds)],
          retried: true,
          ...(group.targetLength ? { targetSeconds: group.targetLength } : {}),
        },
      });
    } finally {
      stopTicker();
    }
  };

  const run = async (signal: AbortSignal, arg?: RetryArg): Promise<void> => {
    if (arg) {
      await retryVariation(signal, arg.retry);
      return;
    }
    const invalid = check();
    if (invalid) {
      ui.status('Fix the highlighted fields first.');
      focusField(invalid);
      return;
    }
    const model = ctx.model().model;
    if (!model) return;
    const count = Number(variations.value) || 1;
    const targetLength = targetSeconds();
    const prompt = buildPrompt(form(), image !== null);
    const imageFile = image?.file ?? null;
    const formSettings: Record<string, unknown> = settings();

    // The image is read before anything is sent or drawn: one that cannot be read stops here, at no cost.
    let imageUrl: string | null = null;
    if (imageFile) {
      try {
        imageUrl = await (
          await import('../../core/media/image')
        ).toDataUrl(imageFile, { maxDimension: IMAGE_MAX_SIDE, maxBytes: 1024 * 1024 });
      } catch (error) {
        ui.status('The reference image could not be read.');
        throw new InvalidInputError(
          `The reference image ${imageFile.name} could not be read (${userMessage(error)}). Remove it or choose another.`,
        );
      }
    }

    // Refused before anything was sent (no key, locked, free-only, budget, Cancel): nothing changes.
    const handle = await ctx.beginRun({}, signal);
    const started = Date.now();
    const length = LENGTHS.find((entry) => entry.id === model);
    const group: Group = {
      model,
      count,
      prompt,
      imageUrl,
      targetLength,
      stem: `music-${new Date(started).toISOString().slice(0, 19).replace(/[T:]/g, '-')}`,
      settings: formSettings,
      section: h('section', { class: 'vstack gap-2', 'data-testid': 'music-group' }),
      variations: [],
    };
    group.variations = Array.from({ length: count }, (_, index) => ({
      group,
      index,
      status: 'queued',
      phase: `Composing: Lyria takes ${length?.wait ?? 'a while'}…`,
      song: null,
      error: null,
      refused: false,
      card: h('div', { class: 'col', 'data-testid': 'music-variation' }),
      result: null,
      removeButton: null,
    }));
    // Side by side, two at most: the output zone is about half the page.
    replace(
      group.section,
      h(
        'h3',
        { class: 'h6 mb-0 text-body-secondary' },
        `${formatDateTime(started)} · ${length?.model ?? model}${targetLength ? ` · target ${formatDuration(targetLength)}` : ''}`,
      ),
      h(
        'div',
        { class: ['row row-cols-1 g-3', count > 1 && 'row-cols-xl-2'] },
        group.variations.map((variation) => variation.card),
      ),
    );
    groups.unshift(group);
    groupsList.prepend(group.section);
    showEmpty();
    for (const variation of group.variations) drawVariation(variation);

    startTicker(started);
    try {
      const outcome = await runItems({
        items: group.variations,
        concurrency: count,
        signal: handle.signal,
        work: (variation, itemSignal) => compose(handle, variation, itemSignal),
        onItem: (item) => settle(item.item, item),
      });
      const made = group.variations.filter((variation) => variation.song);
      const summary =
        outcome.failed > 0
          ? `${made.length} of ${plural(count, 'variation')} ready; ${outcome.failed} failed`
          : `${plural(made.length, 'variation')} ready`;
      // The ticker stops first, or a tick during the History write would overwrite the summary.
      stopTicker();
      ui.status(summary);
      await handle.finish({
        output: historyOutput(summary, made, count > 1),
        meta: {
          variations: count,
          failed: outcome.failed,
          seconds: made.map((variation) => roundSeconds(variation.song!.seconds)),
          ...(targetLength ? { targetSeconds: targetLength } : {}),
        },
      });
    } catch (error) {
      stopTicker();
      // Nothing is left spinning: cards still waiting say they were stopped (and offer Retry and Remove).
      for (const variation of group.variations) {
        if (variation.status === 'queued' || variation.status === 'running') {
          settle(variation, { status: 'stopped' });
        }
      }
      ui.status(isStop(error) ? 'Stopped' : 'Failed');
      await handle.fail(error);
      throw error;
    } finally {
      stopTicker();
    }
  };

  const runner = ui.runner<RetryArg>({ label: 'Compose', icon: 'music-note-beamed', run });
  // A Retry button disappears when its card starts again: focus goes to Stop (or back to Compose).
  const gate = retryGate(runner, {
    fallback: () => (runner.busy ? runner.stopButton : runner.button),
  });

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
