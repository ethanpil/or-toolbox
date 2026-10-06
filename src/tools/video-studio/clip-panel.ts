/**
 * The "One clip" form: what the clip starts from (text, a first frame, first and last frames, reference images,
 * a clip to continue or extend), its prompt, the image pickers each mode needs, the source clip (any clip of the
 * timeline, or a video uploaded here) and the public link native extend sends. Only the inputs of the chosen mode
 * are shown, and only those are sent: frames and reference images never travel together.
 */
import { referencePicker, type ReferencePicker } from '../../ui/components/reference-picker';
import { dropZone } from '../../ui/components/drop-zone';
import { formatDuration } from '../../ui/format';
import { h, replace } from '../../ui/dom';
import { uid } from '../../ui/id';
import type { ToolUi } from '../../ui/tool/types';
import { CLIP_MODES, type ClipMode, MODE_LABELS, VIDEO_REFERENCE_MAX } from './params';
import type { TimelineClip } from './timeline';

export const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export interface ClipPanelHost {
  ui: Pick<ToolUi, 'status'>;
  onMode(mode: ClipMode): void;
  onPrompt(text: string): void;
  onSource(clipId: string | null): void;
  onExtendUrl(text: string): void;
  onUploads(files: File[]): void;
  /** A picker gained or lost an image. */
  onImages(): void;
}

export interface ClipPanelView {
  mode: ClipMode;
  prompt: string;
  extendUrl: string;
  sourceId: string | null;
  clips: readonly TimelineClip[];
  /** Notes for the current mode (extend plan, model limits, substitutions). */
  notes: readonly string[];
  /** Why Generate cannot run now, shown as a warning (null when it can). */
  problem: string | null;
}

export interface ClipPanel {
  readonly element: HTMLElement;
  readonly prompt: HTMLTextAreaElement;
  readonly first: ReferencePicker;
  readonly last: ReferencePicker;
  readonly references: ReferencePicker;
  /** Where the shared clip format fields go while this panel shows. */
  readonly formatSlot: HTMLElement;
  /** Where the Run bar goes (the end of this panel). */
  readonly runnerSlot: HTMLElement;
  /** Moves focus to the source clip choice. */
  focusSource(): void;
  render(view: ClipPanelView): void;
}

/** A source clip's line in a select: number, name, length. */
export function clipOptionLabel(clip: TimelineClip, index: number): string {
  const length = clip.duration ? ` (${formatDuration(clip.duration)})` : '';
  return `${index + 1}. ${clip.name}${length}`;
}

const filled = new WeakMap<HTMLSelectElement, string>();

/**
 * A select listing the timeline's clips after an empty first option. Rebuilt only when the list changed: a
 * rebuild closes a list the user has open.
 */
export function fillClipOptions(
  select: HTMLSelectElement,
  clips: readonly TimelineClip[],
  emptyLabel: string,
): void {
  const labels = clips.map((clip, index) => [clip.id, clipOptionLabel(clip, index)] as const);
  const signature = JSON.stringify([emptyLabel, labels]);
  if (filled.get(select) === signature) return;
  filled.set(select, signature);
  replace(
    select,
    h('option', { value: '' }, emptyLabel),
    labels.map(([value, label]) => h('option', { value }, label)),
  );
}

export function clipPanel(host: ClipPanelHost): ClipPanel {
  const ids = {
    mode: uid('video-mode'),
    prompt: uid('video-prompt'),
    source: uid('video-source'),
    url: uid('video-extend-url'),
    urlHelp: uid('video-extend-url-help'),
  };

  const mode = h(
    'select',
    {
      id: ids.mode,
      class: 'form-select',
      'data-testid': 'video-mode',
      onchange: () => host.onMode(mode.value as ClipMode),
    },
    CLIP_MODES.map((value) => h('option', { value }, MODE_LABELS[value])),
  );

  const promptLabel = h('label', { class: 'form-label fw-semibold', htmlFor: ids.prompt });
  const prompt = h('textarea', {
    id: ids.prompt,
    class: 'form-control',
    rows: 4,
    'data-testid': 'tool-prompt',
    oninput: () => host.onPrompt(prompt.value),
  });

  const picker = (label: string, max: number, testId: string, hint: string): ReferencePicker => {
    const created = referencePicker({
      ui: host.ui,
      max,
      // Shown only in the modes that need them, so none of them is optional.
      min: 1,
      label,
      accepts: IMAGE_TYPES,
      hint,
      focusFallback: () => mode,
      testId,
    });
    created.onChange(() => host.onImages());
    return created;
  };
  const first = picker('First frame', 1, 'video-first', 'PNG, JPEG or WebP: the clip starts here');
  const last = picker('Last frame', 1, 'video-last', 'PNG, JPEG or WebP: the clip ends here');
  const references = picker(
    'Reference images',
    VIDEO_REFERENCE_MAX,
    'video-refs',
    'PNG, JPEG or WebP: the model follows their content or style',
  );

  const source = h('select', {
    id: ids.source,
    class: 'form-select',
    'data-testid': 'video-source',
    onchange: () => host.onSource(source.value || null),
  });
  const upload = dropZone({
    accept: VIDEO_TYPES,
    compact: true,
    label: 'Upload a video to continue',
    hint: 'MP4, MOV or WebM; it joins the timeline',
    focusKey: 'video-upload',
    testId: 'video-upload',
    onFiles: (files) => host.onUploads(files),
  });
  const sourceSection = h(
    'div',
    { class: 'd-flex flex-column gap-2', 'data-testid': 'video-source-section' },
    h('label', { class: 'form-label fw-semibold mb-0', htmlFor: ids.source }, 'Clip to start from'),
    source,
    upload,
  );

  const url = h('input', {
    id: ids.url,
    type: 'url',
    class: 'form-control',
    inputMode: 'url',
    autocomplete: 'off',
    placeholder: 'https://example.com/my-clip.mp4',
    'aria-describedby': ids.urlHelp,
    'data-testid': 'video-extend-url',
    oninput: () => host.onExtendUrl(url.value),
  });
  const urlSection = h(
    'div',
    null,
    h(
      'label',
      { class: 'form-label', htmlFor: ids.url },
      'Public link to the source video (optional)',
    ),
    url,
    h(
      'div',
      { id: ids.urlHelp, class: 'form-text' },
      'Native extend needs the video at a public https:// address (OpenRouter refuses uploaded video). Without one, or on a model that cannot extend, the clip is continued from its last frame instead.',
    ),
  );

  const notes = h('div', {
    class: 'd-flex flex-column gap-2 empty-hidden',
    'data-testid': 'video-notes',
  });
  const runnerSlot = h('div');
  const formatSlot = h('div');
  // The pickers show and hide themselves by their limits; the mode shows and hides these wrappers.
  const firstSlot = h('div', null, first.element);
  const lastSlot = h('div', null, last.element);
  const referencesSlot = h('div', null, references.element);

  const element = h(
    'div',
    { class: 'd-flex flex-column gap-3', 'data-testid': 'video-clip-panel' },
    h(
      'div',
      null,
      h('label', { class: 'form-label fw-semibold', htmlFor: ids.mode }, 'Start from'),
      mode,
    ),
    sourceSection,
    urlSection,
    firstSlot,
    lastSlot,
    referencesSlot,
    h('div', null, promptLabel, prompt),
    formatSlot,
    notes,
    runnerSlot,
  );

  return {
    element,
    prompt,
    first,
    last,
    references,
    formatSlot,
    runnerSlot,
    focusSource: () => source.focus(),
    render(view) {
      if (mode.value !== view.mode) mode.value = view.mode;
      if (prompt.value !== view.prompt) prompt.value = view.prompt;
      if (url.value !== view.extendUrl) url.value = view.extendUrl;
      const continuing = view.mode === 'continue' || view.mode === 'extend';
      promptLabel.textContent = continuing ? 'What happens next (optional)' : 'Describe the video';
      prompt.placeholder = continuing
        ? 'For example: the camera keeps rising above the harbor as the sun comes up'
        : 'For example: a fishing boat leaves a quiet harbor at dawn, gulls overhead';
      sourceSection.hidden = !continuing;
      urlSection.hidden = view.mode !== 'extend';
      firstSlot.hidden = view.mode !== 'first' && view.mode !== 'first-last';
      lastSlot.hidden = view.mode !== 'first-last';
      referencesSlot.hidden = view.mode !== 'references';

      fillClipOptions(
        source,
        view.clips,
        view.clips.length ? 'Choose a clip…' : 'No clips yet: upload one',
      );
      source.value =
        view.sourceId && view.clips.some((c) => c.id === view.sourceId) ? view.sourceId : '';

      replace(
        notes,
        view.notes.map((note) =>
          h('div', { class: 'small text-body-secondary', role: 'note' }, note),
        ),
        view.problem
          ? h(
              'div',
              {
                class: 'small text-warning-emphasis',
                role: 'note',
                'data-testid': 'video-problem',
              },
              view.problem,
            )
          : null,
      );
    },
  };
}
