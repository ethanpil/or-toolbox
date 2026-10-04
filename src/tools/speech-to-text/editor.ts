/**
 * The transcript editor of Speech-to-text: segments with their times (a time plays the recording from there; the
 * segment being played is marked and kept in view while focus is not in the list), editable text, speaker names
 * that apply everywhere, a search that filters the segments, and a plain text view.
 *
 * Edits and names live here (`edits`, `names`) and survive `set()`, which redraws when more of the transcript
 * arrives; focus stays on the same control through `data-focus-key`.
 */
import { formatDuration } from '../../core/files';
import { debounce, SEARCH_DEBOUNCE_MS } from '../../core/util';
import { emptyState } from '../../ui/components/empty-state';
import { h, replace } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import {
  defaultSpeakerName,
  EMPTY_TRANSCRIPT,
  type Segment,
  segmentAt,
  segmentMatches,
  speakerName,
  type Transcript,
  transcriptText,
} from './transcript';

export interface TranscriptEditorOptions {
  /** Plays the recording from `seconds`. */
  onSeek: (seconds: number) => void;
  /** A segment's text or a speaker's name changed. */
  onChange: () => void;
}

export interface TranscriptEditor {
  readonly element: HTMLElement;
  /** Text the user typed, by segment id. */
  readonly edits: Map<string, string>;
  /** Speaker names the user gave, by speaker key. */
  readonly names: Record<string, string>;
  /** The transcript as shown (with edits). */
  transcript(): Transcript;
  /** Draws a transcript; search, view and names stay. */
  set(transcript: Transcript): void;
  /** Forgets edits and names (a new recording). */
  reset(): void;
  /** Marks the segment playing at `seconds`. */
  setTime(seconds: number): void;
  /** Plain text with the current names. */
  text(): string;
}

type View = 'segments' | 'text';

/** Rows for a segment's text box, so most segments show whole without scrolling. */
const rowsFor = (text: string): number => Math.min(8, Math.max(1, Math.ceil(text.length / 70)));

export function transcriptEditor(options: TranscriptEditorOptions): TranscriptEditor {
  const ids = {
    search: uid('stt-search'),
    follow: uid('stt-follow'),
    speakers: uid('stt-speakers'),
  };
  let current: Transcript = EMPTY_TRANSCRIPT;
  let view: View = 'segments';
  let query = '';
  let active = -1;
  const edits = new Map<string, string>();
  const names: Record<string, string> = {};
  const items = new Map<string, HTMLElement>();

  const nameOf = (key: string): string => speakerName(key, names, current.speakersPerPart);

  // --- toolbar --------------------------------------------------------------------------------------------
  const viewButton = (label: string, which: View, glyph: string): HTMLButtonElement =>
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
        'aria-pressed': String(which === view),
        'data-testid': `stt-view-${which}`,
        onclick: () => showView(which),
      },
      icon(glyph),
      label,
    );
  const segmentsButton = viewButton('Segments', 'segments', 'list-ul');
  const textButton = viewButton('Text', 'text', 'text-paragraph');

  const count = h('span', {
    class: 'small text-body-secondary',
    'data-testid': 'stt-search-count',
  });
  const announceCount = debounce((text: string) => announce(text), 600);
  const search = h('input', {
    id: ids.search,
    type: 'search',
    class: 'form-control form-control-sm',
    placeholder: 'Search the transcript',
    autocomplete: 'off',
    'data-testid': 'stt-search',
  });
  const filter = debounce(() => {
    query = search.value;
    applyFilter(true);
  }, SEARCH_DEBOUNCE_MS);
  search.addEventListener('input', () => filter());

  const follow = h('input', {
    id: ids.follow,
    type: 'checkbox',
    role: 'switch',
    class: 'form-check-input',
    checked: true,
    'data-testid': 'stt-follow',
  });

  const toolbar = h(
    'div',
    { class: 'd-flex flex-wrap align-items-center gap-2' },
    h(
      'div',
      { class: 'btn-group', role: 'group', 'aria-label': 'Transcript view' },
      segmentsButton,
      textButton,
    ),
    h(
      'div',
      { class: 'or-stt-search flex-grow-1' },
      h('label', { class: 'visually-hidden', htmlFor: ids.search }, 'Search the transcript'),
      search,
    ),
    count,
    h(
      'div',
      { class: 'form-check form-switch mb-0' },
      follow,
      h('label', { class: 'form-check-label small', htmlFor: ids.follow }, 'Follow playback'),
    ),
  );

  // --- speakers -------------------------------------------------------------------------------------------
  const speakersList = h('div', { class: 'row g-2' });
  const speakersNote = h('div', { class: 'form-text mt-0', hidden: true });
  const speakers = h(
    'fieldset',
    { class: 'or-stt-speakers', hidden: true, 'data-testid': 'stt-speakers' },
    h('legend', { id: ids.speakers, class: 'form-label fs-6 fw-semibold mb-1' }, 'Speakers'),
    speakersNote,
    speakersList,
  );

  // --- segments and text ----------------------------------------------------------------------------------
  const list = h('ol', {
    class: 'list-unstyled vstack gap-2 mb-0 or-stt-segments',
    'aria-label': 'Transcript segments',
    'data-testid': 'stt-segments',
  });
  const textView = h('div', {
    class: 'or-plain-text or-stt-text',
    role: 'region',
    'aria-label': 'Transcript text',
    tabIndex: 0,
    hidden: true,
    'data-testid': 'stt-text',
  });
  const empty = emptyState({
    icon: 'mic',
    title: 'No transcript yet',
    text: 'Record or add a recording, then press Transcribe.',
    compact: true,
    testId: 'stt-empty',
  });
  const body = h('div', { class: 'vstack gap-3', hidden: true }, toolbar, speakers, list, textView);
  const element = h('div', { 'data-testid': 'stt-editor' }, empty, body);

  // --- drawing --------------------------------------------------------------------------------------------
  const refreshSpeakerBadges = (key: string): void => {
    for (const item of items.values()) {
      if (item.dataset['speaker'] !== key) continue;
      const badge = item.querySelector<HTMLElement>('[data-speaker-badge]');
      if (badge) badge.textContent = nameOf(key);
      const box = item.querySelector<HTMLTextAreaElement>('textarea');
      if (box) box.setAttribute('aria-label', boxLabel(segmentOf(item)));
    }
  };

  const segmentOf = (item: HTMLElement): Segment | undefined =>
    current.segments.find((segment) => segment.id === item.dataset['id']);

  const boxLabel = (segment: Segment | undefined): string =>
    segment
      ? `Text at ${formatDuration(segment.start)}${segment.speaker === undefined ? '' : `, ${nameOf(segment.speaker)}`}`
      : 'Segment text';

  const drawSpeakers = (): void => {
    speakers.hidden = current.speakers.length === 0;
    speakersNote.hidden = !current.speakersPerPart;
    speakersNote.textContent = current.speakersPerPart
      ? 'The recording was sent in parts, and the model numbers speakers anew in every part. Give the same name to the same person in each part.'
      : '';
    replace(
      speakersList,
      current.speakers.map((key) => {
        const id = uid('stt-speaker');
        const input = h('input', {
          id,
          type: 'text',
          class: 'form-control form-control-sm',
          placeholder: defaultSpeakerName(key, current.speakersPerPart),
          value: names[key] ?? '',
          autocomplete: 'off',
          'data-focus-key': `speaker:${key}`,
          'data-testid': 'stt-speaker-name',
          dataset: { speaker: key },
        });
        input.addEventListener('input', () => {
          const value = input.value.trim();
          if (value) names[key] = value;
          else delete names[key];
          refreshSpeakerBadges(key);
          if (view === 'text') drawText();
          options.onChange();
        });
        return h(
          'div',
          { class: 'col-sm-6' },
          h(
            'label',
            { class: 'form-label small mb-1', htmlFor: id },
            defaultSpeakerName(key, current.speakersPerPart),
          ),
          input,
        );
      }),
    );
  };

  const segmentItem = (segment: Segment, index: number): HTMLElement => {
    const time = formatDuration(segment.start);
    const box = h('textarea', {
      class: 'form-control form-control-sm or-stt-segment-text',
      rows: rowsFor(segment.text),
      value: segment.text,
      spellcheck: true,
      'aria-label': boxLabel(segment),
      'data-focus-key': `text:${segment.id}`,
      'data-testid': 'stt-segment-text',
    });
    box.addEventListener('input', () => {
      edits.set(segment.id, box.value);
      segment.text = box.value;
      segment.edited = true;
      options.onChange();
    });
    const item = h(
      'li',
      {
        class: ['or-stt-segment', index === active && 'is-active'],
        'aria-current': index === active ? 'true' : null,
        'data-testid': 'stt-segment',
        dataset: {
          id: segment.id,
          start: String(segment.start),
          ...(segment.speaker === undefined ? {} : { speaker: segment.speaker }),
        },
      },
      h(
        'div',
        { class: 'd-flex flex-wrap align-items-center gap-2 mb-1' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm btn-link p-0 font-monospace or-stt-time',
            'aria-label': `Play from ${time}`,
            'data-focus-key': `seek:${segment.id}`,
            'data-testid': 'stt-seek',
            onclick: () => options.onSeek(segment.start),
          },
          icon('play-circle', 'me-1'),
          time,
        ),
        segment.speaker === undefined
          ? null
          : h(
              'span',
              {
                class: 'badge rounded-pill text-bg-light border',
                'data-speaker-badge': '',
                'data-testid': 'stt-segment-speaker',
              },
              nameOf(segment.speaker),
            ),
      ),
      box,
    );
    items.set(segment.id, item);
    return item;
  };

  const drawText = (): void => {
    textView.textContent = transcriptText(current, names);
  };

  const applyFilter = (speak: boolean): void => {
    let shown = 0;
    for (const segment of current.segments) {
      const item = items.get(segment.id);
      if (!item) continue;
      const speaker = segment.speaker === undefined ? null : nameOf(segment.speaker);
      const match = segmentMatches(segment, speaker, query);
      item.hidden = !match;
      if (match) shown++;
    }
    const total = current.segments.length;
    const text = query.trim()
      ? `${shown} of ${plural(total, 'segment')}`
      : plural(total, 'segment');
    count.textContent = text;
    if (speak && query.trim()) announceCount(shown === 0 ? 'No segment matches.' : text);
  };

  const drawSegments = (): void => {
    items.clear();
    replace(list, current.segments.map(segmentItem));
    applyFilter(false);
  };

  function showView(next: View): void {
    view = next;
    segmentsButton.setAttribute('aria-pressed', String(next === 'segments'));
    textButton.setAttribute('aria-pressed', String(next === 'text'));
    list.hidden = next !== 'segments';
    textView.hidden = next !== 'text';
    search.disabled = next !== 'segments';
    if (next === 'text') drawText();
  }

  return {
    element,
    edits,
    names,
    transcript: () => current,
    set(transcript) {
      current = transcript;
      active = -1;
      const hasSegments = transcript.segments.length > 0;
      empty.hidden = hasSegments;
      body.hidden = !hasSegments;
      drawSpeakers();
      drawSegments();
      if (view === 'text') drawText();
    },
    reset() {
      edits.clear();
      for (const key of Object.keys(names)) delete names[key];
      search.value = '';
      query = '';
    },
    setTime(seconds) {
      const index = segmentAt(current.segments, seconds);
      if (index === active) return;
      const previous = current.segments[active];
      const previousItem = previous ? items.get(previous.id) : undefined;
      previousItem?.classList.remove('is-active');
      previousItem?.removeAttribute('aria-current');
      active = index;
      const segment = current.segments[index];
      const item = segment ? items.get(segment.id) : undefined;
      if (!item) return;
      item.classList.add('is-active');
      item.setAttribute('aria-current', 'true');
      // Scroll the list only (never the page), and never while the user works in it.
      if (!follow.checked || view !== 'segments' || item.hidden) return;
      if (list.contains(document.activeElement)) return;
      const top = item.offsetTop;
      const bottom = top + item.offsetHeight;
      if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) {
        list.scrollTop = Math.max(0, top - list.clientHeight / 3);
      }
    },
    text: () => transcriptText(current, names),
  };
}
