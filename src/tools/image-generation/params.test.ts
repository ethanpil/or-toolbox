import { describe, expect, it } from 'vitest';
import type { RawImageModel } from '../../core/api/types';
import {
  approxDimensions,
  buildRequests,
  DEFAULT_FORM,
  effective,
  foldPrompt,
  formSettings,
  type GenerationForm,
  modelControls,
  parseForm,
  planRequests,
  referenceProblem,
  runSettings,
} from './params';

/** Shapes from tests/fixtures/openrouter/images-models.json. */
const GPT_IMAGE_1: RawImageModel = {
  id: 'openai/gpt-image-1',
  name: 'OpenAI: GPT Image 1',
  supported_parameters: {
    aspect_ratio: { type: 'enum', values: ['1:1', '3:2', '2:3', 'auto'] },
    quality: { type: 'enum', values: ['auto', 'low', 'medium', 'high'] },
    background: { type: 'enum', values: ['auto', 'transparent', 'opaque'] },
    n: { type: 'range', min: 1, max: 10 },
    input_references: { type: 'range', min: 0, max: 16 },
    output_compression: { type: 'range', min: 0, max: 100 },
  },
  supports_streaming: true,
};
const FLUX_PRO: RawImageModel = {
  id: 'black-forest-labs/flux.2-pro',
  name: 'Black Forest Labs: FLUX.2 Pro',
  supported_parameters: {
    aspect_ratio: { type: 'enum', values: ['1:1', '4:3', '3:4', '16:9', '9:16', 'auto'] },
    output_format: { type: 'enum', values: ['png', 'jpeg'] },
    n: { type: 'range', min: 1, max: 1 },
    input_references: { type: 'range', min: 0, max: 8 },
    seed: { type: 'boolean' },
  },
  supports_streaming: false,
};
const KREA: RawImageModel = {
  id: 'krea/krea-2-medium',
  name: 'Krea 2 Medium',
  supported_parameters: {
    resolution: { type: 'enum', values: ['1K', '2K'] },
    aspect_ratio: { type: 'enum', values: ['1:1', '16:9'] },
    input_references: { type: 'range', min: 0, max: 4 },
    seed: { type: 'boolean' },
  },
};
const MING: RawImageModel = {
  id: 'inclusionai/ming-image-0.1-design-layer',
  name: 'Ming design layer',
  supported_parameters: {
    output_format: { type: 'enum', values: ['png', 'webp'] },
    n: { type: 'range', min: 1, max: 1 },
    input_references: { type: 'range', min: 1, max: 1 },
    size: { type: 'boolean' },
  },
};
const RIVERFLOW: RawImageModel = {
  id: 'sourceful/riverflow-v2.5-fast',
  name: 'Riverflow',
  supported_parameters: {
    output_format: { type: 'enum', values: ['jpeg'] },
    background: { type: 'enum', values: ['auto', 'transparent', 'opaque'] },
  },
};

const form = (patch: Partial<GenerationForm> = {}): GenerationForm => ({
  ...DEFAULT_FORM,
  prompt: 'A lighthouse at dusk',
  ...patch,
});

describe('modelControls', () => {
  it('reads every descriptor kind; a missing key is unsupported', () => {
    expect(modelControls(GPT_IMAGE_1)).toMatchObject({
      aspectRatios: ['1:1', '3:2', '2:3', 'auto'],
      qualities: ['auto', 'low', 'medium', 'high'],
      backgrounds: ['auto', 'transparent', 'opaque'],
      outputFormats: null,
      resolutions: null,
      sizes: null,
      seed: false,
      n: { min: 1, max: 10 },
      references: { min: 0, max: 16 },
      streaming: true,
    });
    expect(modelControls(FLUX_PRO)).toMatchObject({ seed: true, n: { min: 1, max: 1 } });
    expect(modelControls(KREA).n).toBeNull();
    expect(modelControls(MING)).toMatchObject({ sizes: true, references: { min: 1, max: 1 } });
    expect(
      modelControls({ id: 'meta/muse-image', name: '', supported_parameters: {} }),
    ).toMatchObject({
      name: 'meta/muse-image',
      aspectRatios: null,
      references: null,
      n: null,
    });
  });
});

describe('buildRequests', () => {
  it('sends only the fields the model takes', () => {
    const [plan] = buildRequests({
      model: GPT_IMAGE_1.id,
      form: form({ aspectRatio: '3:2', quality: 'low', outputFormat: 'png', resolution: '2K' }),
      controls: modelControls(GPT_IMAGE_1),
      references: [],
      seed: 42,
    });
    expect(plan?.body).toEqual({
      model: 'openai/gpt-image-1',
      prompt: 'A lighthouse at dusk',
      aspect_ratio: '3:2',
      quality: 'low',
      stream: true,
    });
  });

  it('asks for several images in one request with n when the model takes it', () => {
    const plans = buildRequests({
      model: GPT_IMAGE_1.id,
      form: form({ count: 3 }),
      controls: modelControls(GPT_IMAGE_1),
      references: [],
      seed: null,
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ images: 3, body: { n: 3 } });
  });

  it('sends one request per image, each with its own seed, when the model makes one at a time', () => {
    const plans = buildRequests({
      model: FLUX_PRO.id,
      form: form({ count: 2, aspectRatio: '16:9', outputFormat: 'jpeg' }),
      controls: modelControls(FLUX_PRO),
      references: ['data:image/png;base64,AAAA'],
      seed: 7,
    });
    expect(plans.map((plan) => plan.body)).toEqual(
      [0, 1].map((i) => ({
        model: 'black-forest-labs/flux.2-pro',
        prompt: 'A lighthouse at dusk',
        aspect_ratio: '16:9',
        output_format: 'jpeg',
        seed: 7 + i,
        input_references: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
      })),
    );
    expect(plans.every((plan) => plan.body.n === undefined)).toBe(true);
  });

  it('never sends n to a model without it, caps references at the model limit, sends nothing unknown', () => {
    const [plan] = buildRequests({
      model: KREA.id,
      form: form({ resolution: '2K' }),
      controls: modelControls(KREA),
      references: ['a', 'b', 'c', 'd', 'e'].map((x) => `data:image/png;base64,${x}`),
      seed: 3,
    });
    expect(plan?.body.n).toBeUndefined();
    expect(plan?.body.seed).toBe(3);
    expect(plan?.body.resolution).toBe('2K');
    expect(plan?.body.input_references).toHaveLength(4);
    const [muse] = buildRequests({
      model: 'meta/muse-image',
      form: form({ count: 1 }),
      controls: modelControls({ id: 'meta/muse-image', name: 'Muse', supported_parameters: {} }),
      references: ['data:image/png;base64,AAAA'],
      seed: 9,
    });
    expect(muse?.body).toEqual({ model: 'meta/muse-image', prompt: 'A lighthouse at dusk' });
  });

  it('folds the style notes and what to avoid into the prompt', () => {
    expect(foldPrompt({ prompt: ' A cat ', style: 'ink drawing', negative: 'text' })).toBe(
      'A cat\n\nStyle: ink drawing\n\nAvoid: text',
    );
    expect(foldPrompt({ prompt: 'A cat', style: ' ', negative: '' })).toBe('A cat');
  });

  it('lets an explicit size replace the aspect ratio and resolution', () => {
    const controls = modelControls(MING);
    const value = effective(form({ size: '1536 x 1024', aspectRatio: '16:9' }), controls);
    expect(value).toMatchObject({ size: '1536x1024', aspectRatio: null, resolution: null });
    expect(approxDimensions(value)).toEqual({ width: 1536, height: 1024 });
    expect(effective(form({ size: 'big' }), controls).size).toBeNull();
  });
});

describe('transparency', () => {
  it('switches a JPEG choice to PNG, and says when it cannot be honoured', () => {
    const transparentPng = effective(
      form({ transparent: true, outputFormat: 'jpeg' }),
      modelControls({
        ...RIVERFLOW,
        supported_parameters: {
          ...RIVERFLOW.supported_parameters,
          output_format: { type: 'enum', values: ['jpeg', 'png'] },
        },
      }),
    );
    expect(transparentPng).toMatchObject({
      background: 'transparent',
      outputFormat: 'png',
      notes: [],
    });
    const jpegOnly = effective(form({ transparent: true }), modelControls(RIVERFLOW));
    expect(jpegOnly.background).toBeNull();
    expect(jpegOnly.notes).toEqual(['This model makes JPEG only, which cannot be transparent.']);
    expect(effective(form({ transparent: true }), modelControls(FLUX_PRO)).notes).toEqual([
      'This model cannot make transparent backgrounds.',
    ]);
  });

  it('always sends PNG or WebP with transparency when the model lists one, whatever the list order', () => {
    const withFormats = (values: string[]) =>
      modelControls({
        ...RIVERFLOW,
        supported_parameters: {
          ...RIVERFLOW.supported_parameters,
          output_format: { type: 'enum', values },
        },
      });
    // "Model default" must not be trusted to be lossless: the format is sent explicitly.
    expect(effective(form({ transparent: true }), withFormats(['png', 'jpeg'])).outputFormat).toBe(
      'png',
    );
    expect(effective(form({ transparent: true }), withFormats(['jpeg', 'webp'])).outputFormat).toBe(
      'webp',
    );
    expect(
      effective(form({ transparent: true, outputFormat: 'webp' }), withFormats(['png', 'webp']))
        .outputFormat,
    ).toBe('webp');
    // A model that lists no formats gets the background alone, with a note that the format is its choice.
    const unlisted = effective(form({ transparent: true }), modelControls(GPT_IMAGE_1));
    expect(unlisted).toMatchObject({ background: 'transparent', outputFormat: null });
    expect(unlisted.notes).toEqual([
      'This model does not say which file format it makes; transparency needs PNG or WebP.',
    ]);
  });
});

describe('planRequests, sizes and references', () => {
  it('splits the count by the model’s n limit', () => {
    expect(planRequests(4, { n: { min: 1, max: 10 } })).toEqual([4]);
    expect(planRequests(4, { n: { min: 1, max: 3 } })).toEqual([3, 1]);
    expect(planRequests(3, { n: { min: 1, max: 1 } })).toEqual([1, 1, 1]);
    expect(planRequests(2, { n: null })).toEqual([1, 1]);
    expect(planRequests(9, { n: null })).toHaveLength(4);
  });

  it('approximates the output size from the tier and the shape', () => {
    const base = { size: null, quality: null, outputFormat: null, background: null, notes: [] };
    expect(approxDimensions({ ...base, aspectRatio: null, resolution: null })).toEqual({
      width: 1024,
      height: 1024,
    });
    expect(approxDimensions({ ...base, aspectRatio: '16:9', resolution: '2K' })).toEqual({
      width: 2048,
      height: 1152,
    });
    expect(approxDimensions({ ...base, aspectRatio: '9:16', resolution: null })).toEqual({
      width: 576,
      height: 1024,
    });
  });

  it('explains reference counts the model cannot take', () => {
    expect(referenceProblem(0, modelControls(FLUX_PRO))).toBeNull();
    expect(referenceProblem(9, modelControls(FLUX_PRO))).toBe(
      'Black Forest Labs: FLUX.2 Pro takes at most 8 reference images; remove 1.',
    );
    expect(referenceProblem(0, modelControls(MING))).toBe(
      'Ming design layer needs at least 1 reference image.',
    );
    expect(referenceProblem(1, modelControls(RIVERFLOW))).toBe(
      'Riverflow does not take reference images; remove them or choose another model.',
    );
  });
});

describe('the stored form', () => {
  it('round-trips and repairs invalid values', () => {
    const full = form({
      style: 'ink',
      negative: 'text',
      aspectRatio: '16:9',
      resolution: '2K',
      size: '',
      quality: 'high',
      outputFormat: 'png',
      transparent: true,
      seed: 1234,
      seedLocked: true,
      count: 3,
    });
    expect(parseForm(full.prompt, formSettings(full))).toEqual(full);
    expect(parseForm('x', { seed: -1, count: 9, transparent: 'yes', aspectRatio: 4 })).toEqual({
      ...DEFAULT_FORM,
      prompt: 'x',
    });
  });

  it('never keeps a lock without a seed', () => {
    expect(parseForm('x', { seedLocked: true, seed: null })).toMatchObject({
      seed: null,
      seedLocked: false,
    });
  });

  it('records the seed a run used as locked, so reopening it reproduces the picture', () => {
    const asked = form({ seed: null, seedLocked: false, count: 2 });
    expect(runSettings(asked, 4242)).toEqual({
      ...formSettings(asked),
      seed: 4242,
      seedLocked: true,
    });
    // A model without seeds: nothing to lock, the form as asked.
    expect(runSettings(asked, null)).toEqual(formSettings(asked));
  });
});
