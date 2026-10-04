import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RawVideoModel } from '../../core/api/types';
import { DEFAULT_FORMAT, parseFormat } from './format';
import {
  buildVideoRequest,
  controlsFor,
  DEFAULT_SETTINGS,
  effectiveFormat,
  extendNote,
  extendPlan,
  isPublicHttpsUrl,
  modeProblem,
  nearestDuration,
  parseSettings,
  settingsJson,
  VIDEO_REFERENCE_MAX,
  type VideoControls,
  videoControls,
} from './params';

const models = (
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../../tests/fixtures/openrouter/videos-models.json'),
      'utf8',
    ),
  ) as { data: RawVideoModel[] }
).data;
const raw = (id: string): RawVideoModel => models.find((model) => model.id === id)!;
const controls = (id: string): VideoControls => videoControls(raw(id));
const GROK = 'x-ai/grok-imagine-video';
const SEEDANCE = 'bytedance/seedance-2.0-mini';
const VEO = 'google/veo-3.1-fast';

const inputs = {
  prompt: 'A boat',
  firstFrame: false,
  lastFrame: false,
  references: 0,
  source: false,
  extendUrl: '',
};

describe('model controls', () => {
  it('reads what a model offers from /videos/models', () => {
    expect(controls(GROK)).toMatchObject({
      id: GROK,
      durations: Array.from({ length: 15 }, (_, i) => i + 1),
      resolutions: ['480p', '720p'],
      firstFrame: true,
      lastFrame: false,
      audio: null,
      seed: false,
      videoInput: false,
      previousJob: false,
    });
    expect(controls(SEEDANCE)).toMatchObject({
      firstFrame: true,
      lastFrame: true,
      audio: true,
      seed: true,
      videoInput: true,
    });
  });

  it('tells ready, missing (editors, unknown ids) and unknown (no list) apart', () => {
    expect(controlsFor(models, GROK).status).toBe('ready');
    expect(controlsFor(models, 'black-forest-labs/flux-video-edit').status).toBe('missing');
    expect(controlsFor(models, 'nobody/nothing').status).toBe('missing');
    expect(controlsFor(null, GROK).status).toBe('unknown');
    expect(controlsFor([], GROK).status).toBe('unknown');
  });
});

describe('effective format', () => {
  it('sends what the model takes, with a note for each substitution', () => {
    const veo = controls(VEO); // 4, 6, 8 s; 720p, 1080p, 4K; 16:9 and 9:16
    const value = effectiveFormat(
      { ...DEFAULT_FORMAT, duration: 5, resolution: '480p', aspectRatio: '1:1' },
      veo,
    );
    expect(value).toMatchObject({ duration: 4, resolution: '720p', aspectRatio: '16:9' });
    expect(value.notes).toHaveLength(3);
    expect(nearestDuration([4, 6, 8], 7)).toBe(6);
    expect(nearestDuration([4, 6, 8], 5)).toBe(4);
  });

  it('picks the cheapest resolution when none was chosen', () => {
    expect(effectiveFormat(DEFAULT_FORMAT, controls(GROK)).resolution).toBe('480p');
    expect(effectiveFormat(DEFAULT_FORMAT, controls(VEO)).resolution).toBe('720p');
  });

  it('uses an offered exact size instead of resolution and shape', () => {
    const value = effectiveFormat({ ...DEFAULT_FORMAT, size: '480x480' }, controls(GROK));
    expect(value).toMatchObject({ size: '480x480', resolution: null, aspectRatio: null });
    const refused = effectiveFormat({ ...DEFAULT_FORMAT, size: '999x999' }, controls(GROK));
    expect(refused.size).toBeNull();
    expect(refused.notes[0]).toContain('999x999 is not offered');
  });

  it('sends generate_audio only to models with the flag, and only when chosen', () => {
    const seedance = controls(SEEDANCE);
    expect(effectiveFormat(DEFAULT_FORMAT, seedance)).toMatchObject({
      generateAudio: null,
      withAudio: true,
    });
    expect(effectiveFormat({ ...DEFAULT_FORMAT, audio: 'off' }, seedance)).toMatchObject({
      generateAudio: false,
      withAudio: false,
    });
    // Grok lists no flag: nothing is sent, and the estimate takes the dearer option.
    expect(effectiveFormat({ ...DEFAULT_FORMAT, audio: 'off' }, controls(GROK))).toMatchObject({
      generateAudio: null,
      withAudio: null,
    });
    const runway = controls('runway/gen-4.5');
    const silent = effectiveFormat({ ...DEFAULT_FORMAT, audio: 'on' }, runway);
    expect(silent.withAudio).toBe(false);
    expect(silent.notes).toContain(`${runway.name} makes silent video.`);
  });

  it('sends a seed only to models that take one', () => {
    expect(effectiveFormat({ ...DEFAULT_FORMAT, seed: 7 }, controls(SEEDANCE)).seed).toBe(7);
    expect(effectiveFormat({ ...DEFAULT_FORMAT, seed: 7 }, controls(GROK)).seed).toBeNull();
  });

  it('sends nothing of the format when the model options are unknown', () => {
    expect(effectiveFormat({ ...DEFAULT_FORMAT, seed: 3 }, null)).toMatchObject({
      duration: null,
      resolution: null,
      aspectRatio: null,
      seed: null,
    });
  });
});

describe('requests', () => {
  it('maps a text-to-video form to the body', () => {
    const { body, images } = buildVideoRequest({
      model: GROK,
      prompt: '  A boat at dawn ',
      format: { ...DEFAULT_FORMAT, duration: 1 },
      controls: controls(GROK),
    });
    expect(body).toEqual({
      model: GROK,
      prompt: 'A boat at dawn',
      duration: 1,
      resolution: '480p',
      aspect_ratio: '16:9',
    });
    expect(images).toBe(0);
  });

  it('sends first and last frames as frame_images, never with references', () => {
    const { body, notes, images } = buildVideoRequest({
      model: SEEDANCE,
      prompt: 'Walk',
      format: { ...DEFAULT_FORMAT, duration: 4, audio: 'off', seed: 9 },
      controls: controls(SEEDANCE),
      firstFrame: 'data:image/png;base64,FIRST',
      lastFrame: 'data:image/png;base64,LAST',
      references: ['data:image/png;base64,REF'],
    });
    expect(body.frame_images).toEqual([
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,FIRST' },
        frame_type: 'first_frame',
      },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,LAST' },
        frame_type: 'last_frame',
      },
    ]);
    expect(body.input_references).toBeUndefined();
    expect(body).toMatchObject({ duration: 4, generate_audio: false, seed: 9, resolution: '480p' });
    expect(notes).toContain('Reference images are not sent with frames: frames take precedence.');
    expect(images).toBe(2);
  });

  it('sends references (at most the cap) without frames, and a video link as a video reference', () => {
    const urls = Array.from(
      { length: VIDEO_REFERENCE_MAX + 2 },
      (_, i) => `data:image/png;base64,${i}`,
    );
    const { body, images } = buildVideoRequest({
      model: SEEDANCE,
      prompt: 'Style',
      format: DEFAULT_FORMAT,
      controls: controls(SEEDANCE),
      references: urls,
      videoUrl: 'https://example.com/clip.mp4',
    });
    expect(body.frame_images).toBeUndefined();
    expect(body.input_references).toHaveLength(VIDEO_REFERENCE_MAX + 1);
    expect(body.input_references?.at(-1)).toEqual({
      type: 'video_url',
      video_url: { url: 'https://example.com/clip.mp4' },
    });
    expect(images).toBe(VIDEO_REFERENCE_MAX);
  });

  it('sends only the prompt and images when the model options are unknown', () => {
    const { body } = buildVideoRequest({
      model: GROK,
      prompt: 'Rain',
      format: { ...DEFAULT_FORMAT, seed: 1 },
      controls: null,
      firstFrame: 'data:image/png;base64,F',
    });
    expect(Object.keys(body).sort()).toEqual(['frame_images', 'model', 'prompt']);
  });
});

describe('mode rules', () => {
  it('needs the inputs of each mode', () => {
    const grok = controls(GROK);
    expect(modeProblem('text', grok, { ...inputs, prompt: ' ' })).toBe('Describe the video first.');
    expect(modeProblem('text', grok, inputs)).toBeNull();
    expect(modeProblem('first', grok, inputs)).toBe('Add a first frame.');
    expect(modeProblem('first', grok, { ...inputs, firstFrame: true })).toBeNull();
    expect(modeProblem('references', grok, inputs)).toBe('Add at least one reference image.');
    expect(modeProblem('continue', grok, inputs)).toBe('Choose or upload the clip to continue.');
    expect(modeProblem('continue', grok, { ...inputs, source: true, prompt: '' })).toBeNull();
  });

  it('refuses frames a model cannot take', () => {
    expect(
      modeProblem('first-last', controls(GROK), { ...inputs, firstFrame: true, lastFrame: true }),
    ).toContain('takes a first frame only');
    expect(
      modeProblem('first-last', controls(SEEDANCE), {
        ...inputs,
        firstFrame: true,
        lastFrame: true,
      }),
    ).toBeNull();
    expect(
      modeProblem('continue', controls('openai/sora-2-pro'), { ...inputs, source: true }),
    ).toContain('cannot continue a clip');
  });

  it('extends natively only with a public HTTPS link on a model that takes video, else continues', () => {
    const seedance = controls(SEEDANCE);
    expect(isPublicHttpsUrl('https://example.com/a.mp4')).toBe(true);
    expect(isPublicHttpsUrl('http://example.com/a.mp4')).toBe(false);
    expect(isPublicHttpsUrl('https://localhost/a.mp4')).toBe(false);
    expect(isPublicHttpsUrl('data:video/mp4;base64,AAA')).toBe(false);
    expect(extendPlan(seedance, 'https://example.com/a.mp4')).toBe('native');
    expect(extendPlan(seedance, '')).toBe('continue');
    expect(extendPlan(controls(GROK), 'https://example.com/a.mp4')).toBe('continue');
    // No model is known to accept previous_job_id: a generated clip is continued too.
    expect(extendPlan(controls(GROK), '', { remoteId: 'gen-vid-1', model: GROK })).toBe('continue');
    expect(
      extendPlan({ ...controls(GROK), previousJob: true }, '', {
        remoteId: 'gen-vid-1',
        model: GROK,
      }),
    ).toBe('previous-job');
    // An upload with no link falls back to Continue and needs its clip.
    expect(modeProblem('extend', seedance, { ...inputs, source: false })).toBe(
      'Choose or upload the clip to extend.',
    );
    expect(
      modeProblem('extend', seedance, { ...inputs, extendUrl: 'https://example.com/a.mp4' }),
    ).toBeNull();
    expect(extendNote('continue', controls(GROK), '')).toContain('cannot extend a video natively');
    expect(extendNote('continue', seedance, '')).toContain('continued from its last frame');
  });
});

describe('settings', () => {
  it('round-trips the form exactly', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      tab: 'sequence' as const,
      mode: 'first-last' as const,
      format: {
        duration: 8,
        resolution: '720p',
        aspectRatio: '9:16',
        size: null,
        audio: 'off' as const,
        seed: 42,
      },
      extendUrl: 'https://example.com/a.mp4',
      sequence: {
        mode: 'independent' as const,
        repeat: 2,
        style: 'Film grain',
        capUsd: 1.5,
        onFailure: 'skip' as const,
        steps: [
          { id: 'a', prompt: 'One', imageRole: 'references' as const },
          { id: 'b', prompt: 'Two', imageRole: 'last-frame' as const },
        ],
      },
    };
    const json = settingsJson(settings);
    expect(parseSettings(json)).toEqual(settings);
    expect(settingsJson(parseSettings(json))).toEqual(json);
  });

  it('falls back to defaults for foreign and broken values', () => {
    const parsed = parseSettings({
      tab: 'nope',
      mode: 42,
      format: { duration: 0.5, seed: -1, size: 'big', audio: 'loud' },
      sequence: { steps: [{ id: 'x' }, { id: 'x' }, 'bad'], repeat: 99, capUsd: -2 },
    });
    expect(parsed.tab).toBe('clip');
    expect(parsed.mode).toBe('text');
    expect(parsed.format).toEqual(DEFAULT_FORMAT);
    expect(parsed.sequence.steps).toEqual([{ id: 'x', prompt: '', imageRole: 'references' }]);
    expect(parsed.sequence.repeat).toBe(1);
    expect(parsed.sequence.capUsd).toBeNull();
    expect(parseFormat(undefined)).toEqual(DEFAULT_FORMAT);
  });
});
