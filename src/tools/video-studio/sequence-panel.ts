/**
 * The "Sequence" form: the ordered steps (a prompt each, with optional images: reference images, or a last frame
 * the step should end on), chained or independent, a style appended to every step, repeats, a spend cap, what a
 * failed step does, the total estimate, the controls (Start, Pause, Resume, Stop, New sequence) and the progress
 * of the run, with Re-run per step.
 *
 * Step rows keep their elements across renders (their image pickers hold the pictures), so typing, focus and
 * images survive every update. While a run is active the list's shape (steps, order, mode, repeats) is fixed;
 * while it is running, prompts, image roles and the style are read-only too (a step being sent reads them), and
 * the cap and the failure rule stay editable. A paused, stopped or finished run takes edits again; they reach the
 * stored run before Resume or Re-run.
 *
 * When the run waits for a decision (`blocker`), the panel offers the ways on: continue another clip, send the
 * step without a first frame or re-run the step before (a lost clip to continue), or send it without its images.
 */
import { referencePicker, type ReferencePicker } from '../../ui/components/reference-picker';
import { h, replace } from '../../ui/dom';
import { formatEstimate, formatUsd, plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import type { ToolUi } from '../../ui/tool/types';
import { fillClipOptions } from './clip-panel';
import { VIDEO_REFERENCE_MAX } from './params';
import {
  effectiveRole,
  type FailurePolicy,
  type ImageRole,
  isActive,
  MAX_REPEAT,
  MAX_STEPS,
  moneyText,
  type SequenceMode,
  type SequenceRun,
  type SequenceSpec,
  type Slot,
  spentIsEstimate,
  spentUsd,
  type StepSpec,
} from './sequence';
import type { TimelineClip } from './timeline';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export interface SequencePanelHost {
  ui: Pick<ToolUi, 'status'>;
  onSpec(patch: Partial<Omit<SequenceSpec, 'steps'>>): void;
  onSteps(steps: StepSpec[]): void;
  /** A step prompt or image role was edited (to write to the stored run). */
  onStepEdit(stepId: string): void;
  onSource(clipId: string | null): void;
  onImages(stepId: string): void;
  newStepId(): string;
  start(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  clear(): void;
  rerun(slotKey: string): void;
  /** Blocker answers: continue `clipId` (null: no first frame), drop a step's images, re-run the step before. */
  chooseSource(slotKey: string, clipId: string | null): void;
  dropImages(stepId: string): void;
  rerunPrevious(slotKey: string): void;
}

export interface SequenceView {
  spec: SequenceSpec;
  run: SequenceRun | null;
  /** Clips that can be continued (usable here), for the source and the blocker's choice. */
  clips: readonly TimelineClip[];
  sourceId: string | null;
  /** The model can end a clip on a chosen frame. */
  lastFrame: boolean;
  perStep: number | null;
  total: number | null;
  /** Start is unavailable (with the reason), e.g. no model. */
  blocked: string | null;
  /** Resume is unavailable (with the reason): checked against the run's own model. */
  resumeBlocked: string | null;
}

export interface SequencePanel {
  readonly element: HTMLElement;
  /** Where the shared clip format fields go while this panel shows. */
  readonly formatSlot: HTMLElement;
  /** The image picker of a step (its pictures are memory-only). */
  images(stepId: string): ReferencePicker | undefined;
  /** Moves focus to a step's prompt. */
  focusStep(stepId: string): void;
  render(view: SequenceView): void;
}

interface StepRow {
  id: string;
  element: HTMLElement;
  heading: HTMLElement;
  prompt: HTMLTextAreaElement;
  role: HTMLSelectElement;
  roleField: HTMLElement;
  picker: ReferencePicker;
  pickerSlot: HTMLElement;
  note: HTMLElement;
  up: HTMLButtonElement;
  down: HTMLButtonElement;
  remove: HTMLButtonElement;
}

const STATUS_TEXT: Record<Slot['status'], string> = {
  pending: 'Waiting',
  starting: 'Sending',
  running: 'Generating',
  done: 'Done',
  failed: 'Failed',
};
const STATUS_BADGE: Record<Slot['status'], string> = {
  pending: 'text-bg-secondary',
  starting: 'text-bg-primary',
  running: 'text-bg-primary',
  done: 'text-bg-success',
  failed: 'text-bg-danger',
};

export function sequencePanel(host: SequencePanelHost): SequencePanel {
  const ids = {
    source: uid('seq-source'),
    style: uid('seq-style'),
    repeat: uid('seq-repeat'),
    cap: uid('seq-cap'),
    capHelp: uid('seq-cap-help'),
    failure: uid('seq-failure'),
    stepsHeading: uid('seq-steps'),
  };
  let view: SequenceView | null = null;
  const rows = new Map<string, StepRow>();

  // --- mode -------------------------------------------------------------------------------------------------
  const modeName = uid('seq-mode');
  const modeChoice = (value: SequenceMode, label: string, help: string) => {
    const id = uid('seq-mode-option');
    const input = h('input', {
      id,
      type: 'radio',
      class: 'form-check-input',
      name: modeName,
      value,
      'data-testid': `seq-mode-${value}`,
      onchange: () => input.checked && host.onSpec({ mode: value }),
    });
    return {
      input,
      element: h(
        'div',
        { class: 'form-check' },
        input,
        h(
          'label',
          { class: 'form-check-label', htmlFor: id },
          h('span', { class: 'fw-semibold' }, label),
          ` · ${help}`,
        ),
      ),
    };
  };
  const chained = modeChoice(
    'chained',
    'Chained',
    'each step continues from the last frame of the one before',
  );
  const independent = modeChoice(
    'independent',
    'Independent',
    'each step is its own clip, up to 3 at once',
  );
  const modeFieldset = h(
    'fieldset',
    null,
    h('legend', { class: 'form-label fw-semibold fs-6 mb-1' }, 'How steps connect'),
    chained.element,
    independent.element,
  );

  const source = h('select', {
    id: ids.source,
    class: 'form-select',
    'data-testid': 'seq-source',
    onchange: () => host.onSource(source.value || null),
  });
  const sourceField = h(
    'div',
    null,
    h('label', { class: 'form-label', htmlFor: ids.source }, 'First step continues (optional)'),
    source,
  );

  // --- steps ------------------------------------------------------------------------------------------------
  const stepList = h('ol', {
    class: 'list-unstyled d-flex flex-column gap-3 mb-0',
    'aria-labelledby': ids.stepsHeading,
    'data-testid': 'seq-steps',
  });
  const addStep = h(
    'button',
    {
      type: 'button',
      class:
        'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1 align-self-start',
      'data-focus-key': 'seq-add-step',
      'data-testid': 'seq-add-step',
      onclick: () => {
        if (!view) return;
        const id = host.newStepId();
        host.onSteps([...view.spec.steps, { id, prompt: '', imageRole: 'references' }]);
        requestAnimationFrame(() => rows.get(id)?.prompt.focus());
      },
    },
    icon('plus-lg'),
    'Add a step',
  );

  const steps = (): StepSpec[] => view?.spec.steps.map((step) => ({ ...step })) ?? [];
  const moveStep = (id: string, delta: number, key: string): void => {
    const list = steps();
    const from = list.findIndex((step) => step.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= list.length) return;
    const [step] = list.splice(from, 1);
    list.splice(to, 0, step!);
    host.onSteps(list);
    requestAnimationFrame(() => {
      const row = rows.get(id);
      const target = key === 'up' ? row?.up : row?.down;
      (target && !target.disabled ? target : row?.prompt)?.focus();
    });
  };

  const createRow = (step: StepSpec): StepRow => {
    const promptId = uid('seq-step-prompt');
    const roleId = uid('seq-step-role');
    const heading = h('h4', { class: 'h6 mb-0 me-auto' });
    const prompt = h('textarea', {
      id: promptId,
      class: 'form-control',
      rows: 2,
      placeholder: 'What happens in this step',
      'data-testid': 'seq-step-prompt',
      oninput: () => {
        host.onSteps(steps().map((s) => (s.id === step.id ? { ...s, prompt: prompt.value } : s)));
        host.onStepEdit(step.id);
      },
    });
    const role = h(
      'select',
      {
        id: roleId,
        class: 'form-select form-select-sm',
        'data-testid': 'seq-step-role',
        onchange: () => {
          const value: ImageRole = role.value === 'last-frame' ? 'last-frame' : 'references';
          host.onSteps(steps().map((s) => (s.id === step.id ? { ...s, imageRole: value } : s)));
          host.onStepEdit(step.id);
        },
      },
      h('option', { value: 'references' }, 'Reference images (style or content)'),
      h('option', { value: 'last-frame' }, 'A last frame the step ends on'),
    );
    const roleField = h(
      'div',
      null,
      h('label', { class: 'form-label small mb-1', htmlFor: roleId }, 'Images for this step'),
      role,
    );
    const picker = referencePicker({
      ui: host.ui,
      max: VIDEO_REFERENCE_MAX,
      label: 'Images',
      headingLevel: 5,
      accepts: IMAGE_TYPES,
      focusFallback: () => prompt,
      testId: 'seq-step',
    });
    picker.onChange(() => host.onImages(step.id));
    const pickerSlot = h('div', null, picker.element);
    const note = h('div', { class: 'form-text mt-0 empty-hidden', 'data-testid': 'seq-step-note' });
    const iconButton = (glyph: string, testId: string, onclick: () => void) =>
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-outline-secondary',
          'data-focus-key': `seq-${testId}:${step.id}`,
          'data-testid': `seq-step-${testId}`,
          onclick,
        },
        icon(glyph),
      );
    const up = iconButton('arrow-up', 'up', () => moveStep(step.id, -1, 'up'));
    const down = iconButton('arrow-down', 'down', () => moveStep(step.id, 1, 'down'));
    const remove = iconButton('x-lg', 'remove', () => {
      const list = steps();
      const index = list.findIndex((s) => s.id === step.id);
      host.onSteps(list.filter((s) => s.id !== step.id));
      requestAnimationFrame(() => {
        const next = list[index + 1] ?? list[index - 1];
        (next ? rows.get(next.id)?.prompt : addStep)?.focus();
      });
    });
    const element = h(
      'li',
      { class: 'border rounded-3 p-3 d-flex flex-column gap-2', 'data-testid': 'seq-step' },
      h('div', { class: 'd-flex align-items-center gap-1' }, heading, up, down, remove),
      h('label', { class: 'visually-hidden', htmlFor: promptId }, 'Prompt'),
      prompt,
      roleField,
      pickerSlot,
      note,
    );
    return {
      id: step.id,
      element,
      heading,
      prompt,
      role,
      roleField,
      picker,
      pickerSlot,
      note,
      up,
      down,
      remove,
    };
  };

  // --- shared options ---------------------------------------------------------------------------------------
  const style = h('input', {
    id: ids.style,
    type: 'text',
    class: 'form-control',
    autocomplete: 'off',
    placeholder: 'For example: 35 mm film, warm evening light',
    'data-testid': 'seq-style',
    oninput: () => host.onSpec({ style: style.value }),
  });
  const repeat = h('input', {
    id: ids.repeat,
    type: 'number',
    class: 'form-control',
    min: '1',
    max: String(MAX_REPEAT),
    step: '1',
    inputMode: 'numeric',
    'data-testid': 'seq-repeat',
    onchange: () => {
      const value = Math.round(Number(repeat.value));
      host.onSpec({
        repeat: Math.min(MAX_REPEAT, Math.max(1, Number.isFinite(value) ? value : 1)),
      });
    },
  });
  const cap = h('input', {
    id: ids.cap,
    type: 'number',
    class: 'form-control',
    min: '0',
    step: '0.01',
    inputMode: 'decimal',
    placeholder: 'No cap',
    'aria-describedby': ids.capHelp,
    'data-testid': 'seq-cap',
    onchange: () => {
      const value = Number(cap.value);
      host.onSpec({ capUsd: cap.value.trim() !== '' && value > 0 ? value : null });
    },
  });
  const failure = h(
    'select',
    {
      id: ids.failure,
      class: 'form-select',
      'data-testid': 'seq-failure',
      onchange: () => host.onSpec({ onFailure: failure.value as FailurePolicy }),
    },
    h('option', { value: 'stop' }, 'Stop'),
    h('option', { value: 'skip' }, 'Skip it'),
  );
  const estimate = h('p', { class: 'small mb-0', 'data-testid': 'seq-estimate' });

  // --- controls and progress --------------------------------------------------------------------------------
  const button = (
    label: string,
    glyph: string,
    testId: string,
    variant: string,
    onclick: () => void,
  ) =>
    h(
      'button',
      {
        type: 'button',
        class: `btn ${variant} d-inline-flex align-items-center gap-2`,
        'data-focus-key': testId,
        'data-testid': testId,
        onclick,
      },
      icon(glyph),
      label,
    );
  const startButton = button('Start sequence', 'collection-play', 'seq-start', 'btn-primary', () =>
    host.start(),
  );
  const pauseButton = button('Pause', 'pause-fill', 'seq-pause', 'btn-outline-secondary', () =>
    host.pause(),
  );
  const resumeButton = button('Resume', 'play-fill', 'seq-resume', 'btn-primary', () =>
    host.resume(),
  );
  const stopButton = button('Stop', 'stop-fill', 'seq-stop', 'btn-outline-danger', () =>
    host.stop(),
  );
  const clearButton = button('New sequence', 'x-circle', 'seq-clear', 'btn-outline-secondary', () =>
    host.clear(),
  );
  const blockedNote = h('span', {
    class: 'small text-warning-emphasis',
    'data-testid': 'seq-blocked',
  });
  const controls = h(
    'div',
    { class: 'd-flex flex-wrap align-items-center gap-2' },
    startButton,
    pauseButton,
    resumeButton,
    stopButton,
    clearButton,
    blockedNote,
  );
  const message = h('div', {
    class: 'small empty-hidden',
    role: 'note',
    'data-testid': 'seq-message',
  });
  const progress = h('ol', {
    class: 'list-group list-group-numbered empty-hidden',
    'aria-label': 'Sequence progress',
    'data-testid': 'seq-progress',
  });
  const spent = h('p', {
    class: 'small text-body-secondary mb-0 empty-hidden',
    'data-testid': 'seq-spent',
  });
  const formatSlot = h('div');
  const blockerBox = h('div', {
    class: 'alert alert-warning d-flex flex-column gap-2 mb-0',
    role: 'group',
    hidden: true,
    'data-testid': 'seq-blocker',
  });
  const blockerSourceId = uid('seq-blocker-source');

  const element = h(
    'div',
    { class: 'd-flex flex-column gap-3', 'data-testid': 'video-sequence-panel' },
    modeFieldset,
    sourceField,
    h(
      'section',
      { class: 'd-flex flex-column gap-2', 'aria-labelledby': ids.stepsHeading },
      h('h3', { id: ids.stepsHeading, class: 'form-label fw-semibold fs-6 mb-0' }, 'Steps'),
      stepList,
      addStep,
    ),
    h(
      'div',
      null,
      h('label', { class: 'form-label', htmlFor: ids.style }, 'Style for every step (optional)'),
      style,
    ),
    h(
      'div',
      { class: 'row g-3' },
      h(
        'div',
        { class: 'col-sm-4' },
        h('label', { class: 'form-label', htmlFor: ids.repeat }, 'Run the list'),
        h(
          'div',
          { class: 'input-group' },
          repeat,
          h('span', { class: 'input-group-text' }, 'times'),
        ),
      ),
      h(
        'div',
        { class: 'col-sm-4' },
        h('label', { class: 'form-label', htmlFor: ids.cap }, 'Spend cap'),
        h('div', { class: 'input-group' }, h('span', { class: 'input-group-text' }, '$'), cap),
        h('div', { id: ids.capHelp, class: 'form-text' }, 'Stops before a step would pass it.'),
      ),
      h(
        'div',
        { class: 'col-sm-4' },
        h('label', { class: 'form-label', htmlFor: ids.failure }, 'If a step fails'),
        failure,
      ),
    ),
    formatSlot,
    estimate,
    controls,
    message,
    blockerBox,
    spent,
    progress,
  );

  const smallButton = (
    label: string,
    testId: string,
    key: string,
    onclick: () => void,
    variant = 'btn-outline-secondary',
  ) =>
    h(
      'button',
      {
        type: 'button',
        class: `btn btn-sm ${variant}`,
        'data-focus-key': key,
        'data-testid': testId,
        onclick,
      },
      label,
    );

  /** The ways on from a blocked step. */
  const blockerChoices = (
    run: SequenceRun,
    clips: readonly TimelineClip[],
  ): (HTMLElement | null)[] => {
    const blocker = run.blocker;
    if (!blocker) return [];
    const index = run.slots.findIndex((slot) => slot.key === blocker.slotKey);
    const slot = run.slots[index];
    if (!slot) return [];
    if (blocker.kind === 'images-lost') {
      return [
        h('div', null, blocker.message),
        h(
          'div',
          { class: 'd-flex flex-wrap gap-2' },
          smallButton(
            'Send it without its images',
            'seq-blocker-drop-images',
            `blocker-drop:${slot.key}`,
            () => host.dropImages(slot.stepId),
          ),
        ),
      ];
    }
    const choose = h('select', {
      id: blockerSourceId,
      class: 'form-select form-select-sm w-auto',
      'data-focus-key': `blocker-source:${slot.key}`,
      'data-testid': 'seq-blocker-source',
    });
    fillClipOptions(choose, clips, 'Choose a clip…');
    const previous = run.slots[index - 1];
    const canRerunPrevious =
      previous !== undefined && (previous.status === 'done' || previous.status === 'failed');
    return [
      h('div', null, blocker.message),
      clips.length > 0
        ? h(
            'div',
            { class: 'd-flex flex-wrap align-items-center gap-2' },
            h(
              'label',
              { class: 'small', htmlFor: blockerSourceId },
              'Continue from an earlier clip',
            ),
            choose,
            smallButton(
              'Continue from it',
              'seq-blocker-continue',
              `blocker-continue:${slot.key}`,
              () => {
                if (choose.value) host.chooseSource(slot.key, choose.value);
                else {
                  host.ui.status('Choose the clip to continue first.');
                  choose.focus();
                }
              },
            ),
          )
        : null,
      h(
        'div',
        { class: 'd-flex flex-wrap gap-2' },
        smallButton(
          'Send without a first frame',
          'seq-blocker-no-frame',
          `blocker-no-frame:${slot.key}`,
          () => host.chooseSource(slot.key, null),
        ),
        canRerunPrevious
          ? smallButton(
              'Re-run the previous step',
              'seq-blocker-rerun-previous',
              `blocker-rerun:${slot.key}`,
              () => host.rerunPrevious(slot.key),
            )
          : null,
      ),
    ];
  };

  const slotRow = (run: SequenceRun, slot: Slot): HTMLElement => {
    const step = run.spec.steps.findIndex((candidate) => candidate.id === slot.stepId);
    const rounds = run.spec.repeat > 1 ? ` · round ${slot.round + 1}` : '';
    const name = `Step ${step + 1}${rounds}`;
    const canRerun = slot.status === 'done' || slot.status === 'failed';
    return h(
      'li',
      {
        class: 'list-group-item d-flex flex-wrap align-items-center gap-2',
        'data-testid': 'seq-slot',
        'data-status': slot.status,
      },
      h('span', { class: 'fw-semibold' }, name),
      h(
        'span',
        { class: `badge rounded-pill ${STATUS_BADGE[slot.status]}` },
        STATUS_TEXT[slot.status],
      ),
      slot.attempt > 1
        ? h('span', { class: 'small text-body-secondary' }, `take ${slot.attempt}`)
        : null,
      slot.spentUsd > 0
        ? h(
            'span',
            { class: 'small text-body-secondary' },
            moneyText(slot.spentUsd, slot.spentEstimated),
          )
        : slot.estimateUsd !== null && (slot.status === 'starting' || slot.status === 'running')
          ? h('span', { class: 'small text-body-secondary' }, formatEstimate(slot.estimateUsd))
          : null,
      slot.stale
        ? h(
            'span',
            { class: 'small text-warning-emphasis', 'data-testid': 'seq-slot-stale' },
            'Made from the old take of the step before: re-run it to continue the new one',
          )
        : null,
      canRerun
        ? h(
            'button',
            {
              type: 'button',
              class:
                'btn btn-sm btn-outline-secondary ms-auto d-inline-flex align-items-center gap-1',
              'aria-label': `Re-run ${name.toLowerCase()}`,
              'data-focus-key': `seq-rerun:${slot.key}`,
              'data-testid': 'seq-rerun',
              onclick: () => host.rerun(slot.key),
            },
            icon('arrow-repeat'),
            'Re-run',
          )
        : null,
      slot.error
        ? h(
            'div',
            { class: 'w-100 small text-danger-emphasis', 'data-testid': 'seq-slot-error' },
            slot.error,
          )
        : null,
    );
  };

  const render = (next: SequenceView): void => {
    view = next;
    const { spec, run } = next;
    const active = isActive(run);
    const running = run?.status === 'running';
    // A running sequence reads its steps as it sends them: they are read-only until it pauses or ends.
    const locked = running;
    // Shape is fixed while a run is active.
    chained.input.checked = spec.mode === 'chained';
    independent.input.checked = spec.mode === 'independent';
    chained.input.disabled = active;
    independent.input.disabled = active;
    sourceField.hidden = spec.mode !== 'chained';
    fillClipOptions(source, next.clips, 'None: the first step starts from its prompt');
    const sourceId = active ? (run?.sourceClipId ?? null) : next.sourceId;
    source.value = sourceId && next.clips.some((clip) => clip.id === sourceId) ? sourceId : '';
    source.disabled = active;

    // Step rows: reuse, reorder, drop the removed ones.
    const keep = new Set(spec.steps.map((step) => step.id));
    for (const [id, row] of rows) {
      if (!keep.has(id)) {
        row.picker.clear();
        row.element.remove();
        rows.delete(id);
      }
    }
    const fromSource = sourceId !== null;
    spec.steps.forEach((step, index) => {
      let row = rows.get(step.id);
      if (!row) {
        row = createRow(step);
        rows.set(step.id, row);
      }
      if (stepList.children[index] !== row.element)
        stepList.insertBefore(row.element, stepList.children[index] ?? null);
      row.heading.textContent = `Step ${index + 1}`;
      if (document.activeElement !== row.prompt && row.prompt.value !== step.prompt)
        row.prompt.value = step.prompt;
      row.prompt.setAttribute('aria-label', `Step ${index + 1} prompt`);
      row.prompt.readOnly = locked;
      const fromFrame = spec.mode === 'chained' && (index > 0 || fromSource);
      const role = effectiveRole(step.imageRole, fromFrame, next.lastFrame);
      row.role.value = role ?? step.imageRole;
      const referencesOption = row.role.options[0]!;
      const lastOption = row.role.options[1]!;
      referencesOption.disabled = fromFrame;
      lastOption.disabled = !next.lastFrame;
      row.role.disabled = locked;
      row.roleField.hidden = role === null;
      row.pickerSlot.hidden = role === null;
      row.picker.setLimits({
        max: role === 'last-frame' ? 1 : role === 'references' ? VIDEO_REFERENCE_MAX : 0,
      });
      row.note.textContent =
        role === null
          ? 'This step starts from the last frame of the clip before it, and this model cannot end on a chosen frame, so it takes no images.'
          : fromFrame
            ? 'Starts from the last frame of the clip before it. Reference images cannot go with a frame, so only a last frame can be added.'
            : role === 'last-frame'
              ? 'A last frame alone is not sent: this step starts from no frame. Use reference images, or chain it from a clip.'
              : '';
      row.up.disabled = active || index === 0;
      row.down.disabled = active || index === spec.steps.length - 1;
      row.remove.disabled = active || spec.steps.length === 1;
      row.up.setAttribute('aria-label', `Move step ${index + 1} up`);
      row.down.setAttribute('aria-label', `Move step ${index + 1} down`);
      row.remove.setAttribute('aria-label', `Remove step ${index + 1}`);
    });
    addStep.disabled = active || spec.steps.length >= MAX_STEPS;

    if (document.activeElement !== style && style.value !== spec.style) style.value = spec.style;
    style.readOnly = locked;
    if (document.activeElement !== repeat) repeat.value = String(spec.repeat);
    repeat.disabled = active;
    if (document.activeElement !== cap) cap.value = spec.capUsd === null ? '' : String(spec.capUsd);
    failure.value = spec.onFailure;

    const clips = spec.steps.length * spec.repeat;
    estimate.textContent =
      next.total === null
        ? `${plural(clips, 'clip')}; the cost cannot be estimated for this model.`
        : `About ${formatUsd(next.total)} for ${plural(clips, 'clip')} (${formatEstimate(next.perStep)} each).`;

    // Controls follow the run; when the pressed one goes (Start → Pause), the next visible one takes focus.
    const hadFocus = controls.contains(document.activeElement);
    startButton.hidden = active;
    pauseButton.hidden = !running;
    resumeButton.hidden = !(run?.status === 'paused' || run?.status === 'stopped');
    stopButton.hidden = !(running || run?.status === 'paused');
    clearButton.hidden = !run || running;
    startButton.disabled = next.blocked !== null;
    resumeButton.disabled = next.resumeBlocked !== null;
    blockedNote.textContent = (active ? next.resumeBlocked : next.blocked) ?? '';
    const focused = document.activeElement;
    if (
      hadFocus &&
      (!(focused instanceof HTMLElement) || focused.hidden || !controls.contains(focused))
    ) {
      [pauseButton, resumeButton, startButton, stopButton, clearButton]
        .find((candidate) => !candidate.hidden && !candidate.disabled)
        ?.focus();
    }

    // A blocked run shows its message with the ways on; any other message on its own.
    message.textContent = run?.blocker ? '' : (run?.message ?? '');
    message.className = [
      'small empty-hidden',
      run?.status === 'stopped' ? 'text-danger-emphasis' : 'text-body-secondary',
    ].join(' ');
    const blockerKey = run?.blocker
      ? JSON.stringify([run.blocker, next.clips.map((clip) => clip.id)])
      : '';
    if (blockerKey !== renderedBlocker) {
      renderedBlocker = blockerKey;
      replace(blockerBox, run ? blockerChoices(run, next.clips) : null);
    }
    blockerBox.hidden = !run?.blocker;
    spent.textContent = run
      ? `Spent so far: ${moneyText(spentUsd(run), spentIsEstimate(run))}${run.spec.capUsd !== null ? ` of a ${formatUsd(run.spec.capUsd)} cap` : ''}.`
      : '';
    replace(progress, run ? run.slots.map((slot) => slotRow(run, slot)) : null);
  };
  let renderedBlocker = '';

  return {
    element,
    formatSlot,
    images: (stepId) => rows.get(stepId)?.picker,
    focusStep: (stepId) => rows.get(stepId)?.prompt.focus(),
    render,
  };
}
