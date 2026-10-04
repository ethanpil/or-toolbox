/**
 * The transcript editor of Speech-to-text: segments with their times (a time plays the recording from there; the
 * segment being played is marked and kept in view while focus is not in the list), editable text, speaker names
 * that apply everywhere, a search that filters the segments, and a plain text view.
 *
 * Edits and names live here (`edits`, `names`) and survive `set()`, which updates the drawn segments and speaker
 * fields in place when more of the transcript arrives (by segment id and speaker key): the control the user is in
 * is never replaced or rewritten, so caret, selection and input-method composition stay.
 */
import { formatDuration } from '../../core/files';
import { debounce, SEARCH_DEBOUNCE_MS } from '../../core/util';
import { emptyState } from '../../ui/components/empty-state';
import { h } from '../../ui/dom';
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

interface SegmentItem {
  li: HTMLLIElement;
  row: HTMLElement;
  seek: HTMLButtonElement;
  time: Text;
  badge: HTMLElement | null;
  box: HTMLTextAreaElement;
  /** An input method is composing in the box: never touch its value. */
  composing: boolean;
}

interface SpeakerField {
  wrap: HTMLElement;
  label: HTMLLabelElement;
  input: HTMLInputElement;
}

/** Inserts `node` right after `previous` (or first), unless it is already there: nodes in place never move. */
function placeAfter(parent: Element, node: Element, previous: Element | null): void {
  const expected = previous ? previous.nextElementSibling : parent.firstElementChild;
  if (expected !== node) parent.insertBefore(node, expected);
}

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
  /** The segment being played, by id (ids survive redraws). */
  let activeId: string | null = null;
  const edits = new Map<string, string>();
  const names: Record<string, string> = {};
  /** The drawn segments by id: updated in place as parts arrive, never rebuilt. */
  const items = new Map<string, SegmentItem>();
  /** The current segment objects by id (the text boxes write edits into them). */
  const byId = new Map<string, Segment>();
  const speakerFields = new Map<string, SpeakerField>();

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
  // Everything is updated in place: a control the user is in (a text box, a speaker name) is never replaced and
  // never has its value set, so its caret, selection and an input method's composition survive parts arriving.
  const inUse = (control: HTMLElement): boolean => document.activeElement === control;

  const boxLabel = (segment: Segment): string =>
    `Text at ${formatDuration(segment.start)}${segment.speaker === undefined ? '' : `, ${nameOf(segment.speaker)}`}`;

  const refreshSpeakerBadges = (key: string): void => {
    for (const [id, item] of items) {
      const segment = byId.get(id);
      if (segment?.speaker !== key) continue;
      if (item.badge) item.badge.textContent = nameOf(key);
      item.box.setAttribute('aria-label', boxLabel(segment));
    }
  };

  const speakerField = (key: string): SpeakerField => {
    const id = uid('stt-speaker');
    const input = h('input', {
      id,
      type: 'text',
      class: 'form-control form-control-sm',
      autocomplete: 'off',
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
    const label = h('label', { class: 'form-label small mb-1', htmlFor: id });
    return { wrap: h('div', { class: 'col-sm-6' }, label, input), label, input };
  };

  const drawSpeakers = (): void => {
    speakers.hidden = current.speakers.length === 0;
    speakersNote.hidden = !current.speakersPerPart;
    speakersNote.textContent = current.speakersPerPart
      ? 'The recording was sent in parts, and the model numbers speakers anew in every part. Give the same name to the same person in each part.'
      : '';
    const keep = new Set(current.speakers);
    for (const [key, field] of speakerFields) {
      if (keep.has(key)) continue;
      field.wrap.remove();
      speakerFields.delete(key);
    }
    let previous: Element | null = null;
    for (const key of current.speakers) {
      let field = speakerFields.get(key);
      if (!field) {
        field = speakerField(key);
        speakerFields.set(key, field);
      }
      const fallback = defaultSpeakerName(key, current.speakersPerPart);
      field.label.textContent = fallback;
      field.input.placeholder = fallback;
      if (!inUse(field.input) && field.input.value !== (names[key] ?? '')) {
        field.input.value = names[key] ?? '';
      }
      placeAfter(speakersList, field.wrap, previous);
      previous = field.wrap;
    }
  };

  const segmentItem = (segment: Segment): SegmentItem => {
    const { id } = segment;
    const time = document.createTextNode('');
    const seek = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm btn-link p-0 font-monospace or-stt-time',
        'data-testid': 'stt-seek',
        onclick: () => options.onSeek(byId.get(id)?.start ?? 0),
      },
      icon('play-circle', 'me-1'),
      time,
    );
    const box = h('textarea', {
      class: 'form-control form-control-sm or-stt-segment-text',
      spellcheck: true,
      'data-testid': 'stt-segment-text',
    });
    const row = h('div', { class: 'd-flex flex-wrap align-items-center gap-2 mb-1' }, seek);
    const li = h('li', { class: 'or-stt-segment', 'data-testid': 'stt-segment' }, row, box);
    const item: SegmentItem = { li, row, seek, time, badge: null, box, composing: false };
    box.addEventListener('input', () => {
      edits.set(id, box.value);
      const current = byId.get(id);
      if (current) {
        current.text = box.value;
        current.edited = true;
      }
      options.onChange();
    });
    box.addEventListener('compositionstart', () => {
      item.composing = true;
    });
    box.addEventListener('compositionend', () => {
      item.composing = false;
    });
    return item;
  };

  /** Brings a drawn segment up to date without touching what the user is editing. */
  const updateItem = (item: SegmentItem, segment: Segment): void => {
    item.li.dataset['id'] = segment.id;
    item.li.dataset['start'] = String(segment.start);
    if (segment.speaker === undefined) delete item.li.dataset['speaker'];
    else item.li.dataset['speaker'] = segment.speaker;
    const time = formatDuration(segment.start);
    if (item.time.data !== time) item.time.data = time;
    item.seek.setAttribute('aria-label', `Play from ${time}`);
    if (segment.speaker === undefined) {
      item.badge?.remove();
      item.badge = null;
    } else {
      item.badge ??= item.row.appendChild(
        h('span', {
          class: 'badge rounded-pill text-bg-light border',
          'data-testid': 'stt-segment-speaker',
        }),
      );
      item.badge.textContent = nameOf(segment.speaker);
    }
    item.box.setAttribute('aria-label', boxLabel(segment));
    if (!inUse(item.box) && !item.composing && item.box.value !== segment.text) {
      item.box.value = segment.text;
      item.box.rows = rowsFor(segment.text);
    }
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
      item.li.hidden = !match;
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
    byId.clear();
    for (const segment of current.segments) byId.set(segment.id, segment);
    for (const [id, item] of items) {
      if (byId.has(id)) continue;
      // A segment that went away (a repeat dropped at a seam): focus moves on rather than to the page.
      const next = item.li.nextElementSibling?.querySelector('textarea');
      const hadFocus = item.li.contains(document.activeElement);
      item.li.remove();
      items.delete(id);
      if (hadFocus) next?.focus();
    }
    let previous: Element | null = null;
    for (const segment of current.segments) {
      let item = items.get(segment.id);
      if (!item) {
        item = segmentItem(segment);
        items.set(segment.id, item);
      }
      updateItem(item, segment);
      placeAfter(list, item.li, previous);
      previous = item.li;
    }
    applyFilter(false);
  };

  const markActive = (id: string | null, active: boolean): void => {
    const item = id === null ? undefined : items.get(id);
    if (!item) return;
    item.li.classList.toggle('is-active', active);
    if (active) item.li.setAttribute('aria-current', 'true');
    else item.li.removeAttribute('aria-current');
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
      const hasSegments = transcript.segments.length > 0;
      empty.hidden = hasSegments;
      body.hidden = !hasSegments;
      drawSpeakers();
      drawSegments();
      if (activeId !== null && !items.has(activeId)) activeId = null;
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
      const id = current.segments[index]?.id ?? null;
      if (id === activeId) return;
      markActive(activeId, false);
      activeId = id;
      markActive(id, true);
      const item = id === null ? undefined : items.get(id);
      // Scroll the list only (never the page), and never while the user works in it.
      if (!item || !follow.checked || view !== 'segments' || item.li.hidden) return;
      if (list.contains(document.activeElement)) return;
      const top = item.li.offsetTop;
      const bottom = top + item.li.offsetHeight;
      if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) {
        list.scrollTop = Math.max(0, top - list.clientHeight / 3);
      }
    },
    text: () => transcriptText(current, names),
  };
}
