/**
 * The clip format controls: duration, resolution, aspect ratio and sound in the input zone; exact size and seed in
 * the Settings drawer. Each select lists what the current model offers and shows what will be sent (the
 * substitutions are explained by the notes under the form); a choice goes back to the tool through `onChange`.
 */
import { h, replace } from '../../ui/dom';
import { setFieldError } from '../../ui/feedback/field-error';
import { uid } from '../../ui/id';
import { type ClipFormat, MAX_SEED } from './format';
import { effectiveFormat, resolutionRank, type VideoControls } from './params';

export interface FormatFields {
  /** Duration, resolution, aspect ratio, sound. */
  readonly main: HTMLElement;
  /** Exact size and seed. */
  readonly drawer: HTMLElement;
  render(format: ClipFormat, controls: VideoControls | null): void;
}

export function formatFields(options: {
  onChange: (patch: Partial<ClipFormat>) => void;
}): FormatFields {
  const ids = {
    duration: uid('video-duration'),
    resolution: uid('video-resolution'),
    aspect: uid('video-aspect'),
    audio: uid('video-audio'),
    size: uid('video-size'),
    seed: uid('video-seed'),
    seedHelp: uid('video-seed-help'),
  };
  const select = (id: string, testId: string, onchange: (value: string) => void) => {
    const element = h('select', {
      id,
      class: 'form-select',
      'data-testid': testId,
      onchange: () => onchange(element.value),
    });
    return element;
  };
  const duration = select(ids.duration, 'video-duration', (value) =>
    options.onChange({ duration: Number(value) }),
  );
  const resolution = select(ids.resolution, 'video-resolution', (value) =>
    options.onChange({ resolution: value || null }),
  );
  const aspect = select(ids.aspect, 'video-aspect', (value) =>
    options.onChange({ aspectRatio: value }),
  );
  const audio = select(ids.audio, 'video-audio', (value) =>
    options.onChange({ audio: value === 'on' || value === 'off' ? value : 'model' }),
  );
  const audioNote = h('div', { class: 'form-text', 'data-testid': 'video-audio-note' });
  const size = select(ids.size, 'video-size', (value) => options.onChange({ size: value || null }));
  const seed = h('input', {
    id: ids.seed,
    type: 'number',
    class: 'form-control',
    min: '0',
    max: String(MAX_SEED),
    step: '1',
    inputMode: 'numeric',
    placeholder: 'Random',
    'aria-describedby': ids.seedHelp,
    'data-testid': 'video-seed',
  });
  const seedError = h('div', { class: 'invalid-feedback', 'data-testid': 'video-seed-error' });
  seed.addEventListener('change', () => {
    const text = seed.value.trim();
    const value = Number(text);
    const valid = text === '' || (Number.isInteger(value) && value >= 0 && value <= MAX_SEED);
    // An entry that is not a seed is said, and nothing is sent until it is fixed (a new seed each time).
    setFieldError(
      seed,
      seedError,
      valid
        ? null
        : `Enter a whole number from 0 to ${MAX_SEED.toLocaleString('en-US')}, or leave it empty. Until then a new seed is used each time.`,
    );
    options.onChange({ seed: valid && text !== '' ? value : null });
  });
  const seedHelp = h('div', { id: ids.seedHelp, class: 'form-text' });

  const field = (id: string, label: string, control: HTMLElement, ...extra: HTMLElement[]) =>
    h(
      'div',
      { class: 'col-sm-6' },
      h('label', { class: 'form-label', htmlFor: id }, label),
      control,
      ...extra,
    );
  const durationField = field(ids.duration, 'Length', duration);
  const resolutionField = field(ids.resolution, 'Resolution', resolution);
  const aspectField = field(ids.aspect, 'Shape', aspect);
  const audioField = field(ids.audio, 'Sound', audio, audioNote);
  const main = h(
    'fieldset',
    { 'data-testid': 'video-format' },
    h('legend', { class: 'form-label fw-semibold fs-6 mb-1' }, 'Clip format'),
    h('div', { class: 'row g-3' }, durationField, resolutionField, aspectField, audioField),
  );
  const sizeField = h(
    'div',
    null,
    h('label', { class: 'form-label', htmlFor: ids.size }, 'Exact size'),
    size,
    h('div', { class: 'form-text' }, 'Replaces the resolution and shape.'),
  );
  const drawer = h(
    'div',
    { class: 'vstack gap-3' },
    sizeField,
    h(
      'div',
      null,
      h('label', { class: 'form-label', htmlFor: ids.seed }, 'Seed'),
      seed,
      seedError,
      seedHelp,
    ),
  );

  const options$ = (values: readonly string[], label: (value: string) => string) =>
    values.map((value) => h('option', { value }, label(value)));

  return {
    main,
    drawer,
    render(format, controls) {
      const value = effectiveFormat(format, controls);
      // Unknown model options: the fields show what was asked for, and nothing of it is sent.
      const durations = controls?.durations ?? [format.duration];
      replace(
        duration,
        options$(durations.map(String), (d) => `${d} s`),
      );
      duration.value = String(value.duration ?? format.duration);
      duration.disabled = !controls?.durations;

      const resolutions = controls?.resolutions
        ? [...controls.resolutions].sort((a, b) => resolutionRank(a) - resolutionRank(b))
        : null;
      resolutionField.hidden = resolutions === null;
      replace(
        resolution,
        options$(resolutions ?? [], (r) => r),
      );
      resolution.value = value.resolution ?? '';
      resolution.disabled = value.size !== null;

      aspectField.hidden = !controls?.aspectRatios;
      replace(
        aspect,
        options$(controls?.aspectRatios ?? [], (a) => a),
      );
      aspect.value = value.aspectRatio ?? '';
      aspect.disabled = value.size !== null;

      audioField.hidden = controls?.audio === null || controls === null;
      replace(
        audio,
        h('option', { value: 'model' }, 'Model default (with sound)'),
        h('option', { value: 'on' }, 'With sound'),
        h('option', { value: 'off' }, 'Silent'),
      );
      audio.value = format.audio;
      audio.disabled = controls?.audio !== true;
      audioNote.textContent = controls?.audio === false ? 'This model makes silent video.' : '';

      sizeField.hidden = !controls?.sizes;
      replace(
        size,
        h('option', { value: '' }, 'None: use the resolution and shape'),
        options$(controls?.sizes ?? [], (s) => s.replace('x', ' × ')),
      );
      size.value = value.size ?? '';

      // The field shows what will be sent: nothing for a model without a seed. An entry being fixed is left alone.
      const seeded = controls?.seed === true;
      const fixing = seed.getAttribute('aria-invalid') === 'true';
      if (document.activeElement !== seed && !fixing) {
        seed.value = seeded && value.seed !== null ? String(value.seed) : '';
      }
      seed.disabled = !seeded;
      seed.placeholder = seeded ? 'Random' : 'Not sent';
      if (!seeded) setFieldError(seed, seedError, null);
      seedHelp.textContent = seeded
        ? 'Empty: a new seed each time. A number repeats a result with the same settings (not guaranteed).'
        : 'This model does not take a seed, so none is sent.';
    },
  };
}
