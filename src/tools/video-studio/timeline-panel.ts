/**
 * The timeline: every clip of the session in order, each with its player, what it is (step, upload, model),
 * trims, "leave out the repeated first frame" for clips that continue the one before, whether it goes into the
 * join, and its actions: Move up/down (also Alt+Arrow keys anywhere in the clip), Continue, Extend, Frames,
 * Download, Remove. Under it, the join: one MP4 made in the browser, with progress and Stop.
 *
 * Clip rows are rebuilt with `replace()` and stable focus keys, so the button that moved a clip keeps focus.
 */
import { emptyState } from '../../ui/components/empty-state';
import { progressBar } from '../../ui/components/progress-bar';
import { videoPlayer } from '../../ui/components/video-player';
import { focusKey, h, replace } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { formatDuration, plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import type { ClipState } from './clip-media';
import { joinable, joinLength, type TimelineClip } from './timeline';

export interface TimelinePanelHost {
  state(clip: TimelineClip): ClipState;
  /** The clip's download button (generated clips), or null. */
  downloadButton(clip: TimelineClip): HTMLElement | null;
  /** "Step 3", "Uploaded", "Continues clip 2"… */
  describe(clip: TimelineClip): string[];
  move(clipId: string, delta: number): void;
  /** Stores the trims; returns what was stored (clamped to leave part of the clip). */
  trim(clipId: string, trimStart: number, trimEnd: number): { trimStart: number; trimEnd: number };
  setIncluded(clipId: string, included: boolean): void;
  setDropFirstFrame(clipId: string, drop: boolean): void;
  continueFrom(clipId: string): void;
  extend(clipId: string): void;
  frames(clipId: string): void;
  remove(clipId: string): void;
  retry(clipId: string): void;
  join(): void;
  stopJoin(): void;
}

export interface TimelinePanel {
  readonly element: HTMLElement;
  /** Where joined videos go. */
  readonly exports: HTMLElement;
  render(clips: readonly TimelineClip[], join: { busy: boolean; blocked: string | null }): void;
  /** The join's progress (0 to 1) and label. */
  progress(ratio: number, label: string): void;
  focusList(): void;
  /** Focus on the join's Stop (while it runs) or its Join button. */
  focusJoin(which: 'join' | 'stop'): void;
  /** A clip's control by its focus key prefix (`video-clip-frames`, `clip-remove`…); false when it is gone. */
  focusClip(clipId: string, control: string): boolean;
}

const seconds = (value: number): string => (Math.round(value * 100) / 100).toString();

export function timelinePanel(host: TimelinePanelHost): TimelinePanel {
  const headingId = uid('timeline-heading');
  const summary = h('span', {
    class: 'small text-body-secondary',
    'data-testid': 'video-timeline-summary',
  });
  const list = h('ol', {
    class: 'list-unstyled d-flex flex-column gap-3 mb-0',
    'aria-labelledby': headingId,
    'data-testid': 'video-timeline',
  });
  const empty = emptyState({
    icon: 'film',
    title: 'No clips yet',
    text: 'Generated clips and uploads appear here in order. Join them into one MP4 when they are ready.',
    compact: true,
    testId: 'video-timeline-empty',
  });
  empty.tabIndex = -1;

  const joinButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-primary d-inline-flex align-items-center gap-2',
      'data-testid': 'video-join',
      onclick: () => host.join(),
    },
    icon('film'),
    h('span', null, 'Join into one MP4'),
  );
  const stopButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline-danger d-inline-flex align-items-center gap-2',
      hidden: true,
      'data-testid': 'video-join-stop',
      onclick: () => host.stopJoin(),
    },
    icon('stop-fill'),
    'Stop',
  );
  const joinNote = h('span', {
    class: 'small text-body-secondary',
    'data-testid': 'video-join-note',
  });
  const bar = progressBar({
    label: 'Joining the clips',
    hidden: true,
    testId: 'video-join-progress',
  });
  const exports = h('div', { class: 'd-flex flex-column gap-3', 'data-testid': 'video-exports' });

  const element = h(
    'section',
    {
      class: 'd-flex flex-column gap-3',
      'aria-labelledby': headingId,
      'data-testid': 'video-timeline-section',
    },
    h(
      'div',
      { class: 'd-flex flex-wrap align-items-baseline gap-2' },
      h('h3', { id: headingId, class: 'h6 mb-0 me-auto' }, 'Timeline'),
      summary,
    ),
    empty,
    list,
    h(
      'div',
      { class: 'd-flex flex-wrap align-items-center gap-2' },
      joinButton,
      stopButton,
      joinNote,
    ),
    bar.element,
    exports,
  );

  /**
   * A trim field. It always shows the stored value: one the clip cannot take is clamped, and the field says so
   * (`aria-invalid` and a note) until the next valid entry.
   */
  const trimField = (clip: TimelineClip, which: 'start' | 'end', label: string): HTMLElement => {
    const id = uid(`trim-${which}`);
    const noteId = uid(`trim-${which}-note`);
    const max = clip.duration ? Math.max(0, clip.duration - 0.1) : undefined;
    const note = h('div', {
      id: noteId,
      class: 'form-text text-warning-emphasis mt-1',
      hidden: true,
      'data-testid': `video-trim-${which}-note`,
    });
    const input = h('input', {
      id,
      type: 'number',
      class: 'form-control form-control-sm',
      min: '0',
      ...(max !== undefined ? { max: seconds(max) } : {}),
      step: '0.05',
      inputMode: 'decimal',
      value: seconds(which === 'start' ? clip.trimStart : clip.trimEnd),
      'aria-describedby': noteId,
      'data-focus-key': `trim-${which}:${clip.id}`,
      'data-testid': `video-trim-${which}`,
      onchange: () => {
        const value = Number(input.value);
        const asked = input.value.trim() === '' || !Number.isFinite(value) ? 0 : value;
        const stored = host.trim(
          clip.id,
          which === 'start' ? asked : clip.trimStart,
          which === 'end' ? asked : clip.trimEnd,
        );
        const kept = which === 'start' ? stored.trimStart : stored.trimEnd;
        input.value = seconds(kept);
        const clamped = Math.abs(kept - asked) > 0.0005;
        input.setAttribute('aria-invalid', String(clamped));
        input.classList.toggle('is-invalid', clamped);
        note.hidden = !clamped;
        note.textContent = !clamped
          ? ''
          : asked < kept
            ? 'A trim cannot be negative: 0 s is used.'
            : `${seconds(kept)} s is the most this trim can be: at least 0.1 s of the clip stays.`;
        if (clamped) announce(note.textContent);
      },
    });
    return h(
      'div',
      { class: 'col-6' },
      h(
        'label',
        { class: 'form-label small mb-1', htmlFor: id },
        label,
        h('span', { class: 'visually-hidden' }, ` of ${clip.name}, in seconds`),
      ),
      h(
        'div',
        { class: 'input-group input-group-sm has-validation' },
        input,
        h('span', { class: 'input-group-text', 'aria-hidden': 'true' }, 's'),
      ),
      note,
    );
  };

  const check = (
    clip: TimelineClip,
    key: string,
    label: string,
    checked: boolean,
    onChange: (value: boolean) => void,
  ): HTMLElement => {
    const id = uid(key);
    const input = h('input', {
      id,
      type: 'checkbox',
      class: 'form-check-input',
      checked,
      'data-focus-key': `${key}:${clip.id}`,
      'data-testid': `video-${key}`,
      onchange: () => onChange(input.checked),
    });
    return h(
      'div',
      { class: 'form-check' },
      input,
      h('label', { class: 'form-check-label small', htmlFor: id }, label),
    );
  };

  /**
   * A clip's button. `disabled` takes it out of the tab order; `unavailable` (the reorder buttons at the ends)
   * keeps it focusable with `aria-disabled`, so focus stays on it after a move, and says why on a press.
   */
  const action = (
    clip: TimelineClip,
    label: string,
    glyph: string,
    testId: string,
    ariaLabel: string,
    onclick: () => void,
    options: { disabled?: boolean; unavailable?: string | null } = {},
  ): HTMLButtonElement =>
    h(
      'button',
      {
        type: 'button',
        class: [
          'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
          options.unavailable && 'disabled',
        ],
        'aria-label': ariaLabel,
        'aria-disabled': options.unavailable ? 'true' : null,
        disabled: options.disabled ?? false,
        'data-focus-key': `${testId}:${clip.id}`,
        'data-testid': testId,
        onclick: () => {
          if (options.unavailable) announce(options.unavailable);
          else onclick();
        },
      },
      icon(glyph),
      label,
    );

  const players = new Map<string, { blob: Blob; element: HTMLElement; dispose: () => void }>();
  /** One player per clip and video, kept across renders (a rebuild would restart playback). */
  const playerFor = (clip: TimelineClip, blob: Blob): HTMLElement => {
    const known = players.get(clip.id);
    if (known?.blob === blob) return known.element;
    known?.dispose();
    const player = videoPlayer({ blob, label: clip.name, testId: 'video-clip-player' });
    players.set(clip.id, { blob, element: player.element, dispose: () => player.dispose() });
    return player.element;
  };

  const media = (clip: TimelineClip, state: ClipState): HTMLElement => {
    if (state.kind === 'ready') return playerFor(clip, state.blob);
    if (state.kind === 'loading') {
      return h(
        'div',
        {
          class:
            'or-video-placeholder rounded border d-flex align-items-center justify-content-center gap-2 p-4 small text-body-secondary',
          'data-testid': 'video-clip-loading',
        },
        h('span', { class: 'spinner-border spinner-border-sm', 'aria-hidden': 'true' }),
        'Downloading the clip…',
      );
    }
    return h(
      'div',
      {
        class: 'alert alert-warning small mb-0 d-flex flex-wrap align-items-center gap-2',
        'data-testid': 'video-clip-unavailable',
      },
      h('span', { class: 'me-auto' }, state.message),
      state.kind === 'error'
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn btn-sm btn-outline-secondary',
              'data-focus-key': `clip-retry:${clip.id}`,
              'data-testid': 'video-clip-retry',
              onclick: () => host.retry(clip.id),
            },
            'Try again',
          )
        : null,
    );
  };

  const row = (clip: TimelineClip, index: number, count: number): HTMLElement => {
    const state = host.state(clip);
    const ready = state.kind === 'ready';
    const title = `${index + 1}. ${clip.name}`;
    const meta = [
      clip.duration
        ? clip.duration < 60
          ? `${seconds(clip.duration)} s`
          : formatDuration(clip.duration)
        : null,
      ...host.describe(clip),
    ].filter(Boolean);
    const item = h(
      'li',
      {
        class: ['card or-timeline-clip', !clip.included && 'opacity-75'],
        'data-testid': 'video-clip',
        'data-clip-id': clip.id,
        onkeydown: (event: KeyboardEvent) => {
          if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
          const target = event.target as HTMLElement;
          if (target instanceof HTMLInputElement && target.type === 'number') return;
          event.preventDefault();
          host.move(clip.id, event.key === 'ArrowUp' ? -1 : 1);
        },
      },
      h(
        'div',
        { class: 'card-body d-flex flex-column gap-2' },
        h(
          'div',
          { class: 'd-flex flex-wrap align-items-baseline gap-2' },
          h('h4', { class: 'h6 mb-0 text-break me-auto' }, title),
          h(
            'span',
            { class: 'small text-body-secondary', 'data-testid': 'video-clip-meta' },
            meta.join(' · '),
          ),
        ),
        media(clip, state),
        clip.prompt
          ? h('p', { class: 'small text-body-secondary mb-0 text-break' }, clip.prompt)
          : null,
        h(
          'div',
          { class: 'd-flex flex-wrap gap-3' },
          check(clip, 'include', 'In the join', clip.included, (value) =>
            host.setIncluded(clip.id, value),
          ),
          clip.continues
            ? check(
                clip,
                'drop-first',
                'Leave out its first frame (it repeats the clip before)',
                clip.dropFirstFrame,
                (value) => host.setDropFirstFrame(clip.id, value),
              )
            : null,
        ),
        h(
          'div',
          { class: 'row g-2' },
          trimField(clip, 'start', 'Trim start'),
          trimField(clip, 'end', 'Trim end'),
        ),
        h(
          'div',
          { class: 'd-flex flex-wrap gap-2' },
          action(
            clip,
            'Up',
            'arrow-up',
            'video-clip-up',
            `Move ${clip.name} up`,
            () => host.move(clip.id, -1),
            { unavailable: index === 0 ? `${clip.name} is already first.` : null },
          ),
          action(
            clip,
            'Down',
            'arrow-down',
            'video-clip-down',
            `Move ${clip.name} down`,
            () => host.move(clip.id, 1),
            { unavailable: index === count - 1 ? `${clip.name} is already last.` : null },
          ),
          action(
            clip,
            'Continue',
            'skip-end',
            'video-clip-continue',
            `Continue ${title} from its last frame`,
            () => host.continueFrom(clip.id),
            { disabled: !ready },
          ),
          action(
            clip,
            'Extend',
            'arrows-expand-vertical',
            'video-clip-extend',
            `Extend ${title}`,
            () => host.extend(clip.id),
          ),
          action(
            clip,
            'Frames',
            'camera',
            'video-clip-frames',
            `Grab frames from ${title}`,
            () => host.frames(clip.id),
            { disabled: !ready },
          ),
          host.downloadButton(clip),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-sm btn-outline-danger d-inline-flex align-items-center gap-1 ms-auto',
              'aria-label': `Remove ${title}`,
              'data-focus-key': `clip-remove:${clip.id}`,
              'data-testid': 'video-clip-remove',
              onclick: () => host.remove(clip.id),
            },
            icon('trash'),
            'Remove',
          ),
        ),
      ),
    );
    return item;
  };

  const focusList = (): void => {
    const target = list.querySelector<HTMLElement>('button:not(:disabled)') ?? empty;
    target.focus();
  };

  return {
    element,
    exports,
    render(clips, join) {
      for (const [id, player] of players) {
        const clip = clips.find((candidate) => candidate.id === id);
        const state = clip ? host.state(clip) : null;
        if (!clip || state?.kind !== 'ready' || state.blob !== player.blob) {
          player.dispose();
          players.delete(id);
        }
      }
      empty.hidden = clips.length > 0;
      replace(
        list,
        clips.map((clip, index) => row(clip, index, clips.length)),
      );
      const parts = joinable(clips);
      const length = joinLength(clips);
      summary.textContent = clips.length
        ? `${plural(clips.length, 'clip')}${length !== null ? ` · ${formatDuration(length)} joined` : ''}`
        : '';
      joinButton.hidden = join.busy;
      stopButton.hidden = !join.busy;
      joinButton.disabled = join.blocked !== null;
      joinButton.lastElementChild!.textContent =
        parts.length > 1 ? `Join ${parts.length} clips into one MP4` : 'Join into one MP4';
      joinNote.textContent = join.busy ? '' : (join.blocked ?? '');
      bar.element.hidden = !join.busy;
    },
    progress(ratio, label) {
      bar.update(Math.round(Math.min(1, Math.max(0, ratio)) * 100), 100, label);
    },
    focusList,
    focusJoin(which) {
      const target = which === 'stop' ? stopButton : joinButton;
      if (!target.hidden && !target.disabled) target.focus();
      else if (which === 'join') focusList();
    },
    focusClip(clipId, control) {
      return focusKey(list, `${control}:${clipId}`);
    },
  };
}
